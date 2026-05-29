// Date-display helpers. Pure; safe from API logging, web UI, and mobile UI
// (RN Hermes supports Intl). Renders in the caller's local timezone — the
// intended UX for "Reverts to … on <date>" / "Next charge <date>" copy.

/** Short month + day, e.g. "Jun 24". Accepts an ISO-8601 string or a Date.
 *  Returns "" for null / undefined / unparseable input so callers can omit
 *  the trailing "on <date>" cleanly. */
export function formatShortDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
