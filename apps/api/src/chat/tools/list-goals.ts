import { z } from "zod";
import type { GoalDTO, PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { listGoalsWithSavings } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});
type Args = z.infer<typeof Args>;

/** Max goal rows in the card; the rest live on the /goals screen. */
const MAX_ROWS = 6;

/** Whole-day difference between a YYYY-MM-DD due date and today, in UTC.
 *  Positive = upcoming, 0 = today, negative = overdue. Single source of
 *  truth for both dDayLabel and daysLeft. */
function dayDiff(dueDate: string, now: Date): number {
  const due = new Date(`${dueDate}T00:00:00.000Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due - today) / 86_400_000);
}

/** Build a D-day label from a YYYY-MM-DD due date relative to today
 *  (UTC). "D-42" upcoming, "D-DAY" today, "D+3" overdue. */
export function dDayLabel(dueDate: string, now: Date = new Date()): string {
  const days = dayDiff(dueDate, now);
  if (days > 0) return `D-${days}`;
  if (days === 0) return "D-DAY";
  return `D+${-days}`;
}

export function daysLeft(dueDate: string, now: Date = new Date()): number {
  return dayDiff(dueDate, now);
}

export const listGoals: ToolDef<
  Args,
  { goals: GoalDTO[]; block?: PresentationBlock }
> = {
  name: "listGoals",
  description:
    "Show the user's savings goals — each with progress (saved/target), a percent bar, and a D-day until the due date. Savings are COMPUTED automatically from staying under budget; there is no manual deposit. Returns no card when the user has no goals (say they can set one up).",
  args: Args,
  async run(ctx, _args) {
    const [goals, workspace] = await Promise.all([
      listGoalsWithSavings(ctx.workspaceId),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);
    if (goals.length === 0) return { goals };

    const shown = goals.slice(0, MAX_ROWS);
    const rows = shown.map((g) => {
      const saved = parseFloat(g.savedAmount);
      const target = parseFloat(g.targetAmount);
      return {
        id: g.id,
        title: g.title,
        saved: g.savedAmount,
        target: g.targetAmount,
        bar_pct: target > 0 ? Number(((saved / target) * 100).toFixed(2)) : 0,
        over: saved > target,
        due_label: dDayLabel(g.dueDate),
        icon: g.icon,
        color: g.color,
      };
    });

    const block: PresentationBlock = {
      type: "goals_list",
      title: "Goals",
      currency: workspace.currency,
      rows,
      ...(goals.length > shown.length
        ? { footer: `+${goals.length - shown.length} more · See all goals` }
        : { footer: "See all goals" }),
    };
    return { goals, block };
  },
};
