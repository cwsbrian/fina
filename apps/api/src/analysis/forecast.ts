import type { RiskTier } from "@fina/shared";
import {
  budgetPlanSnapshot,
  recentDiscretionaryDailyByCategory,
  recentTypicalAmountByCategory,
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
  recentMonthlyAvgSpend,
  recentMonthlyAvgSpendByCategory,
} from "../budget-plans/service.js";
import { partsInTz, resolveUserTz } from "../chat/tools/periods.js";
import { serverNow } from "../dev-clock.js";

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
};

export type MonthEndForecast = {
  year: number;
  month: number;
  daysLeft: number;
  categories: CategoryForecast[];
  portfolio: { cap: number; spent: number; scheduled: number; projected: number; severity: RiskTier };
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
  now: Date = serverNow(),
): Promise<MonthEndForecast> {
  const tz = await resolveUserTz(userId);
  const { daysLeft, todayDay, isThisMonth, daysInMonth } = daysLeftInMonth(year, month, now, tz);

  const snap = await budgetPlanSnapshot(workspaceId, year, month);
  if (!snap) {
    return { year, month, daysLeft, categories: [], portfolio: { cap: 0, spent: 0, scheduled: 0, projected: 0, severity: "on_track" } };
  }

  const capped = snap.categories.filter((c) => c.allocated !== null);
  const capIds = capped.map((c) => c.categoryId);

  const [discRates, typicals, subs, scheduled, monthlyAvgs] = await Promise.all([
    recentDiscretionaryDailyByCategory(workspaceId, capIds),
    recentTypicalAmountByCategory(workspaceId, capIds),
    monthlySubscriptionByCategory(workspaceId, year, month),
    monthlyScheduledSpendByCategory(workspaceId, year, month),
    daysLeft > 0 ? recentMonthlyAvgSpendByCategory(workspaceId, capIds) : Promise.resolve(new Map<string, number>()),
  ]);

  const categories: CategoryForecast[] = capped.map((c) => {
    const cap = parseFloat(c.allocated!);
    const spent = parseFloat(c.spent);
    const fixedBills = subs.get(c.categoryId) ?? 0;
    const plannedOneOffs = scheduled.get(c.categoryId) ?? 0;
    const discRate = discRates.get(c.categoryId) ?? 0;
    const monthlyAvg = monthlyAvgs.get(c.categoryId) ?? 0;

    const committed = round2(spent + fixedBills + plannedOneOffs);
    const projected = round2(Math.max(committed, monthlyAvg));
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
      typicalAmount: typicals.get(c.categoryId) ?? 0,
    };
  });

  const totalCap = parseFloat(snap.totalAmount);
  const totalSpent = parseFloat(snap.totalSpent);
  // Workspace-wide scheduled = TODAY-FORWARD subscriptions + scheduled spends
  // (both maps are already today-forward), across all categories — not the
  // snapshot's totalScheduled, which still counts past-dated scheduled rows.
  const sumMap = (m: Map<string, number>) => Array.from(m.values()).reduce((a, b) => a + b, 0);
  const scheduledTotal = round2(sumMap(subs) + sumMap(scheduled)); // committed, today-forward

  // Workspace-wide month-end TOTAL projection — the number that actually
  // decides "will I blow my overall budget". Robust form that does NOT add a
  // run-rate on TOP of actuals (which double-counts once you've spent most of
  // the month): the total will end at LEAST at what's already spent + still
  // committed, and historically the workspace spends ~its monthly average, so
  // take whichever is higher. Bounded — never explodes on a high-spend month.
  const committedTotal = round2(totalSpent + scheduledTotal);
  const monthlyAvg = isThisMonth ? await recentMonthlyAvgSpend(workspaceId) : 0;
  const portfolioProjected = round2(Math.max(committedTotal, monthlyAvg));
  const portfolio = {
    cap: totalCap,
    spent: totalSpent,
    scheduled: scheduledTotal,
    projected: portfolioProjected,
    severity: (totalCap > 0 ? severityFor(portfolioProjected, totalCap) : "on_track") as RiskTier,
  };

  return { year, month, daysLeft, categories, portfolio };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
