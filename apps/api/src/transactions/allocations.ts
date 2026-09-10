import { Prisma, CategorizationSource } from "@prisma/client";
import { MAX_AMOUNT, AMOUNT_RE } from "@fina/shared";

export type AllocationInput = {
  categoryId: string | null;
  amount: number;
  businessAmount?: number | null;
  receiptLineItemId?: string | null;
};

export type AllocationErrorCode =
  | "empty_allocations"
  | "sum_mismatch"
  | "invalid_allocation_amount"
  | "invalid_business_amount"
  | "category_not_found";

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  constructor(code: AllocationErrorCode) {
    super(code);
    this.name = "AllocationError";
    this.code = code;
  }
}

// Same Decimal(14, 2) rule as create-manual.ts, but signed: allocations
// inherit the tx's sign (positive = expense per Plaid convention, negative
// = income/refund), so the bound is on |amount|. Rejects zero, NaN, > MAX,
// and >2 decimals via the positive-only regex applied to abs().
function validateOneAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount === 0) {
    throw new AllocationError("invalid_allocation_amount");
  }
  const abs = Math.abs(amount);
  if (abs > MAX_AMOUNT) {
    throw new AllocationError("invalid_allocation_amount");
  }
  if (!AMOUNT_RE.test(String(abs))) {
    throw new AllocationError("invalid_allocation_amount");
  }
}

export type AllocationSource = CategorizationSource | null;

/**
 * Replace all allocations for a transaction atomically. MUST be called inside
 * a withWorkspaceLock callback. Validates amounts, sum, and category existence.
 * Sets transaction.needsReclassification = false on success.
 *
 * Invariant guaranteed on return: txId has exactly `allocations.length` rows
 * in transaction_allocations, sum(amount) === txAmount, each non-null
 * categoryId is a non-archived category in the workspace.
 */
export async function applyAllocations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  txId: string,
  txAmount: Prisma.Decimal,
  source: AllocationSource,
  allocations: AllocationInput[],
): Promise<void> {
  if (allocations.length === 0) {
    throw new AllocationError("empty_allocations");
  }

  // Validate each amount first. Allocations must share the tx's sign —
  // an expense (positive tx) splits into positive parts; an income
  // (negative tx) splits into negative parts. Mixed signs are rejected
  // even when the sum happens to match the tx amount.
  const txIsNegative = txAmount.isNegative();
  for (const a of allocations) {
    validateOneAmount(a.amount);
    const allocIsNegative = a.amount < 0;
    if (allocIsNegative !== txIsNegative) {
      throw new AllocationError("invalid_allocation_amount");
    }
    if (a.businessAmount !== undefined && a.businessAmount !== null) {
      if (
        !Number.isFinite(a.businessAmount) ||
        a.businessAmount < 0 ||
        a.businessAmount > Math.abs(a.amount) ||
        !AMOUNT_RE.test(String(a.businessAmount))
      ) {
        throw new AllocationError("invalid_business_amount");
      }
    }
  }

  // Strict Decimal sum equality.
  const sum = allocations.reduce(
    (acc, a) => acc.plus(new Prisma.Decimal(a.amount)),
    new Prisma.Decimal(0),
  );
  if (!sum.equals(txAmount)) {
    throw new AllocationError("sum_mismatch");
  }

  // Validate each non-null categoryId is in workspace + not archived.
  const uniqueCatIds = Array.from(
    new Set(allocations.map((a) => a.categoryId).filter((c): c is string => c !== null)),
  );
  if (uniqueCatIds.length > 0) {
    const found = await tx.category.findMany({
      where: { id: { in: uniqueCatIds }, workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (found.length !== uniqueCatIds.length) {
      throw new AllocationError("category_not_found");
    }
  }

  const transaction = await tx.transaction.findFirstOrThrow({
    where: { id: txId, workspaceId },
    select: {
      budgetImpact: true,
      workspace: { select: { kind: true } },
      allocations: { select: { amount: true, businessAmount: true, receiptLineItemId: true } },
    },
  });
  const preserved = [...transaction.allocations];

  // Replace allocations atomically. deleteMany + createMany inside the
  // caller-provided `tx` (which is already inside a Prisma $transaction
  // started by withWorkspaceLock).
  await tx.transactionAllocation.deleteMany({ where: { transactionId: txId } });
  await tx.transactionAllocation.createMany({
    data: allocations.map((a) => ({
      ...(() => {
        if (a.businessAmount !== undefined || a.receiptLineItemId !== undefined) {
          return {
            businessAmount: a.businessAmount === null || a.businessAmount === undefined
              ? null : new Prisma.Decimal(a.businessAmount),
            receiptLineItemId: a.receiptLineItemId ?? null,
          };
        }
        const matchIndex = preserved.findIndex((old) => old.amount.equals(a.amount));
        const match = matchIndex >= 0 ? preserved.splice(matchIndex, 1)[0] : undefined;
        if (match) {
          return { businessAmount: match.businessAmount, receiptLineItemId: match.receiptLineItemId };
        }
        if (transaction.workspace.kind !== "business") return { businessAmount: null };
        if (transaction.budgetImpact === "income") {
          return { businessAmount: new Prisma.Decimal(Math.abs(a.amount)) };
        }
        if (transaction.budgetImpact === "excluded") return { businessAmount: new Prisma.Decimal(0) };
        return { businessAmount: null };
      })(),
      transactionId: txId,
      categoryId: a.categoryId,
      amount: new Prisma.Decimal(a.amount),
      source,
    })),
  });

  // Clear the needsReclassification flag — user has now categorized.
  await tx.transaction.update({
    where: { id: txId },
    data: { needsReclassification: false, version: { increment: 1 } },
  });
}
