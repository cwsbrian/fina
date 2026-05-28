import { DEFAULT_TZ } from "@fina/shared";
import { prisma } from "../../db.js";

export type BasicPeriod = "today" | "this_week" | "this_month" | "last_month";
export type ReviewPeriod = BasicPeriod | "all_time";
export type CurrentPeriod = "this_week" | "this_month";
export type ComparisonPeriod = "previous_week" | "last_month";

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function resolveUserTz(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tz: true } });
  const tz = user?.tz ?? DEFAULT_TZ;
  return isValidTz(tz) ? tz : DEFAULT_TZ;
}

/** Synchronous tz resolution — pass the user's already-loaded tz string;
 *  returns DEFAULT_TZ if it's missing or no longer in the IANA list.
 *  Used by hot paths (cron) that already have user.tz in scope and
 *  don't want an extra DB query per candidate. */
export function resolveTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  return isValidTz(tz) ? tz : DEFAULT_TZ;
}

export type Parts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
};

export function partsInTz(instant: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl can return "24" for midnight on some platforms; normalize to 0.
  let hour = Number(out.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: out.weekday ? weekdayMap[out.weekday] ?? 0 : 0,
    hour,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

// Compute the UTC instant corresponding to (year, month, day, 00:00:00) interpreted in `tz`.
// Starts with the desired wall-time read as UTC, then iteratively shifts by the delta
// between the wanted wall time and the wall time the current guess actually produces in `tz`.
// Converges in at most 2 iterations across any IANA zone, including DST transitions.
export function localMidnightToUtc(year: number, month: number, day: number, tz: string): Date {
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const got = partsInTz(new Date(utc), tz);
    const wantWallMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    const gotWallMs = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second);
    const delta = wantWallMs - gotWallMs;
    if (delta === 0) return new Date(utc);
    utc += delta;
  }
  return new Date(utc);
}

function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function startOfMonth(year: number, month: number, tz: string): Date {
  return localMidnightToUtc(year, month, 1, tz);
}

// Local calendar-day arithmetic: do the day-overflow at the UTC-civil level via Date.UTC
// (which handles month/year overflow), then convert the resulting civil Y/M/D to a UTC
// instant by interpreting it as midnight in `tz`. Reading civil fields back from `Date`
// (not from `partsInTz`) avoids an off-by-one error in UTC+13/+14 zones, where any
// hour-of-day anchor in UTC can already be the next calendar day locally.
function startOfWeek(year: number, month: number, day: number, weekday: number, tz: string): Date {
  const back = (weekday + 6) % 7; // Sun=0 → 6, Mon=1 → 0, ...
  const civil = new Date(Date.UTC(year, month - 1, day - back));
  return localMidnightToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), tz);
}

function addDaysLocal(d: Date, n: number, tz: string): Date {
  const p = partsInTz(d, tz);
  const civil = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return localMidnightToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), tz);
}

// Public helper: first day, in the user's timezone, of the calendar month that begins
// a `lookbackMonths`-month window ending in the month containing `now` (inclusive).
// Example: lookbackMonths=6, now in May → December previous year. Returned as a UTC instant.
export async function lookbackMonthStart(
  userId: string,
  lookbackMonths: number,
  now: Date = new Date(),
): Promise<Date> {
  const tz = await resolveUserTz(userId);
  const p = partsInTz(now, tz);
  let y = p.year;
  let m = p.month - (lookbackMonths - 1);
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return startOfMonth(y, m, tz);
}

