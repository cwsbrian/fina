import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_DESCRIPTION_MAX_LEN,
  GOAL_MAX_AMOUNT,
  isDueDateAtLeastOneMonth,
  type GoalDTO,
  type PatchGoalInput,
} from "@fina/shared";
import { patchGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  goal_id: z.string().min(1),
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
  target_amount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isDueDateAtLeastOneMonth, {
      message: "due_date must be at least 1 calendar month from today",
    })
    .optional(),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
});
type Args = z.infer<typeof Args>;

export const updateGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "updateGoal",
  description:
    "Edit an existing goal's title, target_amount, or due_date. Paid-tier only. goal_id comes from a prior goals_list/goal_detail card. due_date (if changed) must be at least one month out. Cannot change saved amount — savings are computed automatically.",
  args: Args,
  async run(ctx, args) {
    // Map provided snake_case args to the service's camelCase fields.
    // Only included keys are patched (omitted fields stay unchanged).
    const patch: PatchGoalInput = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.target_amount !== undefined ? { targetAmount: args.target_amount } : {}),
      ...(args.due_date !== undefined ? { dueDate: args.due_date } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
    };
    const goal = await patchGoalService(ctx.workspaceId, ctx.userId, args.goal_id, patch);
    if (!goal) throw new Error("goal_not_found");
    return { goal };
  },
};
