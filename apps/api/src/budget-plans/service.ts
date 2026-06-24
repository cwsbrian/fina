import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { monthlyEquivalent, occurrencesInRange } from "../recurring/occurrences.js";
import { serverNow } from "../dev-clock.js";
import { budgetExpenseAllocationWhere, budgetExpenseTransactionWhere } from "../transactions/budget-impact.js";

/** Sentinel date that marks the user's "default" template plan. Real
 *  monthly snapshots use the first-of-month for the period. */
export const DEFAULT_PERIOD = new Date("1900-01-01T00:00:00.000Z");

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
  // Midnight UTC for date-only month keys and deterministic month bucketing.
  return new Date(Date.UTC(year, month1to12 - 1, 1));
}

/** Upper bound for "spend so far this month" — capped at the (possibly
 *  DEV_NOW-overridden) current instant so month-to-date actuals never include
 *  future-dated transactions. For a fully past month this is just `to`; this
 *  is what lets the run-rate forecast add "rest of month" without
 *  double-counting spend that hasn't happened yet. No effect in real usage
 *  (real actuals are never future-dated). */
function spendUpperBound(to: Date): Date {
  const n = serverNow();
  return n < to ? n : to;
}

/** [from, to) midnight-UTC bounds for a calendar month. Use this (NOT
 *  ad-hoc manual offsets) when filtering @db.Date columns
 *  (scheduledDate, nextOccurrenceDate) so items dated the 1st land in the
 *  correct month. Date.UTC rolls Dec→Jan over automatically. */
function monthBoundsUtc(year: number, month1to12: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(year, month1to12 - 1, 1)),
    to: new Date(Date.UTC(year, month1to12, 1)),
  };
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
      ...budgetExpenseAllocationWhere({
        workspaceId,
        occurredAt: { gte: from, lt: to },
      }),
      categoryId: { not: null },
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
  const since = new Date(serverNow().getTime() - 90 * 86_400_000);
  const agg = await prisma.transaction.aggregate({
    where: budgetExpenseTransactionWhere({
      workspaceId,
      occurredAt: { gte: since },
    }),
    _sum: { amount: true },
  });
  // Total over ~3 months → monthly average. Round to whole dollars for
  // a friendlier comparison number.
  const total = Number(agg._sum.amount ?? 0);
  return Math.round(total / 3);
}

/** Sum of the monthly-equivalent amount of every recurring expense in the
 *  workspace — the "fixed" baseline that should be excluded when estimating
 *  the workspace's typical DISCRETIONARY run-rate for the month-end forecast. */
export async function workspaceRecurringMonthly(workspaceId: string): Promise<number> {
  const subs = await prisma.recurringExpense.findMany({
    where: { workspaceId },
    select: { amount: true, cadence: true },
  });
  let total = 0;
  for (const s of subs) total += monthlyEquivalent(Number(s.amount), s.cadence);
  return Math.round(total * 100) / 100;
}

