import type { RiskTier } from "@fina/shared";
import {
  budgetPlanSnapshot,
  recentTypicalAmountByCategory,
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
} from "../budget-plans/service.js";
import { localMidnightToUtc, partsInTz, resolveUserTz } from "../chat/tools/periods.js";
import { serverNow } from "../dev-clock.js";
import { effectiveExpenseAllocations } from "../transactions/cashflow.js";

const WATCH_FACTOR = 1.1;

export type CategoryForecast = {
  categoryId: string;
  categoryName: string;
  cap: number;
  spent: number;
  fixedBills: number;
  plannedOneOffs: number;
  discRate: number;
  daysLeft: number;
  projected: number;
  projectedOverspend: number;
  projectedUnderspend: number;
  runwayDay: number | null;
  severity: RiskTier;
  typicalAmount: number;
  historyMonths: number;
  historicalMonthlyAverage: number;
  historicalOverspendMonths: number;
  currentPaceRatio: number | null;
};

export type MonthEndForecast = {
  year: number;
  month: number;
  daysLeft: number;
  categories: CategoryForecast[];
  portfolio: {
    cap: number;
    spent: number;
    scheduled: number;
    projected: number;
    severity: RiskTier;
  };
};

function severityFor(projected: number, cap: number): RiskTier {
  if (projected <= cap) return "on_track";
  if (projected <= cap * WATCH_FACTOR) return "watch";
  return "at_risk";
}

type CategoryPattern = {
  monthsObserved: number;
  averageToDate: number;
  averageRemaining: number;
  averageTotal: number;
  monthlyTotals: number[];
};

/** Category timing pattern from the three completed calendar months before
 *  the forecast month. A category needs activity in all three months before
 *  the pattern can influence its projection; less history stays conservative. */
async function completedMonthPatterns(
  workspaceId: string,
  categoryIds: string[],
  year: number,
  month: number,
  currentDay: number,
  tz: string,
): Promise<Map<string, CategoryPattern>> {
  if (categoryIds.length === 0) return new Map();

  const first = new Date(Date.UTC(year, month - 4, 1));
  const start = localMidnightToUtc(first.getUTCFullYear(), first.getUTCMonth() + 1, 1, tz);
  const end = localMidnightToUtc(year, month, 1, tz);
  const rows = await effectiveExpenseAllocations(
    workspaceId,
    { pending: false, occurredAt: { gte: start, lt: end } },
    categoryIds,
  );

  const totals = new Map<string, Map<string, { toDate: number; total: number }>>();
  for (const row of rows) {
    if (!row.categoryId) continue;
    const p = partsInTz(row.occurredAt, tz);
    const monthKey = `${p.year}-${p.month}`;
    const byMonth = totals.get(row.categoryId) ?? new Map();
    const bucket = byMonth.get(monthKey) ?? { toDate: 0, total: 0 };
    const amount = row.amount;
    bucket.total += amount;
    if (p.day <= currentDay) bucket.toDate += amount;
    byMonth.set(monthKey, bucket);
    totals.set(row.categoryId, byMonth);
  }

  const out = new Map<string, CategoryPattern>();
  for (const categoryId of categoryIds) {
    const months = Array.from(totals.get(categoryId)?.values() ?? []);
    const count = months.length;
    if (count === 0) continue;
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    const monthlyTotals = months.map((value) => round2(value.total));
    const averageToDate = sum(months.map((value) => value.toDate)) / count;
    const averageTotal = sum(months.map((value) => value.total)) / count;
    out.set(categoryId, {
      monthsObserved: count,
      averageToDate: round2(averageToDate),
      averageRemaining: round2(Math.max(0, averageTotal - averageToDate)),
      averageTotal: round2(averageTotal),
      monthlyTotals,
    });
  }
  return out;
}

/** Days remaining in the month (inclusive of today) in the user's tz. Past
 *  month → 0; future month → full month. */
function daysLeftInMonth(
  year: number,
  month: number,
  now: Date,
  tz: string,
): { daysLeft: number; daysInMonth: number; todayDay: number; isThisMonth: boolean } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const p = partsInTz(now, tz);
  const cmp = p.year * 12 + (p.month - 1) - (year * 12 + (month - 1));
  if (cmp > 0) return { daysLeft: 0, daysInMonth, todayDay: daysInMonth, isThisMonth: false };
  if (cmp < 0) return { daysLeft: daysInMonth, daysInMonth, todayDay: 0, isThisMonth: false };
  return { daysLeft: daysInMonth - p.day + 1, daysInMonth, todayDay: p.day, isThisMonth: true };
}

