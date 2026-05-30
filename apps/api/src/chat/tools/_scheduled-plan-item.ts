import { z } from "zod";
import { isValidAmount } from "@fina/shared";

/** Shared item shape for the batch executor AND the plan presenter so the two
 *  can never drift. amount uses the SAME money contract as validateAmount
 *  (AMOUNT_RE: <=2 decimals, in range) — a 3-decimal amount fails HERE, at
 *  card-creation, not later as a burned-intent consume failure. */
export const ScheduledPlanItem = z.object({
  category: z.string().min(1).max(80).describe("Category name (case-insensitive)"),
  amount: z.number().positive().refine(isValidAmount, "amount must have at most 2 decimals and be in range"),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});
export type ScheduledPlanItemT = z.infer<typeof ScheduledPlanItem>;
