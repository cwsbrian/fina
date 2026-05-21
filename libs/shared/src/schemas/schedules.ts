import { z } from "zod";
import { SCHEDULED_SPEND_LIST_FILTERS } from "../enums.js";

// Mirrors apps/api/src/routes/schedules.ts.

export const ScheduledSpendStatusFilter = z.enum(SCHEDULED_SPEND_LIST_FILTERS);

export const PostScheduledSpendBody = z
  .object({
    categoryId: z.string().min(1),
    amount: z.number(),
    scheduledDate: z.string(),
    note: z.string().optional(),
  })
  .strict();

export const ListScheduledSpendsQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: ScheduledSpendStatusFilter.optional(),
});

export type PostScheduledSpendInput = z.infer<typeof PostScheduledSpendBody>;
export type ListScheduledSpendsInput = z.infer<typeof ListScheduledSpendsQuery>;
