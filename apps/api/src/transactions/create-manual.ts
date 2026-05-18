import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import { dateKeyInTz, resolveUserTz } from "../chat/tools/periods.js";

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
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;
    note: string | null;
    source: "manual";
    accountId: string;
    createdAt: string;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 999_999_999.99;

function validateMerchantRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new CreateManualTxError("invalid_merchant");
  }
  return trimmed;
}

function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new CreateManualTxError("invalid_amount");
  }
  // Transaction.amount is Decimal(14, 2). Reject inputs with more than two
  // decimal places (e.g. 0.004) — they would silently round to 0.00 and
  // create a row that violates the positive-amount contract.
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    throw new CreateManualTxError("invalid_amount");
  }
}

function validateNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  if (note.length > 1000) throw new CreateManualTxError("invalid_note");
  return note;
}

function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new CreateManualTxError("invalid_date");
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new CreateManualTxError("invalid_date");
  }
  return d;
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

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.workspaceId}))`;

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
        currency: workspace.currency,
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

    return {
      transaction: {
        id: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        categoryId: row.categoryId,
        occurredAt: row.occurredAt.toISOString(),
        note: row.note,
        source: "manual",
        accountId: row.accountId,
        createdAt: row.createdAt.toISOString(),
      },
    };
  });
}
