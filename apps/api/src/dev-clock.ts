/** Dev-only clock override for testing time-based features (forecast, runway,
 *  scheduling, 90-day windows). Set `DEV_NOW` to an ISO date/instant
 *  (e.g. `DEV_NOW=2026-05-15`) and the server treats that as "now".
 *
 *  Hard-guarded: ignored when NODE_ENV === "production", and falls back to the
 *  real clock when unset or unparseable. NEVER affects write timestamps — only
 *  the "what day is it" reads in the forecast/schedule paths use this. */
export function serverNow(): Date {
  const override = process.env.DEV_NOW;
  if (override && process.env.NODE_ENV !== "production") {
    const d = new Date(override);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}
