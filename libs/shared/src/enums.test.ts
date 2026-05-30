import { describe, expect, it } from "vitest";
import { RISK_TIERS, type RiskTier } from "./enums.js";

describe("RISK_TIERS", () => {
  it("lists the four forecast severity tiers in increasing-risk order", () => {
    expect(RISK_TIERS).toEqual([
      "on_track",
      "watch",
      "at_risk",
      "insufficient_history",
    ]);
    const t: RiskTier = "at_risk";
    expect(RISK_TIERS).toContain(t);
  });
});