function todayUTCMidnight(): Date {
  const now = serverNow();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Sum upcoming subscription occurrences (RecurringExpense) for the
 *  given month, grouped by category. Includes only occurrences from
 *  today forward — earlier in the month they've either already
 *  matched real transactions (counted via actuals) or were missed. */
export async function subscriptionOccurrencesByCategory(
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
    where: budgetExpenseTransactionWhere({
      workspaceId,
      occurredAt: { gte: from, lt: spendUpperBound(to) },
    }),
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
  const d = serverNow();
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

/** Per-category MEDIAN positive transaction-allocation amount over the trailing
 *  90 days. Used by the advisor to size plan proposals ("typical spend per
 *  transaction"). Only positive amounts are considered (refunds ignored).
 *  Median = middle element of sorted positives (upper-middle for even counts).
 *  Returns 0 for categories with no positive transactions in the window.
 *  Result rounded to 2 decimals. */
export async function recentTypicalAmountByCategory(
  workspaceId: string,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (categoryIds.length === 0) return out;
  const since = new Date(serverNow().getTime() - 90 * 86_400_000);

  const rows = await prisma.transactionAllocation.findMany({
    where: {
      ...budgetExpenseAllocationWhere({
        workspaceId,
        pending: false,
        occurredAt: { gte: since },
      }),
      categoryId: { in: categoryIds },
    },
    select: { amount: true, categoryId: true },
  });

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const arr = byCat.get(r.categoryId) ?? [];
    arr.push(Number(r.amount));
    byCat.set(r.categoryId, arr);
  }

  for (const id of categoryIds) {
    const positives = (byCat.get(id) ?? []).sort((a, b) => a - b);
    if (positives.length === 0) {
      out.set(id, 0);
      continue;
    }
    const median = positives[Math.floor(positives.length / 2)]!;
    out.set(id, Math.round(median * 100) / 100);
  }
  return out;
}

/** Per-category DISCRETIONARY daily spend rate over the trailing 90 days,
 *  for the month-end forecast. Discretionary = actual category spend with the
 *  category's recurring (subscription) monthly-equivalent removed, so fixed
 *  bills aren't double-counted against forward occurrences. Refunds are NETTED
 *  (we do NOT filter amount>0) and pending transactions are EXCLUDED to avoid
 *  double-counting the later posted row. A single outlier transaction is
 *  winsorized to 3x the category's median positive spend so one big buy doesn't dominate 90 days.
 *  Returns a Map categoryId -> daily rate (>= 0). */
export async function recentDiscretionaryDailyByCategory(
  workspaceId: string,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (categoryIds.length === 0) return out;
  const since = new Date(serverNow().getTime() - 90 * 86_400_000);

  const rows = await prisma.transactionAllocation.findMany({
    where: {
      transaction: budgetExpenseTransactionWhere({
        workspaceId,
        pending: false,
        occurredAt: { gte: since },
      }),
      categoryId: { in: categoryIds },
    },
    select: { amount: true, categoryId: true },
  });

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const arr = byCat.get(r.categoryId) ?? [];
    arr.push(Number(r.amount));
    byCat.set(r.categoryId, arr);
  }

  const subs = await prisma.recurringExpense.findMany({
    where: { workspaceId, categoryId: { in: categoryIds } },
    select: { amount: true, cadence: true, categoryId: true },
  });
  const recurringMonthly = new Map<string, number>();
  for (const s of subs) {
    if (!s.categoryId) continue;
    recurringMonthly.set(
      s.categoryId,
      (recurringMonthly.get(s.categoryId) ?? 0) + monthlyEquivalent(Number(s.amount), s.cadence),
    );
  }

  for (const id of categoryIds) {
    const amounts = byCat.get(id) ?? [];
    if (amounts.length === 0) {
      out.set(id, 0);
      continue;
    }
    // Winsorize cap from the median of POSITIVE amounts (robust to a single
    // big buy, unlike a mean that the outlier itself inflates). Only positive
    // values are capped, so refunds (negatives) net through untouched.
    const positives = amounts.filter((a) => a > 0).sort((a, b) => a - b);
    const cap = positives.length > 0 ? 3 * positives[Math.floor(positives.length / 2)]! : 0;
    const winsorized = amounts.map((a) => (a > 0 && a > cap ? cap : a));
    const net90 = winsorized.reduce((a, b) => a + b, 0);
    const discretionary90 = net90 - (recurringMonthly.get(id) ?? 0) * 3;
    out.set(id, Math.max(0, discretionary90) / 90);
  }
  return out;
}

/** Subscription (RecurringExpense) occurrences for the month, grouped by
 *  category, today-forward. Wraps subscriptionOccurrencesByCategory and
 *  returns a flat categoryId -> amount map.
 *
 *  NOTE: RecurringExpense.nextOccurrenceDate is stored as @db.Date and comes
 *  back from Prisma as midnight UTC (T00:00:00Z), so we compute `to` as
 *  first-of-next-month at midnight to correctly exclude occurrences that land
 *  exactly on the month boundary. */
export async function monthlySubscriptionByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<Map<string, number>> {
  const { from, to } = monthBoundsUtc(year, month1to12);
  const m = await subscriptionOccurrencesByCategory(workspaceId, from, to);
  return new Map(Array.from(m, ([id, v]) => [id, Math.round(v.spent * 100) / 100]));
}

/** Unmatched, undismissed ScheduledSpend for the month (scheduledDate from
 *  month start — past-dated-this-month items are still expected), grouped by
 *  category. Excludes subscriptions (those come from monthlySubscriptionByCategory). */
export async function monthlyScheduledSpendByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<Map<string, number>> {
  const { from, to } = monthBoundsUtc(year, month1to12);
  // Count scheduled spends from TODAY forward only. A past-dated unmatched
  // scheduled spend has almost always already happened (so it's in the
  // actuals) or is stale — counting it would double-add against spend.
  // Mirrors subscription occurrences, which are already clamped today-forward.
  const today = todayUTCMidnight();
  const effFrom = today > from ? today : from;
  const rows = await prisma.scheduledSpend.findMany({
    where: { workspaceId, scheduledDate: { gte: effFrom, lt: to }, matchedTxId: null, dismissedAt: null },
    select: { amount: true, categoryId: true },
  });
  const sums = new Map<string, number>();
  for (const r of rows) {
    sums.set(r.categoryId, (sums.get(r.categoryId) ?? 0) + Number(r.amount));
  }
  return new Map(Array.from(sums, ([id, v]) => [id, Math.round(v * 100) / 100]));
}
