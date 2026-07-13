import { z } from "zod";
import type { PresentationBlock, RiskTier } from "@fina/shared";
import { budgetPlanSnapshot, periodToYearMonth } from "../../budget-plans/service.js";
import { projectMonthEnd, type CategoryForecast } from "../../analysis/forecast.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

type Period = NonNullable<Args["period"]>;

type Item = {
  categoryId: string;
  categoryName: string;
  amount: string;
  spent: string;
  planned: string;
  remaining: string;
  spentPct: number;
  plannedPct: number;
  todayPct: number;
  status: "on-pace" | "over-pace";
  projected: string;
  projectedOverspend: string;
  scheduled: string;
  runwayDay: number | null;
  severity: RiskTier;
  typicalAmount: string;
};

type Result = {
  period: { start: string; end: string };
  /** TOTAL (whole-budget) month-end projection — the headline judgment: will
   *  the user blow their OVERALL budget. Lead with this; items are the "where". */
  portfolio: {
    budget: string;
    spent: string;
    scheduled: string;
    projected: string;
    overspend: string;
    severity: RiskTier;
  };
  items: Item[];
  block: PresentationBlock;
};

export const compareSpendingVsBudget: ToolDef<Args, Result> = {
  name: "compareSpendingVsBudget",
  description:
    "Compare actual spending against the budget for the period — per capped category, with remaining and pace. Sources the real BudgetPlan. period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    const period = args.period ?? "this_month";
    const { year, month } = periodToYearMonth(period);
    const snap = await budgetPlanSnapshot(ctx.workspaceId, year, month);

    const todayPct = todayPctFor(period, year, month);
    const forecast = await projectMonthEnd(ctx.workspaceId, ctx.userId, year, month);
    const fcById = new Map<string, CategoryForecast>(
      forecast.categories.map((f) => [f.categoryId, f]),
    );
    const items: Item[] = (snap?.categories ?? [])
      .filter((c) => c.allocated !== null)
      .map((c) => {
        const amount = parseFloat(c.allocated!);
        const spent = parseFloat(c.spent);
        const fc = fcById.get(c.categoryId);
        // "planned" = TODAY-FORWARD known future (subscriptions + scheduled
        // spends) from the forecast — NOT the snapshot's scheduled, which
        // still counts past-dated rows. Keeps remaining/attention consistent
        // with the forecast (a past-dated scheduled spend no longer drags a
        // category into the red).
        const planned = fc ? fc.fixedBills + fc.plannedOneOffs : parseFloat(c.scheduled);
        const remaining = amount - spent - planned;
        const spentPct = amount > 0 ? Number(((spent / amount) * 100).toFixed(2)) : 0;
        const plannedPct = amount > 0 ? Number(((planned / amount) * 100).toFixed(2)) : 0;
        const status: "on-pace" | "over-pace" =
          spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
        return {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          amount: c.allocated!,
          spent: c.spent,
          planned: planned.toFixed(2),
          remaining: remaining.toFixed(2),
          spentPct,
          plannedPct,
          todayPct,
          status,
          projected: (fc?.projected ?? spent).toFixed(2),
          projectedOverspend: (fc?.projectedOverspend ?? 0).toFixed(2),
          scheduled: planned.toFixed(2),
          runwayDay: fc?.runwayDay ?? null,
          severity: fc?.severity ?? "insufficient_history",
          typicalAmount: (fc?.typicalAmount ?? 0).toFixed(2),
        };
      });

    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    // Headline totals come from the snapshot's TRUE totals (all spend vs
    // total cap) — NOT the sum of capped-category rows. Otherwise spend in
    // uncapped categories is ignored and "Used %" reads far too low (e.g.
    // 13% when the user has actually spent 92% of their budget).
    const totalSpent = snap ? parseFloat(snap.totalSpent) : 0;
    const totalBudget = snap ? parseFloat(snap.totalAmount) : 0;
    const pf = forecast.portfolio;
    const pfOverspend = Math.max(0, Math.round((pf.projected - pf.cap) * 100) / 100);
    return {
      period: { start, end },
      portfolio: {
        budget: totalBudget.toFixed(2),
        spent: totalSpent.toFixed(2),
        scheduled: pf.scheduled.toFixed(2),
        projected: pf.projected.toFixed(2),
        overspend: pfOverspend.toFixed(2),
        severity: pf.severity,
      },
      items,
      block: toRecapBlock(period, items, totalSpent, totalBudget, pf.scheduled, pf.projected),
    };
  },
};

