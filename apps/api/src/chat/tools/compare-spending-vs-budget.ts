import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { budgetPlanSnapshot, periodToYearMonth } from "../../budget-plans/service.js";
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
};

type Result = {
  period: { start: string; end: string };
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
    const items: Item[] = (snap?.categories ?? [])
      .filter((c) => c.allocated !== null)
      .map((c) => {
        const amount = parseFloat(c.allocated!);
        const spent = parseFloat(c.spent);
        const planned = parseFloat(c.scheduled);
        // Remaining headroom AFTER subtracting both actual spend and
        // upcoming scheduled/subscription spend (planned) — not just cash left.
        const remaining = amount - spent - planned;
        const spentPct = amount > 0 ? Number(((spent / amount) * 100).toFixed(2)) : 0;
        const plannedPct = amount > 0 ? Number(((planned / amount) * 100).toFixed(2)) : 0;
        const status: "on-pace" | "over-pace" = spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
        return {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          amount: c.allocated!,
          spent: c.spent,
          planned: c.scheduled,
          remaining: remaining.toFixed(2),
          spentPct,
          plannedPct,
          todayPct,
          status,
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
    return {
      period: { start, end },
      items,
      block: toRecapBlock(period, items, totalSpent, totalBudget),
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
): PresentationBlock {
  const periodLabel =
    period === "this_month" ? "This month" :
    period === "last_month" ? "Last month" : "Next month";

  // True totals across ALL spend (capped + uncapped), matching the Home
  // screen and getBudget — not just the capped rows below.
  const budget = totalBudget;
  const spent = totalSpent;
  const usedPct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const remaining = budget - spent;

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
          }
        : {}),
    },
    rows: items.map((i) => {
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
      };
    }),
    ...(items.length === 0
      ? { footer: "No budgets set for this period yet." }
      : {}),
  };
}
