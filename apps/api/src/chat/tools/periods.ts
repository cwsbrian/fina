import { prisma } from "../../db.js";

export type BasicPeriod = "this_week" | "this_month" | "last_month";
export type ReviewPeriod = BasicPeriod | "all_time";
export type CurrentPeriod = "this_week" | "this_month";
export type ComparisonPeriod = "previous_week" | "last_month";

const DEFAULT_TZ = "America/Toronto";

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

type Parts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTz(instant: Date, tz: string): Parts {
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
function localMidnightToUtc(year: number, month: number, day: number, tz: string): Date {
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

// Local calendar-day arithmetic: anchor at noon UTC of (Y, M, D+n) and read back the
// local Y/M/D in the user's tz. Date.UTC handles month/year overflow. The noon anchor
// keeps us comfortably away from midnight DST transitions in any IANA zone.
function startOfWeek(year: number, month: number, day: number, weekday: number, tz: string): Date {
  const back = (weekday + 6) % 7; // Sun=0 → 6, Mon=1 → 0, ...
  const anchor = new Date(Date.UTC(year, month - 1, day - back, 12, 0, 0));
  const p = partsInTz(anchor, tz);
  return localMidnightToUtc(p.year, p.month, p.day, tz);
}

function addDaysLocal(d: Date, n: number, tz: string): Date {
  const p = partsInTz(d, tz);
  const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day + n, 12, 0, 0));
  const target = partsInTz(anchor, tz);
  return localMidnightToUtc(target.year, target.month, target.day, tz);
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