// Public helper: format a UTC instant as YYYY-MM-DD in the user's timezone. Used by getCashflowSummary.
export function dateKeyInTz(instant: Date, tz: string): string {
  const p = partsInTz(instant, tz);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

export async function basicPeriodRange(
  userId: string,
  period: BasicPeriod,
  now: Date = new Date(),
): Promise<{ gte: Date; lt: Date }> {
  const tz = await resolveUserTz(userId);
  const p = partsInTz(now, tz);
  if (period === "today") {
    const gte = localMidnightToUtc(p.year, p.month, p.day, tz);
    return { gte, lt: addDaysLocal(gte, 1, tz) };
  }
  if (period === "this_month") {
    const gte = startOfMonth(p.year, p.month, tz);
    const next = nextMonth(p.year, p.month);
    return { gte, lt: startOfMonth(next.year, next.month, tz) };
  }
  if (period === "last_month") {
    const prev = prevMonth(p.year, p.month);
    return { gte: startOfMonth(prev.year, prev.month, tz), lt: startOfMonth(p.year, p.month, tz) };
  }
  // this_week
  const gte = startOfWeek(p.year, p.month, p.day, p.weekday, tz);
  return { gte, lt: addDaysLocal(gte, 7, tz) };
}

export async function reviewPeriodRange(
  userId: string,
  period: ReviewPeriod,
  now: Date = new Date(),
): Promise<{ gte?: Date; lt?: Date }> {
  if (period === "all_time") return {};
  return basicPeriodRange(userId, period, now);
}

export async function comparisonRanges(
  userId: string,
  currentPeriod: CurrentPeriod,
  comparisonPeriod: ComparisonPeriod,
  now: Date = new Date(),
): Promise<{ current: { gte: Date; lt: Date }; comparison: { gte: Date; lt: Date } }> {
  if (currentPeriod === "this_month" && comparisonPeriod === "last_month") {
    const current = await basicPeriodRange(userId, "this_month", now);
    const comparison = await basicPeriodRange(userId, "last_month", now);
    return { current, comparison };
  }
  if (currentPeriod === "this_week" && comparisonPeriod === "previous_week") {
    const current = await basicPeriodRange(userId, "this_week", now);
    const tz = await resolveUserTz(userId);
    const comparisonGte = addDaysLocal(current.gte, -7, tz);
    return { current, comparison: { gte: comparisonGte, lt: current.gte } };
  }
  throw new Error("invalid_period_pair");
}

/** Range from YYYY-MM-DD `since` (inclusive) to YYYY-MM-DD `until` (exclusive),
 *  both interpreted as local midnight in the user's timezone. Powers the
 *  flexible date inputs on getSpendingSummary, getCategoryBreakdown,
 *  getCashflowSummary, and compareSpendingPeriods — the LLM converts
 *  natural language ("올해", "지난 90일", "Q1") to ISO date keys and the
 *  tool just queries.
 *
 *  Validation throws Error('invalid_date_format') on malformed inputs and
 *  Error('invalid_date_range') when until <= since. Callers should let
 *  these propagate; the chat dispatcher surfaces them as tool errors
 *  the model can react to. */
export async function customRange(
  userId: string,
  since: string,
  until: string,
): Promise<{ gte: Date; lt: Date }> {
  // Per-arg validation so the error tells the LLM exactly which date to
  // fix — important for compareSpendingPeriods which takes 4 date keys.
  if (!isIsoDate(since)) {
    throw new Error(`invalid_date_format: since=${JSON.stringify(since)}`);
  }
  if (!isIsoDate(until)) {
    throw new Error(`invalid_date_format: until=${JSON.stringify(until)}`);
  }
  const tz = await resolveUserTz(userId);
  const [sy, sm, sd] = since.split("-").map(Number) as [number, number, number];
  const [uy, um, ud] = until.split("-").map(Number) as [number, number, number];
  const gte = localMidnightToUtc(sy, sm, sd, tz);
  const lt = localMidnightToUtc(uy, um, ud, tz);
  if (lt.getTime() <= gte.getTime()) {
    throw new Error(
      `invalid_date_range: until (${until}) must be strictly greater than since (${since})`,
    );
  }
  return { gte, lt };
}

function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Round-trip via Date.UTC to reject e.g. 2026-02-30.
  const trial = new Date(Date.UTC(y, m - 1, d));
  return (
    trial.getUTCFullYear() === y &&
    trial.getUTCMonth() === m - 1 &&
    trial.getUTCDate() === d
  );
}

/** Shared description fragments for `since` / `until` zod args across all
 *  flexible-date tools. Keep these in one place so descriptions stay
 *  consistent — the LLM uses them when deciding tool args, and per-tool
 *  divergence causes ambiguous behaviour. */
export const SINCE_ARG_DESC =
  "Inclusive start date (YYYY-MM-DD) in the user's timezone. " +
  "Translate user phrases to a specific ISO date using the 'Today' anchor in " +
  "your context — see the 'Date inputs' section of the system prompt for the " +
  "phrase → date mapping table.";

export const UNTIL_ARG_DESC =
  "Exclusive end date (YYYY-MM-DD) in the user's timezone. " +
  "For 'this month' use the first day of NEXT month; for '올해' use NEXT year's " +
  "January 1. until must be strictly greater than since.";

/** Today's date key (YYYY-MM-DD) in the user's timezone. Cheap helper for
 *  buildFinancialContext to inject into the system prompt so the LLM can
 *  resolve "이번달" / "this week" to specific ISO dates without guessing. */
export async function todayKeyInTz(
  userId: string,
  now: Date = new Date(),
): Promise<{ today: string; tz: string }> {
  const tz = await resolveUserTz(userId);
  return { today: dateKeyInTz(now, tz), tz };
}

// Public: first day of the calendar month at `monthsOffset` from the user's
// "now" (interpreted in their tz). Returns Date at 12:00:00.000Z on the
// first-of-month so the @db.Date column receives the right calendar date
// across UTC-11..+11 zones (matches 1E-time's UTC-noon storage policy).
export async function firstOfMonthDateInTz(
  userId: string,
  monthsOffset: number,
  now: Date = new Date(),
): Promise<Date> {
  const tz = await resolveUserTz(userId);
  const p = partsInTz(now, tz);
  let y = p.year;
  let m = p.month + monthsOffset;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  const mm = String(m).padStart(2, "0");
  return new Date(`${y}-${mm}-01T12:00:00.000Z`);
}
