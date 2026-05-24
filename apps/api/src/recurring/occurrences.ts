import type { Cadence } from "@fina/shared";

/** Step a date forward by one cadence period. UTC arithmetic so the
 *  caller controls timezone interpretation. */
export function nextOccurrence(d: Date, cadence: Cadence): Date {
  const out = new Date(d);
  switch (cadence) {
    case "monthly":
      out.setUTCMonth(out.getUTCMonth() + 1);
      break;
    case "yearly":
      out.setUTCFullYear(out.getUTCFullYear() + 1);
      break;
    case "biweekly":
      out.setUTCDate(out.getUTCDate() + 14);
      break;
    case "weekly":
      out.setUTCDate(out.getUTCDate() + 7);
      break;
    case "semimonthly":
      // "Twice a month" — approximate by stepping 15 days. Cleaner
      // semimonthly anchoring (1st/15th) needs an anchor column we
      // don't have yet; the 15-day step is close enough and keeps
      // the cadence stable.
      out.setUTCDate(out.getUTCDate() + 15);
      break;
  }
  return out;
}

/** All occurrences of a recurring expense in the half-open range
 *  [from, to). Starts from `start` (the stored nextOccurrenceDate),
 *  walks forward until past `to`, returning every date that falls
 *  inside the range. Safe even if `start` is in the past relative
 *  to `from` — it advances until catching up. */
export function occurrencesInRange(
  start: Date,
  cadence: Cadence,
  from: Date,
  to: Date,
): Date[] {
  if (!(to > from)) return [];
  const out: Date[] = [];
  let cur = new Date(start);
  // Catch up if the stored next-date is older than the range.
  // Guard against pathological infinite loops with a hard cap.
  let safety = 0;
  while (cur < from && safety < 10_000) {
    cur = nextOccurrence(cur, cadence);
    safety++;
  }
  safety = 0;
  while (cur < to && safety < 10_000) {
    out.push(new Date(cur));
    cur = nextOccurrence(cur, cadence);
    safety++;
  }
  return out;
}

/** Amortize the cadence amount to a monthly equivalent — used in the
 *  Subscriptions hero so weekly/yearly subs are comparable. Numbers
 *  match common payroll/accounting conventions:
 *    monthly     × 1
 *    semimonthly × 2     (twice a month)
 *    biweekly    × 26/12 (26 periods per year ÷ 12 months)
 *    weekly      × 52/12 (52 weeks per year ÷ 12 months)
 *    yearly      ÷ 12
 */
export function monthlyEquivalent(
  amount: number,
  cadence: Cadence,
): number {
  switch (cadence) {
    case "monthly":
      return amount;
    case "semimonthly":
      return amount * 2;
    case "biweekly":
      return (amount * 26) / 12;
    case "weekly":
      return (amount * 52) / 12;
    case "yearly":
      return amount / 12;
  }
}
