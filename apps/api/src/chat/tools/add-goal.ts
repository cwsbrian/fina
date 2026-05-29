import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_DESCRIPTION_MAX_LEN,
  GOAL_MAX_AMOUNT,
  isDueDateAtLeastOneMonth,
  type GoalDTO,
} from "@fina/shared";
import { createGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  target_amount: z.number().positive().max(GOAL_MAX_AMOUNT),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isDueDateAtLeastOneMonth, {
      message: "due_date must be at least 1 calendar month from today",
    }),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
});
type Args = z.infer<typeof Args>;

export const addGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "addGoal",
  description:
    "Create a savings goal. Pro-tier only. target_amount is a number; due_date is YYYY-MM-DD and must be at least one month out. Savings accrue automatically from staying under budget — do NOT promise a manual deposit. Usually issued via presentGoalForm (the form collects/edits the fields), not called directly.",
  args: Args,
  async run(ctx, args) {
    const goal = await createGoalService(ctx.workspaceId, ctx.userId, {
      title: args.title,
      targetAmount: args.target_amount,
      dueDate: args.due_date,
      ...(args.description !== undefined ? { description: args.description } : {}),
    });
    return { goal };
  },
};
