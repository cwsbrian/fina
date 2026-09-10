import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import {
  TxValidationError,
  validateAmount,
  validateMerchantRaw,
  validateNote,
  parseOccurredAt,
} from "./validators.js";
import { applyAllocations, AllocationError } from "./allocations.js";
import { maybeAutoPromote } from "../categorize/auto-promote.js";
import { syncTransactionImpact } from "./refunds.js";

export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  note?: string | null;
  // NEW: single-category shortcut (mutually exclusive with allocations).
  categoryId?: string | null;
  // NEW: full allocations replacement.
  allocations?: Array<{ categoryId: string | null; amount: number }>;
  // NEW: reassign the tx to a different (manual) account.
  accountId?: string;
  budgetImpact?: "expense" | "income" | "refund" | "excluded";
  budgetImpactScope?: "transaction" | "merchant";
};

// Type signal that the caller used the categoryId field (the route layer
// must set this when present so the service can validate exclusivity).
export type EditTxInputFlags = {
  categoryIdProvided?: boolean;
  allocationsProvided?: boolean;
  manualOnlyFieldProvided?: boolean;
};

export type EditTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: string | null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    occurredAt: string;
    pending: boolean;
    source: "manual" | "plaid" | "csv";    // widen from "manual" — Plaid posted can PATCH allocations
    note: string | null;
    removedAt: null;
    needsReclassification: boolean;
    budgetImpact: "expense" | "income" | "refund" | "excluded";
    budgetImpactSource: "auto" | "user";
    merchantExclusionActive: boolean;
    refundOfTransactionId: string | null;
    refundedAmount: string;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
  };
  affectedTransactionIds: string[];
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "cannot_split_pending"
  | "category_not_found"
  | "account_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note"
  | "invalid_allocation_amount"
  | "sum_mismatch"
  | "empty_allocations"
  | "conflicting_body";

export class EditTxError extends Error {
  readonly code: EditTxErrorCode;
  constructor(code: EditTxErrorCode) {
    super(code);
    this.name = "EditTxError";
    this.code = code;
  }
}

function rethrowValidation<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new EditTxError(e.code);
    throw e;
  }
}

