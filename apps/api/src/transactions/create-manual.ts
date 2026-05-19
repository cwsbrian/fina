import { Prisma } from "@prisma/client";
import { normalizeMerchant } from "../categorize/normalize.js";
import { dateKeyInTz, resolveUserTz } from "../chat/tools/periods.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import {
  TxValidationError,
  validateAmount as validateAmountShared,
  validateMerchantRaw as validateMerchantRawShared,
  validateNote as validateNoteShared,
  parseOccurredAt as parseOccurredAtShared,
} from "./validators.js";
import { applyAllocations } from "./allocations.js";

export type CreateManualTxInput = {
  merchantRaw: string;
  amount: number;
  occurredAt?: string;
  categoryId?: string;
  note?: string;
  accountId?: string;
};

export type CreateManualTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;             // mirror-write; dropped in Task 8
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    needsReclassification: false;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
  };
};

type ErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_note"
  | "invalid_merchant"
  | "category_not_found"
  | "account_not_found";

export class CreateManualTxError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

// Map TxValidationError → CreateManualTxError. The error codes overlap 1:1.
function rethrow<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new CreateManualTxError(e.code);
    throw e;
  }
}

function validateMerchantRaw(raw: string): string {
  return rethrow(() => validateMerchantRawShared(raw));
}
function validateAmount(amount: number): void {
  rethrow(() => validateAmountShared(amount));
}
function validateNote(note: string | undefined): string | null {
  return rethrow(() => validateNoteShared(note));
}
function parseOccurredAt(s: string): Date {
  return rethrow(() => parseOccurredAtShared(s));
}

export async function createManualTransactionService(
  ctx: { workspaceId: string; userId: string },
  input: CreateManualTxInput,
): Promise<CreateManualTxResult> {
  const merchantRaw = validateMerchantRaw(input.merchantRaw);
  validateAmount(input.amount);
  const note = validateNote(input.note);

  let occurredAt: Date;
  if (input.occurredAt === undefined) {
    const tz = await resolveUserTz(ctx.userId);
    const todayKey = dateKeyInTz(new Date(), tz);
    occurredAt = parseOccurredAt(todayKey);
  } else {
    occurredAt = parseOccurredAt(input.occurredAt);
  }

  const merchantNormalized = normalizeMerchant(merchantRaw);

  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {

    if (input.categoryId !== undefined) {
      const cat = await tx.category.findFirst({
        where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new CreateManualTxError("category_not_found");
    }

    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });

    const MANUAL_WHERE = {
      plaidItemId: null,
      plaidAccountId: null,
      archivedAt: null,
    } as const;

    let account: { id: string };
    if (input.accountId !== undefined) {
      const found = await tx.bankAccount.findFirst({
        where: { id: input.accountId, workspaceId: ctx.workspaceId, ...MANUAL_WHERE },
        select: { id: true },
      });
      if (!found) throw new CreateManualTxError("account_not_found");
      account = found;
    } else {
      const existing = await tx.bankAccount.findFirst({
        where: { workspaceId: ctx.workspaceId, ...MANUAL_WHERE },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (existing) {
        account = existing;
      } else {
        account = await tx.bankAccount.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: "Cash",
            type: "depository",
            currency: workspace.currency,
            status: "active",
          },
          select: { id: true },
        });
      }
    }

    const row = await tx.transaction.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        plaidItemId: null,
        plaidTransactionId: null,
        amount: new Prisma.Decimal(input.amount),
        merchantRaw,
        merchantNormalized,
        categoryId: input.categoryId ?? null,
        occurredAt,
        postedAt: null,
        pending: false,
        source: "manual",
        rawData: {} as Prisma.InputJsonValue,
        note,
        categorizationSource: input.categoryId !== undefined ? "manual" : null,
      },
    });

    const allocSource: "manual" | null = input.categoryId !== undefined ? "manual" : null;
    await applyAllocations(
      tx,
      ctx.workspaceId,
      row.id,
      row.amount,
      allocSource,
      [{ categoryId: input.categoryId ?? null, amount: input.amount }],
    );

    const allocs = await tx.transactionAllocation.findMany({
      where: { transactionId: row.id },
      select: { id: true, categoryId: true, amount: true, source: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      transaction: {
        id: row.id,
        accountId: row.accountId,
        plaidTransactionId: null,           // invariant: manual tx
        amount: row.amount.toString(),
        currency: workspace.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        categoryId: row.categoryId,
        occurredAt: row.occurredAt.toISOString(),
        pending: false,                     // invariant: manual tx
        source: "manual",
        note: row.note,
        removedAt: null,                    // invariant: freshly created
        needsReclassification: false,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        allocations: allocs.map((a) => ({
          id: a.id,
          categoryId: a.categoryId,
          amount: a.amount.toString(),
          source: a.source,
        })),
      },
    };
  });
}