/** Local-day-of-month / days-in-month, as a percent. last_month=100, next_month=0. */
function todayPctFor(period: Period, year: number, month: number): number {
  if (period === "last_month") return 100;
  if (period === "next_month") return 0;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = new Date().getUTCDate();
  return Math.round((day / dim) * 10000) / 100;
}

/** Per-category budget consumption. headline = portfolio-wide spent /
 *  budget %, rows = each category with budget in `sub` and remaining in
 *  `delta`. bar_pct mirrors spent / budget so the eye sees pace at a
 *  glance; over-pace lines naturally fill > 100% (clamped to 100 in the
 *  bar but the delta shows the negative remaining). */
function toRecapBlock(
  period: Period,
  items: Item[],
  totalSpent: number,
  totalBudget: number,
  totalScheduled: number,
  projectedTotal: number,
): PresentationBlock {
  const periodLabel =
    period === "this_month" ? "This month" : period === "last_month" ? "Last month" : "Next month";

  // True totals across ALL spend (capped + uncapped), matching the Home
  // screen and getBudget — not just the capped rows below.
  const budget = totalBudget;
  const spent = totalSpent;
  const usedPct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const remaining = budget - spent;

  // Only surface categories that need ATTENTION — forecast severity is
  // at_risk/watch, or already over their cap. Using forecast-based severity
  // rather than pace alone means the filter accounts for the category's
  // same-day pattern projection, not just the current-day snapshot. Categories that
  // are on_track (or have insufficient history) are noise on a "how am I
  // doing" card, so we hide them and note the count instead. Most-strained first.
  const attention = items
    .filter(
      (i) => i.severity === "at_risk" || i.severity === "watch" || parseFloat(i.remaining) < 0,
    )
    .sort((a, b) => b.spentPct - a.spentPct);
  const hiddenOnPace = items.length - attention.length;

  let footer: string | undefined;
  if (items.length === 0) {
    footer = "No budgets set for this period yet.";
  } else if (attention.length === 0) {
    footer = "Every category is on pace.";
  } else if (hiddenOnPace > 0) {
    footer = `+${hiddenOnPace} more on pace`;
  }

  return {
    type: "recap",
    title: "Budget · this period",
    period_label: periodLabel,
    headline: {
      label: "Used",
      amount: `${usedPct}%`,
      ...(budget > 0
        ? {
            delta: {
              value: Math.abs(remaining).toFixed(2),
              direction: (remaining >= 0 ? "down" : "up") as "up" | "down",
            },
            // Show the underlying numbers behind the % so the headline isn't a
            // bare percentage: budget cap, spent so far, and today-forward
            // scheduled+subscription spend.
            budget: budget.toFixed(2),
            spent: spent.toFixed(2),
            scheduled: totalScheduled.toFixed(2),
            projected: projectedTotal.toFixed(2),
          }
        : {}),
    },
    rows: attention.map((i) => {
      const rem = parseFloat(i.remaining);
      return {
        label: i.categoryName,
        amount: i.spent,
        sub: `Budget ${i.amount}`,
        bar_pct: Math.min(100, Math.round(i.spentPct)),
        delta: {
          value: Math.abs(rem).toFixed(2),
          direction: (rem >= 0 ? "down" : "up") as "up" | "down",
        },
        projected: i.projected,
        ...(parseFloat(i.scheduled) > 0 ? { scheduled: i.scheduled } : {}),
        severity: i.severity,
      };
    }),
    ...(footer ? { footer } : {}),
  };
}
