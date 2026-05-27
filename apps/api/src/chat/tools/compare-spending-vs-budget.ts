import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { compareSpendingVsBudgetService } from "../../budgets/service.js";
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
    "Compare actual spending against budgets for the given period. Returns per-category amount/spent/remaining/pace status. period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    const period = args.period ?? "this_month";
    const raw = await compareSpendingVsBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { period },
    );
    return { ...raw, block: toRecapBlock(period, raw.items) };
  },
};

/** Per-category budget consumption. headline = portfolio-wide spent /
 *  budget %, rows = each category with budget in `sub` and remaining in
 *  `delta`. bar_pct mirrors spent / budget so the eye sees pace at a
 *  glance; over-pace lines naturally fill > 100% (clamped to 100 in the
 *  bar but the delta shows the negative remaining). */
function toRecapBlock(period: Period, items: Item[]): PresentationBlock {
  const periodLabel =
    period === "this_month" ? "This month" :
    period === "last_month" ? "Last month" : "Next month";

  const budget = items.reduce((s, i) => s + parseFloat(i.amount), 0);
  const spent = items.reduce((s, i) => s + parseFloat(i.spent), 0);
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
        bar_pct: Math.min(100, Math.round(i.spentPct * 100)),
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
