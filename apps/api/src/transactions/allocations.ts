import { Prisma, CategorizationSource } from "@prisma/client";

export type AllocationInput = { categoryId: string | null; amount: number };

export type AllocationErrorCode =
  | "empty_allocations"
  | "sum_mismatch"
  | "invalid_allocation_amount"
  | "category_not_found";

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  constructor(code: AllocationErrorCode) {
    super(code);
    this.name = "AllocationError";
    this.code = code;
  }
}

// Same Decimal(14, 2) rule as create-manual.ts: positive, ≤ MAX, ≤2 decimals,
// rejects scientific notation via string regex.
const MAX_AMOUNT = 999_999_999.99;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

function validateOneAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new AllocationError("invalid_allocation_amount");
  }
  if (!AMOUNT_RE.test(String(amount))) {
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

  // Validate each amount first.
  for (const a of allocations) {
    validateOneAmount(a.amount);
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

  // Replace allocations atomically. deleteMany + createMany inside the
  // caller-provided `tx` (which is already inside a Prisma $transaction
  // started by withWorkspaceLock).
  await tx.transactionAllocation.deleteMany({ where: { transactionId: txId } });
  await tx.transactionAllocation.createMany({
    data: allocations.map((a) => ({
      transactionId: txId,
      categoryId: a.categoryId,
      amount: new Prisma.Decimal(a.amount),
      source,
    })),
  });

  // Clear the needsReclassification flag — user has now categorized.
  await tx.transaction.update({
    where: { id: txId },
    data: { needsReclassification: false },
  });
}
