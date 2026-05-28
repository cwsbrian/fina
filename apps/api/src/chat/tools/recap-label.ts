/** Render a since/until date pair as a human-readable period label for the
 *  recap card subtitle. Recognises common shapes (full month, full year,
 *  full week) and falls back to "May 1 — May 27, 2026" for everything else.
 *
 *  Both inputs are YYYY-MM-DD with `until` exclusive. We don't need user
 *  timezone here — the labels are calendar-day shapes derived from the
 *  numeric date keys directly. */
export function formatPeriodLabel(since: string, until: string): string {
  // Robustness — if anything malformed slips past zod, return the raw
  // pair rather than throwing. The card still renders; only the
  // pretty label degrades.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return `${since} — ${until}`;
  }
  const [sy, sm, sd] = since.split("-").map(Number) as [number, number, number];
  const [uy, um, ud] = until.split("-").map(Number) as [number, number, number];

  // until is exclusive — convert to the last DAY actually included so the
  // shape detectors compare like calendars.
  const lastDay = prevDay(uy, um, ud);

  // Full-year shape: since=YYYY-01-01, until=(YYYY+1)-01-01.
  if (
    sm === 1 && sd === 1 &&
    um === 1 && ud === 1 &&
    uy === sy + 1
  ) {
    return `${sy}`;
  }

  // Full-month shape: since=YYYY-MM-01, until = first day of next month.
  if (sd === 1 && ud === 1 && (uy === sy && um === sm + 1 || um === 1 && uy === sy + 1 && sm === 12)) {
    return `${monthName(sm)} ${sy}`;
  }

  // Same calendar month, partial: "May 1 — May 27, 2026"
  if (sy === lastDay.y && sm === lastDay.m) {
    return `${monthName(sm)} ${sd} — ${monthName(lastDay.m)} ${lastDay.d}, ${sy}`;
  }

  // Spans months but same year: "Mar 15 — May 14, 2026"
  if (sy === lastDay.y) {
    return `${monthShort(sm)} ${sd} — ${monthShort(lastDay.m)} ${lastDay.d}, ${sy}`;
  }

  // Spans years: "Dec 15, 2025 — Jan 14, 2026"
  return `${monthShort(sm)} ${sd}, ${sy} — ${monthShort(lastDay.m)} ${lastDay.d}, ${lastDay.y}`;
}

function prevDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthName(m: number): string {
  return MONTH_NAMES[m - 1] ?? `Month ${m}`;
}

function monthShort(m: number): string {
  return monthName(m).slice(0, 3);
}
