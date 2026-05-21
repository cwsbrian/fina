// Date validation — strict YYYY-MM-DD parsing anchored to UTC noon (matches
// the API's Plaid sync + transaction storage policy).

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DateValidationCode = "invalid_date";

export class DateValidationError extends Error {
  readonly code: DateValidationCode;
  constructor() {
    super("invalid_date");
    this.name = "DateValidationError";
    this.code = "invalid_date";
  }
}

/** Parses `YYYY-MM-DD` as UTC noon. Throws `DateValidationError` on:
 *  - wrong shape (regex fail)
 *  - non-existent calendar date (e.g. 2026-02-30) — caught by the
 *    round-trip check `d.toISOString().slice(0,10) === s` */
export function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new DateValidationError();
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new DateValidationError();
  }
  return d;
}

/** Boolean variant for UI gating (does NOT throw). */
export function isValidDate(s: unknown): boolean {
  if (typeof s !== "string") return false;
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
