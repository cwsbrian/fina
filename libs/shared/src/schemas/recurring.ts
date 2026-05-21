import { z } from "zod";
import { CADENCES } from "../enums.js";
import { DATE_RE } from "../validation/dates.js";

// Mirrors apps/api/src/routes/recurring.ts.

export const CadenceEnum = z.enum(CADENCES);

export const PostRecurringBody = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number(),
  cadence: CadenceEnum,
  nextOccurrenceDate: z.string().regex(DATE_RE),
  categoryId: z.string().min(1).optional(),
  merchant: z.string().min(1).max(200).optional(),
});

export type PostRecurringInput = z.infer<typeof PostRecurringBody>;