export async function projectMonthEnd(
  workspaceId: string,
  userId: string,
  year: number,
  month: number,
  now: Date = serverNow(),
): Promise<MonthEndForecast> {
  const tz = await resolveUserTz(userId);
  const { daysLeft, todayDay, isThisMonth, daysInMonth } = daysLeftInMonth(year, month, now, tz);

  const snap = await budgetPlanSnapshot(workspaceId, year, month);
  if (!snap) {
    return {
      year,
      month,
      daysLeft,
      categories: [],
      portfolio: { cap: 0, spent: 0, scheduled: 0, projected: 0, severity: "on_track" },
    };
  }

  const capped = snap.categories.filter((c) => c.allocated !== null);
  const capIds = capped.map((c) => c.categoryId);

  const [typicals, subs, scheduled, patterns] = await Promise.all([
    recentTypicalAmountByCategory(workspaceId, capIds),
    monthlySubscriptionByCategory(workspaceId, year, month),
    monthlyScheduledSpendByCategory(workspaceId, year, month),
    completedMonthPatterns(workspaceId, capIds, year, month, todayDay, tz),
  ]);

  const categories: CategoryForecast[] = capped.map((c) => {
    const cap = parseFloat(c.allocated!);
    const spent = parseFloat(c.spent);
    const fixedBills = subs.get(c.categoryId) ?? 0;
    const plannedOneOffs = scheduled.get(c.categoryId) ?? 0;
    const confirmedFuture = round2(fixedBills + plannedOneOffs);
    const pattern = patterns.get(c.categoryId);
    const historyReady = pattern?.monthsObserved === 3;
    let currentPaceRatio: number | null = null;
    let patternRemaining = 0;
    if (historyReady && pattern) {
      if (todayDay === 0) currentPaceRatio = 1;
      else if (pattern.averageToDate > 0) currentPaceRatio = spent / pattern.averageToDate;
      else currentPaceRatio = spent > 0 ? 2 : 1;
      patternRemaining = round2(pattern.averageRemaining * currentPaceRatio);
    }

    // Confirmed future spend is the floor for the remaining month. Taking the
    // larger remaining estimate avoids counting the same recurring/scheduled
    // charge once in the historical pattern and again as a known occurrence.
    const projected = round2(spent + Math.max(confirmedFuture, patternRemaining));
    const projectedOverspend = Math.max(0, round2(projected - cap));
    const projectedUnderspend = Math.max(0, round2(cap - projected));
    const committed = round2(spent + confirmedFuture);

    const noActivity = committed === 0;
    let severity: RiskTier;
    if (!historyReady && noActivity) {
      severity = "insufficient_history";
    } else if (committed > cap) {
      severity = severityFor(committed, cap);
    } else if (
      !isThisMonth ||
      (currentPaceRatio !== null && currentPaceRatio > WATCH_FACTOR)
    ) {
      severity = severityFor(projected, cap);
    } else {
      // For the current month, a historically over-budget category is coaching
      // context, not a daily warning, until today's actual pace is worsening.
      severity = "on_track";
    }

    const forwardDays = Math.max(0, daysLeft - (isThisMonth ? 1 : 0));
    const discRate = forwardDays > 0 ? round2(patternRemaining / forwardDays) : 0;

    let runwayDay: number | null = null;
    if (isThisMonth && discRate > 0 && spent < cap) {
      const day = todayDay + Math.floor((cap - spent) / discRate);
      if (day >= todayDay && day <= daysInMonth) runwayDay = day;
    }

    return {
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      cap,
      spent,
      fixedBills,
      plannedOneOffs,
      discRate,
      daysLeft,
      projected,
      projectedOverspend,
      projectedUnderspend,
      runwayDay,
      severity,
      typicalAmount: typicals.get(c.categoryId) ?? 0,
      historyMonths: pattern?.monthsObserved ?? 0,
      historicalMonthlyAverage: pattern?.averageTotal ?? 0,
      historicalOverspendMonths: pattern?.monthlyTotals.filter((total) => total > cap).length ?? 0,
      currentPaceRatio: currentPaceRatio === null ? null : round2(currentPaceRatio),
    };
  });

  const totalCap = parseFloat(snap.totalAmount);
  const totalSpent = parseFloat(snap.totalSpent);
  // Workspace-wide scheduled = TODAY-FORWARD subscriptions + scheduled spends
  // (both maps are already today-forward), across all categories — not the
  // snapshot's totalScheduled, which still counts past-dated scheduled rows.
  const sumMap = (m: Map<string, number>) => Array.from(m.values()).reduce((a, b) => a + b, 0);
  const scheduledTotal = round2(sumMap(subs) + sumMap(scheduled)); // committed, today-forward

  const committedTotal = round2(totalSpent + scheduledTotal);
  const cappedSpent = round2(categories.reduce((total, c) => total + c.spent, 0));
  const cappedScheduled = round2(
    categories.reduce((total, c) => total + c.fixedBills + c.plannedOneOffs, 0),
  );
  const uncappedCommitted = round2(
    Math.max(0, totalSpent - cappedSpent) + Math.max(0, scheduledTotal - cappedScheduled),
  );
  const portfolioProjected = round2(
    categories.reduce((total, c) => total + c.projected, 0) + uncappedCommitted,
  );
  const hasCurrentRisk = categories.some((c) => c.severity === "watch" || c.severity === "at_risk");
  const portfolioSeverity =
    totalCap <= 0
      ? "on_track"
      : committedTotal > totalCap
        ? severityFor(committedTotal, totalCap)
        : !isThisMonth || hasCurrentRisk
          ? severityFor(portfolioProjected, totalCap)
          : "on_track";
  const portfolio = {
    cap: totalCap,
    spent: totalSpent,
    scheduled: scheduledTotal,
    projected: portfolioProjected,
    severity: portfolioSeverity as RiskTier,
  };

  return { year, month, daysLeft, categories, portfolio };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
