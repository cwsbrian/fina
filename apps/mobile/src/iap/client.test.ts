import { describe, expect, it } from "vitest";

import { productIdsForPlatform, productIdsForTier, purchaseFlowTimeoutMessage } from "./products";

describe("IAP client helpers", () => {
  it("checks both known iOS Pro product ids, preferring the current App Store id", () => {
    expect(productIdsForTier("pro", "ios")).toEqual(["fina_pro_monthly", "pro_monthly"]);
  });

  it("keeps Max on the single cross-platform product id", () => {
    expect(productIdsForTier("max", "ios")).toEqual(["max_monthly"]);
    expect(productIdsForTier("max", "android")).toEqual(["max_monthly"]);
  });

  it("uses only current App Store ids for background entitlement checks", () => {
    expect(productIdsForPlatform("ios")).toEqual(["fina_pro_monthly", "max_monthly"]);
  });

  it("uses platform-specific timeout copy", () => {
    expect(purchaseFlowTimeoutMessage("ios")).toContain("App Store");
    expect(purchaseFlowTimeoutMessage("android")).toContain("Google Play");
  });
});
