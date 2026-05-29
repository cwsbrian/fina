import { describe, it, expect } from "vitest";
import { trialRevertsTo } from "./tier.js";

describe("trialRevertsTo", () => {
  it("trial + lite sub → 'lite'", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "lite", pendingTier: null } }),
    ).toBe("lite");
  });
  it("trial + pro sub → null (staying Pro is not a downgrade)", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: null } }),
    ).toBeNull();
  });
  it("follows pendingTier when a change is scheduled (pro now, lite queued)", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: "lite" } }),
    ).toBe("lite");
  });
  it("ignores a pendingTier equal to the current tier", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "lite", pendingTier: "lite" } }),
    ).toBe("lite");
  });
  it("returns null when an upgrade to pro is scheduled during the trial", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "lite", pendingTier: "pro" } }),
    ).toBeNull();
  });
  it("trial + no sub → null", () => {
    expect(trialRevertsTo({ trial: { active: true }, subscription: null })).toBeNull();
  });
  it("no trial → null", () => {
    expect(
      trialRevertsTo({ trial: { active: false }, subscription: { tier: "lite", pendingTier: null } }),
    ).toBeNull();
  });
});
