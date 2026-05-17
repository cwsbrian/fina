import { z } from "zod";
import { compareSpendingVsBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

export const compareSpendingVsBudget: ToolDef<
  Args,
  {
    period: { start: string; end: string };
    items: Array<{
      categoryId: string;
      categoryName: string;
      amount: string;
      spent: string;
      remaining: string;
      spentPct: number;
      todayPct: number;
      status: "on-pace" | "over-pace";
    }>;
  }
> = {
  name: "compareSpendingVsBudget",
  description:
    "Compare actual spending against budgets for the given period. Returns per-category amount/spent/remaining/pace status. period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    return compareSpendingVsBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { period: args.period ?? "this_month" },
    );
  },
};
