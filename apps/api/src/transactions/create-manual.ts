import { Prisma } from "@prisma/client";
import { MAX_AMOUNT, AMOUNT_RE } from "@fina/shared";
import { normalizeMerchant } from "../categorize/normalize.js";
import { dateKeyInTz, resolveUserTz } from "../chat/tools/periods.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import {
  TxValidationError,
  validateMerchantRaw as validateMerchantRawShared,
  validateNote as validateNoteShared,
  parseOccurredAt as parseOccurredAtShared,
} from "./validators.js";
import { applyAllocations } from "./allocations.js";
import { applyMerchantExclusion, budgetImpactForAmount } from "./budget-impact.js";
import { syncTransactionImpact } from "./refunds.js";

export type CreateManualTxInput = {
  merchantRaw: string;
  amount: number;
  currency?: string;
  /** Internal-only: atomically relabel the workspace before creating this row. */
  changeWorkspaceCurrency?: boolean;
  occurredAt?: string;
  categoryId?: string;
  note?: string;
  accountId?: string;
};

export type CreateManualTxResult = {
  transaction: {
    id: string;
    version: number;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    occurredAt: string;
    postedAt: null;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    needsReclassification: false;
    budgetImpact: "expense" | "income" | "refund" | "excluded";
    budgetImpactSource: "auto" | "user";
    merchantExclusionActive: boolean;
    refundOfTransactionId: string | null;
    classificationSourceReceiptId: string | null;
    businessPurpose: string | null;
    receiptMissingReason: string | null;
    receiptMissingNote: string | null;
    refundedAmount: string;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | "history" | null;
      needsConfirmation: boolean;
      dismissedUntil: string | null;
      businessAmount: string | null;
      receiptLineItemId: string | null;
    }>;
  };
};

type ErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_note"
  | "invalid_merchant"
  | "invalid_currency"
  | "category_not_found"
  | "account_not_found"
  | "currency_mismatch";

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
// Manual transactions can be either spend (positive) or income (negative),
// mirroring Plaid's signed amount convention. The shared validator is
// positive-only, so we apply an absolute check here.
function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > MAX_AMOUNT) {
    throw new CreateManualTxError("invalid_amount");
  }
  if (!AMOUNT_RE.test(String(Math.abs(amount)))) {
    throw new CreateManualTxError("invalid_amount");
  }
}
function validateCurrency(currency: string | undefined): string | undefined {
  if (currency === undefined) return undefined;
  const normalized = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new CreateManualTxError("invalid_currency");
  }
  return normalized;
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
  const requestedCurrency = validateCurrency(input.currency);
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
    const budgetImpact = await applyMerchantExclusion(
      tx,
      ctx.workspaceId,
      merchantNormalized,
      budgetImpactForAmount(input.amount),
    );
    if (input.categoryId !== undefined) {
      const cat = await tx.category.findFirst({
        where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new CreateManualTxError("category_not_found");
    }

    let workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });
    if (requestedCurrency && requestedCurrency !== workspace.currency) {
      if (input.changeWorkspaceCurrency !== true) {
        throw new CreateManualTxError("currency_mismatch");
      }
      workspace = await tx.workspace.update({
        where: { id: ctx.workspaceId },
        data: { currency: requestedCurrency },
        select: { currency: true },
      });
      await tx.bankAccount.updateMany({
        where: { workspaceId: ctx.workspaceId },
        data: { currency: requestedCurrency },
      });
    }

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
        occurredAt,
        postedAt: null,
        pending: false,
        source: "manual",
        rawData: {} as Prisma.InputJsonValue,
        note,
        ...budgetImpact,
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
    await syncTransactionImpact(tx, row.id);

    const impact = await tx.transaction.findUniqueOrThrow({
      where: { id: row.id },
      select: {
        budgetImpact: true,
        budgetImpactSource: true,
        refundOfTransactionId: true,
        version: true,
        classificationSourceReceiptId: true,
        businessPurpose: true,
        receiptMissingReason: true,
        receiptMissingNote: true,
      },
    });

    const allocs = await tx.transactionAllocation.findMany({
      where: { transactionId: row.id },
      select: { id: true, categoryId: true, amount: true, source: true, needsConfirmation: true, dismissedUntil: true, businessAmount: true, receiptLineItemId: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      transaction: {
        id: row.id,
        version: impact.version,
        accountId: row.accountId,
        plaidTransactionId: null,           // invariant: manual tx
        amount: row.amount.toString(),
        currency: workspace.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        occurredAt: row.occurredAt.toISOString(),
        postedAt: null,
        pending: false,                     // invariant: manual tx
        source: "manual",
        note: row.note,
        removedAt: null,                    // invariant: freshly created
        needsReclassification: false,
        budgetImpact: impact.budgetImpact,
        budgetImpactSource: impact.budgetImpactSource,
        merchantExclusionActive:
          impact.budgetImpact === "excluded" && impact.budgetImpactSource === "user",
        refundOfTransactionId: impact.refundOfTransactionId,
        classificationSourceReceiptId: impact.classificationSourceReceiptId,
        businessPurpose: impact.businessPurpose,
        receiptMissingReason: impact.receiptMissingReason,
        receiptMissingNote: impact.receiptMissingNote,
        refundedAmount: "0.00",
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        allocations: allocs.map((a) => ({
          id: a.id,
          categoryId: a.categoryId,
          amount: a.amount.toString(),
          source: a.source,
          needsConfirmation: a.needsConfirmation,
          dismissedUntil: a.dismissedUntil?.toISOString() ?? null,
          businessAmount: a.businessAmount?.toFixed(2) ?? null,
          receiptLineItemId: a.receiptLineItemId,
        })),
      },
    };
  });
}
