import { describe, expect, it } from "vitest";
import {
  shouldMentionDailyForecast,
  type ForecastAlertState,
} from "../src/cron/jobs/daily-brief.js";

function state(options?: {
  severity?: "on_track" | "watch" | "at_risk";
  overspend?: number;
  category?: string;
  categorySeverity?: "watch" | "at_risk";
  categoryOverspend?: number;
  scheduled?: string[];
}): ForecastAlertState {
  const category = options?.category;
  return {
    version: 1,
    workspaces: [
      {
        id: "workspace-1",
        portfolioSeverity: options?.severity ?? "at_risk",
        portfolioOverspend: options?.overspend ?? 1_500,
        risks: category
          ? [
              {
                category,
                severity: options?.categorySeverity ?? "at_risk",
                overspend: options?.categoryOverspend ?? 300,
              },
            ]
          : [],
        scheduledEvidence: options?.scheduled ?? [],
      },
    ],
  };
}

describe("Daily forecast structured dedupe", () => {
  it("mentions the first state, then suppresses an identical state", () => {
    const current = state({ category: "Shopping" });
    expect(shouldMentionDailyForecast(current, null)).toBe(true);
    expect(shouldMentionDailyForecast(current, structuredClone(current))).toBe(false);
  });

  it("suppresses small amount drift but re-mentions after cumulative change reaches 25%", () => {
    const previous = state({ overspend: 1_500, category: "Shopping" });
    expect(
      shouldMentionDailyForecast(
        state({ overspend: 1_874, category: "Shopping" }),
        previous,
      ),
    ).toBe(false);
    expect(
      shouldMentionDailyForecast(
        state({ overspend: 1_875, category: "Shopping" }),
        previous,
      ),
    ).toBe(true);
  });

  it("re-mentions risk tier, category, and scheduled-evidence changes", () => {
    const previous = state({ category: "Shopping" });
    expect(
      shouldMentionDailyForecast(
        state({ severity: "watch", category: "Shopping" }),
        previous,
      ),
    ).toBe(true);
    expect(
      shouldMentionDailyForecast(state({ category: "Dining" }), previous),
    ).toBe(true);
    expect(
      shouldMentionDailyForecast(
        state({ category: "Shopping", scheduled: ["scheduled|Shopping|50|2026-07-20"] }),
        previous,
      ),
    ).toBe(true);
  });

  it("ignores scheduled-evidence churn when neither state has a risk", () => {
    const previous = state({ severity: "on_track", overspend: 0 });
    const current = state({
      severity: "on_track",
      overspend: 0,
      scheduled: ["scheduled|Housing|100|2026-07-20"],
    });
    expect(shouldMentionDailyForecast(current, previous)).toBe(false);
  });
});
