import { z } from "zod";
import { BUDGET_PERIODS } from "../enums.js";

// Mirrors apps/api/src/routes/budgets.ts. Amount intentionally NOT
// constrained here — the service emits `invalid_amount` for 0/neg/cap
// (frontend should validateAmount() with the shared helper for UI gating).

export const BudgetPeriodEnum = z.enum(BUDGET_PERIODS);

export const SetBudgetBody = z.object({
  categoryId: z.string().min(1),
  amount: z.number(),
  period: BudgetPeriodEnum,
});

export type SetBudgetInput = z.infer<typeof SetBudgetBody>;
