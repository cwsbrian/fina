import { describe, it, expect } from "vitest";
import { formatShortDate } from "./date.js";

describe("formatShortDate", () => {
  it("formats a locally-constructed Date as short month + day", () => {
    // Local construction + relative assertion → passes in any runner locale,
    // while still exercising the Date (non-string) branch.
    const d = new Date(2026, 5, 24);
    expect(formatShortDate(d)).toBe(
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(formatShortDate(d)).toMatch(/^[A-Za-z]{3,} \d{1,2}$/);
  });
  it("formats an ISO string consistently with the Date path", () => {
    const iso = "2026-06-24T12:00:00.000Z";
    const out = formatShortDate(iso);
    expect(out).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(out).toMatch(/^[A-Za-z]{3,} \d{1,2}$/);
  });
  it("returns empty string for null / undefined / empty / invalid", () => {
    expect(formatShortDate(null)).toBe("");
    expect(formatShortDate(undefined)).toBe("");
    expect(formatShortDate("")).toBe("");
    expect(formatShortDate("not-a-date")).toBe("");
  });
});
