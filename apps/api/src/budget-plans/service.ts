import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { occurrencesInRange } from "../recurring/occurrences.js";

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

function todayUTCMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Sum upcoming subscription occurrences (RecurringExpense) for the
 *  given month, grouped by category. Includes only occurrences from
 *  today forward — earlier in the month they've either already
 *  matched real transactions (counted via actuals) or were missed. */
async function subscriptionOccurrencesByCategory(
  workspaceId: string,
  monthFrom: Date,
  monthTo: Date,
): Promise<Map<string, { name: string; spent: number }>> {
  const today = todayUTCMidnight();
  const from = today > monthFrom ? today : monthFrom;
  if (!(monthTo > from)) return new Map();

  const subs = await prisma.recurringExpense.findMany({
    where: { workspaceId, categoryId: { not: null } },
    select: {
      amount: true,
      cadence: true,
      nextOccurrenceDate: true,
      categoryId: true,
      category: { select: { name: true } },
    },
  });

  const sums = new Map<string, { name: string; spent: number }>();
  for (const s of subs) {
    if (!s.categoryId || !s.category) continue;
    const occs = occurrencesInRange(
      s.nextOccurrenceDate,
      s.cadence,
      from,
      monthTo,
    );
    if (occs.length === 0) continue;
    const amount = Number(s.amount);
    const cur =
      sums.get(s.categoryId) ?? { name: s.category.name, spent: 0 };
    cur.spent += amount * occs.length;
    sums.set(s.categoryId, cur);
  }
  return sums;
}

/** Sum of upcoming (not yet matched, not dismissed) scheduled spends
 *  + future subscription occurrences in the given month, grouped by
 *  category. Used by the budget screen to show projected spend
 *  alongside actuals. */
export async function monthlyScheduledByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<CategorySpend[]> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(
    month1to12 === 12 ? year + 1 : year,
    month1to12 === 12 ? 1 : month1to12 + 1,
  );
  const [scheduled, subs] = await Promise.all([
    prisma.scheduledSpend.findMany({
      where: {
        workspaceId,
        scheduledDate: { gte: from, lt: to },
        matchedTxId: null,
        dismissedAt: null,
      },
      select: {
        amount: true,
        categoryId: true,
        category: { select: { name: true } },
      },
    }),
    subscriptionOccurrencesByCategory(workspaceId, from, to),
  ]);
  const sums = new Map(subs);
  for (const r of scheduled) {
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

/** Total upcoming scheduled + subscription spend for the month — used
 *  for the "scheduled" sub-line on the budget hero. */
export async function monthlyScheduledTotal(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<number> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(
    month1to12 === 12 ? year + 1 : year,
    month1to12 === 12 ? 1 : month1to12 + 1,
  );
  const today = todayUTCMidnight();
  const subFrom = today > from ? today : from;

  const [agg, subs] = await Promise.all([
    prisma.scheduledSpend.aggregate({
      where: {
        workspaceId,
        scheduledDate: { gte: from, lt: to },
        matchedTxId: null,
        dismissedAt: null,
      },
      _sum: { amount: true },
    }),
    to > subFrom
      ? prisma.recurringExpense.findMany({
          where: { workspaceId },
          select: { amount: true, cadence: true, nextOccurrenceDate: true },
        })
      : Promise.resolve([]),
  ]);

  let total = Number(agg._sum.amount ?? 0);
  for (const s of subs) {
    const occs = occurrencesInRange(
      s.nextOccurrenceDate,
      s.cadence,
      subFrom,
      to,
    );
    total += Number(s.amount) * occs.length;
  }
  return total;
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

export type BudgetSnapshotCategory = {
  categoryId: string;
  categoryName: string;
  color: string | null;
  icon: string | null;
  /** Cap from the plan's categoryAllocations; null when no cap is set. */
  allocated: string | null;
  spent: string;
  scheduled: string;
};

export type BudgetSnapshot = {
  totalAmount: string;
  totalSpent: string;
  totalScheduled: string;
  categories: BudgetSnapshotCategory[];
};

/** Single source for the chat budget tools — the same BudgetPlan data the
 *  Home/`/budget` screens use. Returns null when the workspace has no plan
 *  (no month snapshot and no default template). */
export async function budgetPlanSnapshot(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<BudgetSnapshot | null> {
  const plan = await getOrSnapshotMonthBudget(workspaceId, year, month1to12);
  if (!plan) return null;

  const [spendByCat, scheduledByCat, totalSpent, totalScheduled] = await Promise.all([
    monthlySpendByCategory(workspaceId, year, month1to12),
    monthlyScheduledByCategory(workspaceId, year, month1to12),
    monthlyTotalSpend(workspaceId, year, month1to12),
    monthlyScheduledTotal(workspaceId, year, month1to12),
  ]);

  const allocById = new Map(plan.categoryAllocations.map((a) => [a.categoryId, a.amount]));
  const spentById = new Map(spendByCat.map((c) => [c.categoryId, c.spent]));
  const scheduledById = new Map(scheduledByCat.map((c) => [c.categoryId, c.spent]));
  const nameById = new Map<string, string>();
  for (const c of spendByCat) nameById.set(c.categoryId, c.categoryName);
  for (const c of scheduledByCat) nameById.set(c.categoryId, c.categoryName);

  const ids = Array.from(new Set<string>([...allocById.keys(), ...spentById.keys(), ...scheduledById.keys()]));
  const cats = ids.length
    ? await prisma.category.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, name: true, color: true, icon: true },
      })
    : [];
  const meta = new Map(cats.map((c) => [c.id, c]));

  const categories: BudgetSnapshotCategory[] = ids.map((id) => ({
    categoryId: id,
    categoryName: meta.get(id)?.name ?? nameById.get(id) ?? "Unknown",
    color: meta.get(id)?.color ?? null,
    icon: meta.get(id)?.icon ?? null,
    allocated: allocById.has(id) ? allocById.get(id)!.toFixed(2) : null,
    spent: (spentById.get(id) ?? 0).toFixed(2),
    scheduled: (scheduledById.get(id) ?? 0).toFixed(2),
  }));

  return {
    totalAmount: plan.totalAmount,
    totalSpent: totalSpent.toFixed(2),
    totalScheduled: totalScheduled.toFixed(2),
    categories,
  };
}

export type ChatBudgetPeriod = "this_month" | "last_month" | "next_month";

/** Map the chat period enum to a calendar year/month on the same UTC basis
 *  budget-plans/current uses, so chat and Home agree on which month. */
export function periodToYearMonth(period: ChatBudgetPeriod): { year: number; month: number } {
  const d = new Date();
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1; // 1..12
  if (period === "last_month") {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  } else if (period === "next_month") {
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return { year, month };
}
