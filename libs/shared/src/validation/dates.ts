// Date validation — strict YYYY-MM-DD parsing anchored to UTC noon (matches
// the API's Plaid sync + transaction storage policy).

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO 8601 with time + Z suffix (or ±offset). Strict enough to reject
 *  partial forms like "2026-05-23T12:00" (missing tz). */
export const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export type DateValidationCode = "invalid_date";

export class DateValidationError extends Error {
  readonly code: DateValidationCode;
  constructor() {
    super("invalid_date");
    this.name = "DateValidationError";
    this.code = "invalid_date";
  }
}

/** Parses either:
 *  - `YYYY-MM-DD` → anchored to UTC noon (legacy Plaid policy)
 *  - Full ISO 8601 instant with tz (e.g. `2026-05-23T19:32:00.000Z`) →
 *    parsed at that exact moment (manual tx with user-chosen time)
 *
 *  Throws `DateValidationError` on wrong shape or non-existent calendar
 *  date. */
export function parseOccurredAt(s: string): Date {
  if (DATE_RE.test(s)) {
    const d = new Date(s + "T12:00:00Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new DateValidationError();
    }
    return d;
  }
  if (ISO_INSTANT_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new DateValidationError();
    return d;
  }
  throw new DateValidationError();
}

/** Boolean variant for UI gating (does NOT throw). Accepts the same two
 *  formats as `parseOccurredAt`. */
export function isValidDate(s: unknown): boolean {
  if (typeof s !== "string") return false;
  if (DATE_RE.test(s)) {
    const d = new Date(s + "T12:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  if (ISO_INSTANT_RE.test(s)) {
    return !Number.isNaN(new Date(s).getTime());
  }
  return false;
}
