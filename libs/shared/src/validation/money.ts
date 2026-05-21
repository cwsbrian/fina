// Money validation — single source of truth for amount limits, regex, and
// the structured error code. Used both by API services and frontend forms.

/** Hard cap for any monetary amount. Anything above this is rejected.
 *  Transaction.amount + Budget.amount + RecurringExpense.amount + ScheduledSpend.amount
 *  are all `Decimal(14, 2)` — this cap is the largest value that fits. */
export const MAX_AMOUNT = 999_999_999.99;

/** Cents-only positive decimal. Rejects scientific notation, negatives,
 *  and >2 decimal places. */
export const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export type MoneyValidationCode = "invalid_amount";

export class MoneyValidationError extends Error {
  readonly code: MoneyValidationCode;
  constructor(code: MoneyValidationCode = "invalid_amount") {
    super(code);
    this.name = "MoneyValidationError";
    this.code = code;
  }
}

/** Throws `MoneyValidationError("invalid_amount")` on:
 *  - non-finite (NaN, Infinity)
 *  - non-positive (≤ 0)
 *  - > MAX_AMOUNT
 *  - more than 2 decimal places or scientific notation */
export function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new MoneyValidationError();
  }
  if (!AMOUNT_RE.test(String(amount))) {
    throw new MoneyValidationError();
  }
}

/** Boolean variant for UI gating (does NOT throw). */
export function isValidAmount(amount: unknown): boolean {
  if (typeof amount !== "number") return false;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return false;
  return AMOUNT_RE.test(String(amount));
}
