import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import { classifyPlaidBudgetImpact, type BudgetImpactValue } from "./budget-impact.js";
import { withWorkspaceLock } from "../locks/workspace.js";

type TransactionDb = Pick<Prisma.TransactionClient, "transaction">;

const REFUND_LOOKBACK_MS = 366 * 86_400_000;

function merchantKey(row: {
  merchantRaw: string;
  merchantNormalized: string | null;
}): string {
  return (row.merchantNormalized?.trim() || normalizeMerchant(row.merchantRaw))
    .replace(/\b(refund|refunded|reversal)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function providerImpact(row: {
  amount: Prisma.Decimal;
  merchantRaw: string;
  rawData: Prisma.JsonValue;
}): BudgetImpactValue {
  const raw = row.rawData as {
    merchant_name?: string | null;
    personal_finance_category?: {
      primary?: string | null;
      detailed?: string | null;
    } | null;
  } | null;
  return classifyPlaidBudgetImpact({
    amount: row.amount.toNumber(),
    name: row.merchantRaw,
    merchant_name: raw?.merchant_name ?? null,
    personal_finance_category: raw?.personal_finance_category ?? null,
  });
}

/** Link only a unique high-confidence refund candidate. Exact remaining
 * amount wins; otherwise a single same-account, same-merchant candidate is
 * enough for a partial refund. Ambiguous refunds remain unlinked. */
export async function matchRefund(
  db: TransactionDb,
  refundId: string,
): Promise<string | null> {
  const refund = await db.transaction.findUnique({
    where: { id: refundId },
    select: {
      id: true,
      workspaceId: true,
      accountId: true,
      amount: true,
      merchantRaw: true,
      merchantNormalized: true,
      occurredAt: true,
      budgetImpact: true,
      removedAt: true,
    },
  });
  if (
    !refund
    || refund.removedAt
    || refund.budgetImpact !== "refund"
    || !refund.amount.isNegative()
  ) {
    return null;
  }

  const candidates = await db.transaction.findMany({
    where: {
      workspaceId: refund.workspaceId,
      accountId: refund.accountId,
      budgetImpact: "expense",
      amount: { gt: 0 },
      pending: false,
      removedAt: null,
      occurredAt: {
        gte: new Date(refund.occurredAt.getTime() - REFUND_LOOKBACK_MS),
        lte: refund.occurredAt,
      },
    },
    select: {
      id: true,
      amount: true,
      merchantRaw: true,
      merchantNormalized: true,
      refunds: {
        where: { budgetImpact: "refund", removedAt: null, id: { not: refund.id } },
        select: { amount: true },
      },
    },
  });

  const key = merchantKey(refund);
  const amount = refund.amount.abs().toNumber();
  const eligible = candidates.flatMap((candidate) => {
    if (merchantKey(candidate) !== key) return [];
    const alreadyRefunded = candidate.refunds.reduce(
      (sum, item) => sum + item.amount.abs().toNumber(),
      0,
    );
    const remaining = Math.max(0, candidate.amount.toNumber() - alreadyRefunded);
    return remaining + 0.005 >= amount ? [{ id: candidate.id, remaining }] : [];
  });
  const exact = eligible.filter((candidate) => Math.abs(candidate.remaining - amount) < 0.005);
  const matched = exact.length === 1
    ? exact[0]!.id
    : eligible.length === 1
      ? eligible[0]!.id
      : null;

  await db.transaction.update({
    where: { id: refund.id },
    data: { refundOfTransactionId: matched },
  });
  return matched;
}

/** Recompute an automatic transaction's direction after categorization and
 * keep the refund link in sync. Explicit include/exclude overrides win. */
export async function syncTransactionImpact(
  db: TransactionDb,
  transactionId: string,
): Promise<BudgetImpactValue | null> {
  const row = await db.transaction.findUnique({
    where: { id: transactionId },
    select: {
      id: true,
      amount: true,
      merchantRaw: true,
      rawData: true,
      budgetImpact: true,
      budgetImpactSource: true,
      allocations: {
        select: { category: { select: { name: true, type: true } } },
      },
    },
  });
  if (!row) return null;

  let impact: BudgetImpactValue = row.budgetImpact;
  if (row.budgetImpactSource === "auto") {
    const isRefundCategory = row.amount.isNegative() && row.allocations.some(
      (allocation) => allocation.category?.type === "income"
        && allocation.category.name.trim().toLowerCase() === "refund",
    );
    impact = isRefundCategory ? "refund" : providerImpact(row);
    if (impact !== row.budgetImpact) {
      await db.transaction.update({
        where: { id: row.id },
        data: { budgetImpact: impact },
      });
    }
  }

  if (impact === "refund") await matchRefund(db, row.id);
  else if (row.budgetImpact === "refund") {
    await db.transaction.update({
      where: { id: row.id },
      data: { refundOfTransactionId: null },
    });
  }
  return impact;
}

/** Lazy one-time backfill for existing refund categories and unlinked refund
 * rows. Once linked, later aggregate reads only pay for the small indexed
 * unlinked-refund lookup. */
export async function ensureRefundLinks(workspaceId: string): Promise<void> {
  const needsSync = await prisma.transaction.findFirst({
    where: {
      workspaceId,
      removedAt: null,
      OR: [
        {
          amount: { lt: 0 },
          budgetImpactSource: "auto",
          budgetImpact: "income",
          allocations: {
            some: { category: { is: { type: "income", name: { equals: "Refund", mode: "insensitive" } } } },
          },
        },
        { budgetImpact: "refund", refundOfTransactionId: null },
      ],
    },
    select: { id: true },
  });
  if (!needsSync) return;

  await withWorkspaceLock(workspaceId, async (tx) => {
    const categorized = await tx.transaction.findMany({
      where: {
        workspaceId,
        amount: { lt: 0 },
        removedAt: null,
        budgetImpactSource: "auto",
        budgetImpact: "income",
        allocations: {
          some: { category: { is: { type: "income", name: { equals: "Refund", mode: "insensitive" } } } },
        },
      },
      select: { id: true },
    });
    for (const row of categorized) await syncTransactionImpact(tx, row.id);

    const unlinked = await tx.transaction.findMany({
      where: {
        workspaceId,
        budgetImpact: "refund",
        refundOfTransactionId: null,
        removedAt: null,
      },
      select: { id: true },
    });
    for (const row of unlinked) await matchRefund(tx, row.id);
  });
}
