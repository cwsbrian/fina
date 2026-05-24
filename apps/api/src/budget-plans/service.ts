import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/** Sentinel date that marks the user's "default" template plan. Real
 *  monthly snapshots use the first-of-month for the period. */
export const DEFAULT_PERIOD = new Date("1900-01-01T12:00:00.000Z");

export type CategoryAllocation = { categoryId: string; amount: number };

export type BudgetPlanRecord = {
  id: string;
  workspaceId: string;
  /** YYYY-MM-DD; "1900-01-01" iff this is the default template. */
  periodStart: string;
  totalAmount: string;
  categoryAllocations: CategoryAllocation[];
  createdAt: string;
  updatedAt: string;
};

function row(r: {
  id: string;
  workspaceId: string;
  periodStart: Date;
  totalAmount: Prisma.Decimal;
  categoryAllocations: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): BudgetPlanRecord {
  const allocs = Array.isArray(r.categoryAllocations)
    ? (r.categoryAllocations as unknown as CategoryAllocation[])
    : [];
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    periodStart: r.periodStart.toISOString().slice(0, 10),
    totalAmount: r.totalAmount.toFixed(2),
    categoryAllocations: allocs,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function firstOfMonth(year: number, month1to12: number): Date {
  // UTC noon, same convention as transactions.parseOccurredAt.
  return new Date(
    `${year}-${String(month1to12).padStart(2, "0")}-01T12:00:00.000Z`,
  );
}

export function isDefaultPeriod(d: Date): boolean {
  return d.toISOString().slice(0, 10) === "1900-01-01";
}

export type SetBudgetInput = {
  totalAmount: number;
  categoryAllocations?: CategoryAllocation[];
};

export async function getDefaultBudget(
  workspaceId: string,
): Promise<BudgetPlanRecord | null> {
  const r = await prisma.budgetPlan.findUnique({
    where: {
      workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
    },
  });
  return r ? row(r) : null;
}

export async function setDefaultBudget(
  workspaceId: string,
  input: SetBudgetInput,
): Promise<BudgetPlanRecord> {
  const updated = await prisma.budgetPlan.upsert({
    where: {
      workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
    },
    create: {
      workspaceId,
      periodStart: DEFAULT_PERIOD,
      totalAmount: new Prisma.Decimal(input.totalAmount),
      categoryAllocations:
        (input.categoryAllocations ?? []) as unknown as Prisma.InputJsonValue,
    },
    update: {
      totalAmount: new Prisma.Decimal(input.totalAmount),
      categoryAllocations:
        (input.categoryAllocations ?? []) as unknown as Prisma.InputJsonValue,
    },
  });
  return row(updated);
}

/** Get the budget plan for a specific year+month. If no row exists yet,
 *  snapshot from the default (if any) and return the new row. Returns
 *  null only when neither a month plan nor a default exists. */
export async function getOrSnapshotMonthBudget(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<BudgetPlanRecord | null> {
  const periodStart = firstOfMonth(year, month1to12);
  const existing = await prisma.budgetPlan.findUnique({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
  });
  if (existing) return row(existing);

  const def = await prisma.budgetPlan.findUnique({
    where: {
      workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
    },
  });
  if (!def) return null;

  // Snapshot. Race: if two callers hit this concurrently the second
  // upsert will see an existing row and update with the same values —
  // safe enough.
  const snap = await prisma.budgetPlan.upsert({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
    create: {
      workspaceId,
      periodStart,
      totalAmount: def.totalAmount,
      categoryAllocations: def.categoryAllocations as Prisma.InputJsonValue,
    },
    update: {},
  });
  return row(snap);
}

/** Set a specific month's plan, overriding the default for that month
 *  only. Does NOT update the default template. */
export async function setMonthBudget(
  workspaceId: string,
  year: number,
  month1to12: number,
  input: SetBudgetInput,
): Promise<BudgetPlanRecord> {
  const periodStart = firstOfMonth(year, month1to12);
  const updated = await prisma.budgetPlan.upsert({
    where: { workspaceId_periodStart: { workspaceId, periodStart } },
    create: {
      workspaceId,
      periodStart,
      totalAmount: new Prisma.Decimal(input.totalAmount),
      categoryAllocations:
        (input.categoryAllocations ?? []) as unknown as Prisma.InputJsonValue,
    },
    update: {
      totalAmount: new Prisma.Decimal(input.totalAmount),
      categoryAllocations:
        (input.categoryAllocations ?? []) as unknown as Prisma.InputJsonValue,
    },
  });
  return row(updated);
}

export type CategorySpend = {
  categoryId: string;
  categoryName: string;
  spent: number;
};

/** Sum positive-amount expense allocations grouped by category for the
 *  given month [periodStart, nextMonth). Pulls category names alongside
 *  for UI render. Categories with zero spend are NOT returned — the
 *  caller can backfill them from the plan's allocations. */
export async function monthlySpendByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<CategorySpend[]> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(
    month1to12 === 12 ? year + 1 : year,
    month1to12 === 12 ? 1 : month1to12 + 1,
  );
  const rows = await prisma.transactionAllocation.findMany({
    where: {
      amount: { gt: 0 },
      categoryId: { not: null },
      transaction: {
        workspaceId,
        removedAt: null,
        occurredAt: { gte: from, lt: to },
        amount: { gt: 0 },
      },
    },
    select: {
      amount: true,
      categoryId: true,
      category: { select: { name: true } },
    },
  });
  const sums = new Map<string, { name: string; spent: number }>();
  for (const r of rows) {
    if (!r.categoryId || !r.category) continue;
    const cur = sums.get(r.categoryId) ?? { name: r.category.name, spent: 0 };
    cur.spent += Number(r.amount);
    sums.set(r.categoryId, cur);
  }
  return Array.from(sums, ([categoryId, v]) => ({
    categoryId,
    categoryName: v.name,
    spent: Math.round(v.spent * 100) / 100,
  }));
}

/** Average monthly spend over the last 90 days. Used to sanity-check
 *  the user's chosen total at save time — if they pick a number that's
 *  way below this, we surface a warning so they're not budgeting blind. */
export async function recentMonthlyAvgSpend(
  workspaceId: string,
): Promise<number> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  const agg = await prisma.transaction.aggregate({
    where: {
      workspaceId,
      removedAt: null,
      occurredAt: { gte: since },
      amount: { gt: 0 },
    },
    _sum: { amount: true },
  });
  // Total over ~3 months → monthly average. Round to whole dollars for
  // a friendlier comparison number.
  const total = Number(agg._sum.amount ?? 0);
  return Math.round(total / 3);
}

/** Total spend (any category) for the month — used for the "total
 *  spent vs total budget" headline. */
export async function monthlyTotalSpend(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<number> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(
    month1to12 === 12 ? year + 1 : year,
    month1to12 === 12 ? 1 : month1to12 + 1,
  );
  const agg = await prisma.transaction.aggregate({
    where: {
      workspaceId,
      removedAt: null,
      occurredAt: { gte: from, lt: to },
      amount: { gt: 0 },
    },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