const TX_SELECT = {
  id: true, accountId: true, plaidTransactionId: true,
  amount: true, merchantRaw: true, merchantNormalized: true,
  occurredAt: true, pending: true,
  source: true, note: true, removedAt: true,
  needsReclassification: true,
  budgetImpact: true,
  budgetImpactSource: true,
  refundOfTransactionId: true,
  refunds: {
    where: { budgetImpact: "refund", removedAt: null, pending: false },
    select: { amount: true },
  },
  createdAt: true, updatedAt: true,
  allocations: {
    select: { id: true, categoryId: true, amount: true, source: true },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

function shape(
  row: Prisma.TransactionGetPayload<{ select: typeof TX_SELECT }>,
  currency: string,
  merchantExclusionActive: boolean,
): EditTxResult["transaction"] {
  return {
    id: row.id,
    accountId: row.accountId,
    plaidTransactionId: row.plaidTransactionId,
    amount: row.amount.toString(),
    currency,
    merchantRaw: row.merchantRaw,
    merchantNormalized: row.merchantNormalized ?? normalizeMerchant(row.merchantRaw),
    occurredAt: row.occurredAt.toISOString(),
    pending: row.pending,
    source: row.source as "manual" | "plaid" | "csv",
    note: row.note,
    removedAt: null,
    needsReclassification: row.needsReclassification,
    budgetImpact: row.budgetImpact,
    budgetImpactSource: row.budgetImpactSource,
    merchantExclusionActive,
    refundOfTransactionId: row.refundOfTransactionId,
    refundedAmount: row.refunds
      .reduce((sum, refund) => sum + Math.abs(refund.amount.toNumber()), 0)
      .toFixed(2),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allocations: row.allocations.map((a) => ({
      id: a.id,
      categoryId: a.categoryId,
      amount: a.amount.toString(),
      source: a.source as "manual" | "mapping" | "ai" | null,
    })),
  };
}

export async function editTransactionService(
  ctx: { workspaceId: string },
  txId: string,
  input: EditTxInput,
  flags: EditTxInputFlags,
): Promise<EditTxResult> {
  // 1. Conflicting body check.
  if (flags.categoryIdProvided && flags.allocationsProvided) {
    throw new EditTxError("conflicting_body");
  }

  // 2. Validate input fields up-front (purely input-shape checks). Mapping
  //    TxValidationError → EditTxError preserves the 1:1 code names.
  if (input.amount !== undefined) rethrowValidation(() => validateAmount(input.amount as number));
  let trimmedMerchant: string | undefined;
  if (input.merchantRaw !== undefined) trimmedMerchant = rethrowValidation(() => validateMerchantRaw(input.merchantRaw as string));
  let parsedOccurredAt: Date | undefined;
  if (input.occurredAt !== undefined) parsedOccurredAt = rethrowValidation(() => parseOccurredAt(input.occurredAt as string));
  let normalizedNote: string | null = null;
  let noteProvided = false;
  if (input.note !== undefined) {
    noteProvided = true;
    normalizedNote = rethrowValidation(() => validateNote(input.note));
  }

  // 3. Workspace read outside lock.
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  });

  const result = await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    // 4a. Read tx.
    const row = await tx.transaction.findFirst({
      where: { id: txId, workspaceId: ctx.workspaceId },
      select: TX_SELECT,
    });
    if (!row) throw new EditTxError("not_found");

    // 4b. Per-field source check — uses key presence semantics (set by caller).
    if (flags.manualOnlyFieldProvided && row.source !== "manual") {
      throw new EditTxError("not_editable");
    }

    if (row.removedAt !== null) throw new EditTxError("already_removed");

    // 4c. cannot_split_pending gate. Full split replacement stays blocked
    // for pending Plaid rows, but the single-category shortcut is safe:
    // it preserves the transaction amount and only replaces the one visible
    // allocation category.
    if (flags.allocationsProvided && row.pending === true && row.plaidTransactionId !== null) {
      throw new EditTxError("cannot_split_pending");
    }

    // 4d. Validate categoryId when using the shortcut path (not allocations path).
    if (flags.categoryIdProvided && !flags.allocationsProvided) {
      if (input.categoryId !== undefined && input.categoryId !== null) {
        const cat = await tx.category.findFirst({
          where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
          select: { id: true },
        });
        if (!cat) throw new EditTxError("category_not_found");
      }
    }

    // Use TransactionUncheckedUpdateInput (NOT TransactionUpdateInput):
    // the latter exposes the `category` relation but not the scalar `categoryId`
    // FK column, so `data.categoryId = ...` would fail typecheck.
    const data: Prisma.TransactionUncheckedUpdateInput = {};
    if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount);
    if (trimmedMerchant !== undefined) {
      data.merchantRaw = trimmedMerchant;
      data.merchantNormalized = normalizeMerchant(trimmedMerchant);
    } else if (flags.categoryIdProvided && row.merchantNormalized === null) {
      data.merchantNormalized = normalizeMerchant(row.merchantRaw);
    }
    if (parsedOccurredAt !== undefined) data.occurredAt = parsedOccurredAt;
    if (noteProvided) data.note = normalizedNote;
    if (input.budgetImpact !== undefined) {
      data.budgetImpact = input.budgetImpact;
      data.budgetImpactSource = "user";
    }
    if (input.accountId !== undefined) {
      // Only manual accounts in this workspace are valid reassign targets —
      // mirrors create-manual's MANUAL_WHERE rule.
      const account = await tx.bankAccount.findFirst({
        where: {
          id: input.accountId,
          workspaceId: ctx.workspaceId,
          plaidItemId: null,
          plaidAccountId: null,
          archivedAt: null,
        },
        select: { id: true },
      });
      if (!account) throw new EditTxError("account_not_found");
      data.accountId = account.id;
    }

    // Determine effectiveAmount for allocations (new amount if changed, else row amount).
    const effectiveAmount = data.amount instanceof Prisma.Decimal ? data.amount : row.amount;

    // 4e. Apply allocations.
    if (flags.allocationsProvided) {
      try {
        await applyAllocations(
          tx, ctx.workspaceId, txId, effectiveAmount, "manual",
          input.allocations!,
        );
      } catch (e) {
        if (e instanceof AllocationError) {
          throw new EditTxError(e.code as EditTxErrorCode);
        }
        throw e;
      }
    } else if (flags.categoryIdProvided) {
      // When clearing to null, use null source (no categorization); otherwise "manual".
      const catSource = input.categoryId === null ? null : "manual";
      try {
        await applyAllocations(
          tx, ctx.workspaceId, txId, effectiveAmount, catSource,
          [{ categoryId: input.categoryId ?? null, amount: Number(effectiveAmount.toString()) }],
        );
      } catch (e) {
        if (e instanceof AllocationError) throw new EditTxError(e.code as EditTxErrorCode);
        throw e;
      }
    }

    if (Object.keys(data).length > 0) {
      if (!flags.allocationsProvided && !flags.categoryIdProvided) data.version = { increment: 1 };
      await tx.transaction.update({
        where: { id: txId },
        data,
        select: { id: true },
      });
    }

    const affectedTransactionIds = [txId];
    const merchantNormalized =
      (typeof data.merchantNormalized === "string"
        ? data.merchantNormalized
        : row.merchantNormalized ?? normalizeMerchant(row.merchantRaw)
      ).trim();

    if (input.budgetImpactScope !== undefined && input.budgetImpact !== undefined) {
      if (input.budgetImpactScope === "merchant" && input.budgetImpact === "excluded") {
        await tx.merchantExclusion.upsert({
          where: {
            workspaceId_merchantNormalized: {
              workspaceId: ctx.workspaceId,
              merchantNormalized,
            },
          },
          create: { workspaceId: ctx.workspaceId, merchantNormalized },
          update: {},
        });
      } else if (
        input.budgetImpactScope === "merchant"
        || input.budgetImpact === "excluded"
      ) {
        await tx.merchantExclusion.deleteMany({
          where: { workspaceId: ctx.workspaceId, merchantNormalized },
        });
      }
    }

    if (flags.categoryIdProvided && input.categoryId && merchantNormalized.length > 0) {
      await tx.merchantMapping.upsert({
        where: {
          workspaceId_merchantNormalized: {
            workspaceId: ctx.workspaceId,
            merchantNormalized,
          },
        },
        create: {
          workspaceId: ctx.workspaceId,
          merchantNormalized,
          categoryId: input.categoryId,
          source: "manual",
          confidence: 1.0,
        },
        update: {
          categoryId: input.categoryId,
          source: "manual",
          confidence: 1.0,
        },
      });

      const reviewSiblings = await tx.transaction.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          id: { not: txId },
          merchantNormalized,
          removedAt: null,
          allocations: {
            some: {
              needsConfirmation: true,
              categoryId: { not: null },
              OR: [
                { dismissedUntil: null },
                { dismissedUntil: { lt: new Date() } },
              ],
            },
          },
        },
        select: {
          id: true,
          allocations: { select: { id: true }, orderBy: { createdAt: "asc" } },
        },
      });

      for (const sibling of reviewSiblings) {
        if (sibling.allocations.length !== 1) continue;
        const alloc = sibling.allocations[0]!;
        const updated = await tx.transactionAllocation.updateMany({
          where: { id: alloc.id },
          data: {
            categoryId: input.categoryId,
            source: "manual",
            needsConfirmation: false,
            dismissedUntil: null,
          },
        });
        if (updated.count > 0) {
          affectedTransactionIds.push(sibling.id);
          await syncTransactionImpact(tx, sibling.id);
        }
      }
    }

    await syncTransactionImpact(tx, txId);

    // 5. Read back with allocations for response.
    const finalRow = await tx.transaction.findUniqueOrThrow({
      where: { id: txId },
      select: TX_SELECT,
    });
    const finalMerchant = finalRow.merchantNormalized ?? normalizeMerchant(finalRow.merchantRaw);
    const merchantExclusionActive = await tx.merchantExclusion.findUnique({
      where: {
        workspaceId_merchantNormalized: {
          workspaceId: ctx.workspaceId,
          merchantNormalized: finalMerchant,
        },
      },
      select: { id: true },
    });
    return {
      transaction: shape(finalRow, workspace.currency, merchantExclusionActive !== null),
      affectedTransactionIds,
    };
  });

  // Per-allocation auto-promote trigger (best-effort, post-commit).
  // Reuses the already-fetched post-update tx so we don't re-query.
  if (result.transaction.merchantNormalized) {
    for (const a of result.transaction.allocations) {
      if (a.categoryId) {
        await maybeAutoPromote(
          ctx.workspaceId,
          result.transaction.merchantNormalized,
          a.categoryId,
        );
      }
    }
  }

  return result;
}
