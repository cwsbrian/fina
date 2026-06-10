import { describe, it, expect } from "vitest";
import { isPaidFeatureTier, isProFeature, TIER_LIMITS, trialRevertsTo } from "./tier.js";

describe("trialRevertsTo", () => {
  it("trial + pro sub → pro", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: null } }),
    ).toBe("pro");
  });
  it("trial + max sub → max", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "max", pendingTier: null } }),
    ).toBe("max");
  });
  it("follows pendingTier when a change is scheduled (max now, pro queued)", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "max", pendingTier: "pro" } }),
    ).toBe("pro");
  });
  it("ignores a pendingTier equal to the current tier", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: "pro" } }),
    ).toBe("pro");
  });
  it("returns max when an upgrade to max is scheduled during the trial", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: "max" } }),
    ).toBe("max");
  });
  it("trial + no sub → null", () => {
    expect(trialRevertsTo({ trial: { active: true }, subscription: null })).toBeNull();
  });
  it("no trial → null", () => {
    expect(
      trialRevertsTo({ trial: { active: false }, subscription: { tier: "pro", pendingTier: null } }),
    ).toBeNull();
  });
});

describe("TIER_LIMITS", () => {
  it("keeps Pro paid-feature access with standard internal AI allowance", () => {
    expect(TIER_LIMITS.pro).toEqual({ plaidItems: 5, weeklyLlmBudgetCad: 0.5 });
    expect(isPaidFeatureTier("pro")).toBe(true);
  });

  it("keeps Max paid-feature access with expanded internal AI allowance", () => {
    expect(TIER_LIMITS.max).toEqual({ plaidItems: 20, weeklyLlmBudgetCad: 2 });
    expect(isPaidFeatureTier("max")).toBe(true);
  });

  it("does not mark AI features as Pro-exclusive anymore", () => {
    expect(isProFeature("chat_input")).toBe(false);
    expect(isPaidFeatureTier("free")).toBe(false);
  });
});
