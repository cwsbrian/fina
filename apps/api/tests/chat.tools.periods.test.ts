import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { basicPeriodRange, comparisonRanges, reviewPeriodRange } from "../src/chat/tools/periods.js";

describe("periods helpers", () => {
  let userId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({
      data: { id: `pr-${Date.now()}`, email: `pr-${Date.now()}@t.co`, name: "PR", tz: "America/Toronto" },
    });
    userId = u.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("basicPeriodRange this_month covers the calendar month in user tz", async () => {
    // 2026-03-15 12:00 UTC = 2026-03-15 08:00 in America/Toronto (EDT)
    const now = new Date("2026-03-15T12:00:00Z");
    const r = await basicPeriodRange(userId, "this_month", now);
    // March 1 00:00 EST = March 1 05:00 UTC
    expect(r.gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    // April 1 00:00 EDT = April 1 04:00 UTC
    expect(r.lt.toISOString()).toBe("2026-04-01T04:00:00.000Z");
  });

  it("basicPeriodRange last_month covers the previous calendar month", async () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const r = await basicPeriodRange(userId, "last_month", now);
    expect(r.gte.toISOString()).toBe("2026-02-01T05:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("basicPeriodRange this_week starts on Monday in user tz", async () => {
    // 2026-03-18 is a Wednesday
    const now = new Date("2026-03-18T15:00:00Z");
    const r = await basicPeriodRange(userId, "this_week", now);
    // Monday 2026-03-16 00:00 EDT = 2026-03-16 04:00 UTC
    expect(r.gte.toISOString()).toBe("2026-03-16T04:00:00.000Z");
    // Next Monday 2026-03-23 00:00 EDT
    expect(r.lt.toISOString()).toBe("2026-03-23T04:00:00.000Z");
  });

  it("reviewPeriodRange all_time returns empty range", async () => {
    const r = await reviewPeriodRange(userId, "all_time");
    expect(r.gte).toBeUndefined();
    expect(r.lt).toBeUndefined();
  });

  it("comparisonRanges this_month + last_month returns adjacent months", async () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const r = await comparisonRanges(userId, "this_month", "last_month", now);
    expect(r.current.gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(r.comparison.gte.toISOString()).toBe("2026-02-01T05:00:00.000Z");
    expect(r.comparison.lt.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("comparisonRanges this_week + previous_week returns adjacent weeks", async () => {
    const now = new Date("2026-03-18T15:00:00Z");
    const r = await comparisonRanges(userId, "this_week", "previous_week", now);
    expect(r.current.gte.toISOString()).toBe("2026-03-16T04:00:00.000Z");
    expect(r.comparison.gte.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(r.comparison.lt.toISOString()).toBe("2026-03-16T04:00:00.000Z");
  });

  it("falls back to America/Toronto when user tz is invalid", async () => {
    await prisma.user.update({ where: { id: userId }, data: { tz: "Not/A/Zone" } });
    const now = new Date("2026-03-15T12:00:00Z");
    const r = await basicPeriodRange(userId, "this_month", now);
    expect(r.gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("falls back to America/Toronto when user is missing", async () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const r = await basicPeriodRange("does-not-exist", "this_month", now);
    expect(r.gte.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });

  it("basicPeriodRange this_week spans DST spring-forward (Toronto switches to EDT on 2026-03-08)", async () => {
    // now = Sunday March 8 (DST day) 12:00 UTC = ~08:00 EDT. Week starts Mon March 2 (pre-DST EST),
    // ends next Mon March 9 (post-DST EDT). The 7-local-day window has only 167 elapsed hours.
    const now = new Date("2026-03-08T12:00:00Z");
    const r = await basicPeriodRange(userId, "this_week", now);
    expect(r.gte.toISOString()).toBe("2026-03-02T05:00:00.000Z"); // Mon 00:00 EST
    expect(r.lt.toISOString()).toBe("2026-03-09T04:00:00.000Z"); // next Mon 00:00 EDT
  });

  it("comparisonRanges previous_week is 7 local calendar days, not 168 elapsed hours, across DST", async () => {
    // Tue March 10 is in the post-DST week (Mon March 9 - Mon March 16). Previous week is
    // pre-DST (Mon March 2 - Mon March 9). Naive 168h math would land previous_week.gte on
    // 2026-03-01T05:00:00Z (Sun) instead of 2026-03-02T05:00:00Z (Mon).
    const now = new Date("2026-03-10T12:00:00Z");
    const r = await comparisonRanges(userId, "this_week", "previous_week", now);
    expect(r.current.gte.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(r.current.lt.toISOString()).toBe("2026-03-16T04:00:00.000Z");
    expect(r.comparison.gte.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    expect(r.comparison.lt.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("lookbackMonthStart returns the user-local first-of-month converted to UTC", async () => {
    const { lookbackMonthStart, dateKeyInTz } = await import("../src/chat/tools/periods.js");
    const now = new Date("2026-05-15T12:00:00Z");
    // 6-month window ending in May 2026 → starts Dec 2025 in Toronto (EST UTC-5).
    const start = await lookbackMonthStart(userId, 6, now);
    expect(start.toISOString()).toBe("2025-12-01T05:00:00.000Z");
    // dateKeyInTz: 2026-05-01 03:00 UTC = 2026-04-30 23:00 EDT
    expect(dateKeyInTz(new Date("2026-05-01T03:00:00Z"), "America/Toronto")).toBe("2026-04-30");
  });
});
