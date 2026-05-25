import { z } from "zod";

// Mirrors apps/api/src/routes/goals.ts.

export const GOAL_TITLE_MAX_LEN = 80;
export const GOAL_DESCRIPTION_MAX_LEN = 280;
export const GOAL_MAX_AMOUNT = 9_999_999.99;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Minimum due date: today + 1 calendar month (UTC). Overflow guard:
 *  Jan 31 + 1m → Feb 31 → Mar 3 (JS auto-rolls). Clamp to last day of
 *  intended target month so the user-visible rule stays "next month,
 *  same day or last day of that month if shorter". Exported so mobile
 *  date pickers can use the same source of truth. */
export function minDueDateOneMonthUTC(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const t = new Date(Date.UTC(y, m + 1, d, 0, 0, 0, 0));
  if (t.getUTCMonth() !== (m + 1) % 12) {
    t.setUTCDate(0); // clamp to last day of intended target month
  }
  return t;
}

const DueDateMinOneMonth = DateOnly.refine(
  (s) => {
    const dueDate = new Date(`${s}T00:00:00.000Z`);
    return dueDate.getTime() >= minDueDateOneMonthUTC().getTime();
  },
  { message: "dueDate must be at least 1 calendar month from today" },
);

export const CreateGoalBody = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
  targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT),
  savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
  dueDate: DueDateMinOneMonth,
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchGoalBody = z
  .object({
    title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
    targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
    dueDate: DueDateMinOneMonth.optional(),
    icon: z.string().max(40).optional().nullable(),
    color: z.string().max(20).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .strict();

export type CreateGoalInput = z.infer<typeof CreateGoalBody>;
export type PatchGoalInput = z.infer<typeof PatchGoalBody>;
