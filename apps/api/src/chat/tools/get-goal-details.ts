import { z } from "zod";
import type { GoalDTO, PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { getGoalWithSavings, findGoalsByTitle } from "../../goals/service.js";
import { dDayLabel, daysLeft, goalProgress } from "./list-goals.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    goal_id: z.string().min(1).optional(),
    title: z.string().min(1).max(80).optional(),
  })
  .refine((a) => !!a.goal_id !== !!a.title, {
    message: "Provide exactly one of goal_id or title",
  });
type Args = z.infer<typeof Args>;

/** Static explainer rendered on every goal_detail card — savings are
 *  derived, not deposited. NOT data-driven. */
const SAVINGS_NOTE =
  "Savings grow automatically as you stay under budget in these categories.";

function toBlock(
  g: GoalDTO,
  currency: string,
): Extract<PresentationBlock, { type: "goal_detail" }> {
  return {
    type: "goal_detail",
    id: g.id,
    title: g.title,
    saved: g.savedAmount,
    target: g.targetAmount,
    ...goalProgress(g.savedAmount, g.targetAmount),
    currency,
    due_label: dDayLabel(g.dueDate),
    days_left: daysLeft(g.dueDate),
    note: SAVINGS_NOTE,
    ...(g.allocations.length > 0
      ? {
          allocations: g.allocations.map((a) => ({
            category: {
              name: a.categoryName,
              color: a.categoryColor,
              icon: a.categoryIcon,
            },
            monthly: a.monthlyAmount,
            ...(a.rationale ? { rationale: a.rationale } : {}),
          })),
        }
      : {}),
    ...(g.strategy?.notice ? { strategy_note: g.strategy.notice } : {}),
  };
}

export const getGoalDetails: ToolDef<
  Args,
  { goal?: GoalDTO; block?: PresentationBlock; ambiguous?: boolean }
> = {
  name: "getGoalDetails",
  description:
    "Show one goal in detail — progress, due date/pace, and its per-category savings plan. Pass goal_id (from a prior goals_list/goal_detail card) OR title (a word from the goal's name). If the title matches more than one goal, the tool returns ambiguous=true — then call listGoals to show the picker instead of asking the user which one.",
  args: Args,
  async run(ctx, args) {
    // Fetch currency in parallel with the goal lookup — both round-trips
    // are independent.
    const currencyP = prisma.workspace
      .findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      })
      .then((w) => w.currency);

    if (args.goal_id) {
      const [goal, currency] = await Promise.all([
        getGoalWithSavings(ctx.workspaceId, args.goal_id),
        currencyP,
      ]);
      if (!goal || goal.archivedAt) throw new Error("goal_not_found");
      return { goal, block: toBlock(goal, currency) };
    }

    // args.title is guaranteed present here — the zod refine rejects the
    // case where neither goal_id nor title is set.
    const [matches, currency] = await Promise.all([
      findGoalsByTitle(ctx.workspaceId, args.title!),
      currencyP,
    ]);
    if (matches.length === 0) throw new Error("goal_not_found");
    if (matches.length > 1) return { ambiguous: true };
    const goal = matches[0]!;
    return { goal, block: toBlock(goal, currency) };
  },
};
