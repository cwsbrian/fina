import { describe, expect, it } from "vitest";

import { analysisRequestPath } from "./request";

describe("analysisRequestPath", () => {
  it("omits year/month when no period is selected so the API can choose the latest month with data", () => {
    expect(analysisRequestPath("ws_1", null)).toBe("/workspaces/ws_1/analysis");
  });

  it("uses an explicit period after the user selects a month", () => {
    expect(analysisRequestPath("ws_1", { year: 2026, month: 5 })).toBe(
      "/workspaces/ws_1/analysis?year=2026&month=5",
    );
  });
});
