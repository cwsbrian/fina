import { describe, expect, it } from "vitest";
import { formatPeriodLabel } from "../src/chat/tools/recap-label.js";

// Confirms the five documented label shapes plus the December → January
// year-rollover edge case + the off-by-one boundary on "exclusive until".
describe("formatPeriodLabel", () => {
  it("full month → '<Month> YYYY'", () => {
    expect(formatPeriodLabel("2026-05-01", "2026-06-01")).toBe("May 2026");
  });

  it("full month at year boundary (Dec → next Jan)", () => {
    expect(formatPeriodLabel("2025-12-01", "2026-01-01")).toBe("December 2025");
  });

  it("full year → 'YYYY'", () => {
    expect(formatPeriodLabel("2026-01-01", "2027-01-01")).toBe("2026");
  });

  it("partial within same calendar month → '<Month> D — <Month> D, YYYY' (until exclusive)", () => {
    // until=2026-05-28 means last included day is the 27th
    expect(formatPeriodLabel("2026-05-01", "2026-05-28")).toBe(
      "May 1 — May 27, 2026",
    );
  });

  it("spans months within the same year → 'Mon D — Mon D, YYYY'", () => {
    expect(formatPeriodLabel("2026-03-15", "2026-05-15")).toBe(
      "Mar 15 — May 14, 2026",
    );
  });

  it("spans calendar years → 'Mon D, YYYY — Mon D, YYYY'", () => {
    expect(formatPeriodLabel("2025-12-15", "2026-01-15")).toBe(
      "Dec 15, 2025 — Jan 14, 2026",
    );
  });

  it("falls back gracefully on malformed input", () => {
    expect(formatPeriodLabel("hello", "world")).toBe("hello — world");
  });

  it("does not misfire full-month detector on partial month", () => {
    // since=2026-05-01 but until=2026-05-31 (NOT first of next month)
    // — should render as same-month partial, not 'May 2026'.
    expect(formatPeriodLabel("2026-05-01", "2026-05-31")).toBe(
      "May 1 — May 30, 2026",
    );
  });
});
