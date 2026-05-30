import type { RiskTier } from "@fina/shared";
import {
  budgetPlanSnapshot,
  recentDiscretionaryDailyByCategory,
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
} from "../budget-plans/service.js";
import { partsInTz, resolveUserTz } from "../chat/tools/periods.js";

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
};

export type MonthEndForecast = {
  year: number;
  month: number;
  daysLeft: number;
  categories: CategoryForecast[];
  portfolio: { cap: number; spent: number; projected: number; severity: RiskTier };
};

function severityFor(projected: number, cap: number): RiskTier {
  if (projected <= cap) return "on_track";
  if (projected <= cap * WATCH_FACTOR) return "watch";
  return "at_risk";
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
  now: Date = new Date(),
): Promise<MonthEndForecast> {
  const tz = await resolveUserTz(userId);
  const { daysLeft, todayDay, isThisMonth, daysInMonth } = daysLeftInMonth(year, month, now, tz);

  const snap = await budgetPlanSnapshot(workspaceId, year, month);
  if (!snap) {
    return { year, month, daysLeft, categories: [], portfolio: { cap: 0, spent: 0, projected: 0, severity: "on_track" } };
  }

  const capped = snap.categories.filter((c) => c.allocated !== null);
  const capIds = capped.map((c) => c.categoryId);

  const [discRates, subs, scheduled] = await Promise.all([
    recentDiscretionaryDailyByCategory(workspaceId, capIds),
    monthlySubscriptionByCategory(workspaceId, year, month),
    monthlyScheduledSpendByCategory(workspaceId, year, month),
  ]);

  const categories: CategoryForecast[] = capped.map((c) => {
    const cap = parseFloat(c.allocated!);
    const spent = parseFloat(c.spent);
    const fixedBills = subs.get(c.categoryId) ?? 0;
    const plannedOneOffs = scheduled.get(c.categoryId) ?? 0;
    const discRate = discRates.get(c.categoryId) ?? 0;

    const discProjection = discRate * daysLeft;
    const projected = round2(spent + fixedBills + Math.max(plannedOneOffs, discProjection));
    const projectedOverspend = Math.max(0, round2(projected - cap));
    const projectedUnderspend = Math.max(0, round2(cap - projected));

    const noActivity = spent === 0 && fixedBills === 0 && plannedOneOffs === 0;
    const severity: RiskTier =
      discRate <= 0 && noActivity ? "insufficient_history" : severityFor(projected, cap);

    let runwayDay: number | null = null;
    if (isThisMonth && discRate > 0 && spent < cap) {
      const day = todayDay + Math.floor((cap - spent) / discRate);
      if (day >= todayDay && day <= daysInMonth) runwayDay = day;
    }

    return {
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      cap, spent, fixedBills, plannedOneOffs, discRate, daysLeft,
      projected, projectedOverspend, projectedUnderspend, runwayDay, severity,
    };
  });

  const totalCap = parseFloat(snap.totalAmount);
  const totalSpent = parseFloat(snap.totalSpent);
  const totalScheduled = parseFloat(snap.totalScheduled);
  const portfolioProjected = round2(totalSpent + totalScheduled);
  const portfolio = {
    cap: totalCap,
    spent: totalSpent,
    projected: portfolioProjected,
    severity: (totalCap > 0 ? severityFor(portfolioProjected, totalCap) : "on_track") as RiskTier,
  };

  return { year, month, daysLeft, categories, portfolio };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
