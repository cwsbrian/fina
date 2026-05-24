import { z } from "zod";

// Mirrors apps/api/src/routes/goals.ts.

export const GOAL_TITLE_MAX_LEN = 80;
export const GOAL_DESCRIPTION_MAX_LEN = 280;
export const GOAL_MAX_AMOUNT = 9_999_999.99;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateGoalBody = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
  targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT),
  savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
  dueDate: DateOnly,
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchGoalBody = z
  .object({
    title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
    targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
    dueDate: DateOnly.optional(),
    icon: z.string().max(40).optional().nullable(),
    color: z.string().max(20).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .strict();

export type CreateGoalInput = z.infer<typeof CreateGoalBody>;
export type PatchGoalInput = z.infer<typeof PatchGoalBody>;
