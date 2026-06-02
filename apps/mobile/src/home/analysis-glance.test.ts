import { describe, expect, it } from "vitest";

import {
  analysisGlanceTitle,
  parseYearMonthFromAnalysisLabel,
  shouldShowAnalysisGlance,
} from "./analysis-glance";

describe("shouldShowAnalysisGlance", () => {
  it("shows analysis when spending exists even if net is zero", () => {
    expect(
      shouldShowAnalysisGlance({
        label: "May 2026",
        income: 100,
        spend: 100,
        net: 0,
        prevNet: null,
      }),
    ).toBe(true);
  });

  it("hides analysis when there is no monthly activity", () => {
    expect(shouldShowAnalysisGlance(null)).toBe(false);
    expect(
      shouldShowAnalysisGlance({
        label: "June 2026",
        income: 0,
        spend: 0,
        net: 0,
        prevNet: null,
      }),
    ).toBe(false);
  });

  it("uses the analysis response month label for the home title", () => {
    expect(
      analysisGlanceTitle({
        label: "May 2026",
        income: 100,
        spend: 20,
        net: 80,
        prevNet: null,
      }),
    ).toBe("May 2026");
  });

  it("parses year/month from a month label", () => {
    expect(parseYearMonthFromAnalysisLabel("May 2026")).toEqual({
      year: 2026,
      month: 5,
    });
  });
});
