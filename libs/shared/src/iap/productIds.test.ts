import { describe, it, expect } from "vitest";
import { IAP_PRODUCT_IDS, tierForIapProductId, iapProductIdForTier, type IAPProductId } from "./productIds.js";

describe("IAP_PRODUCT_IDS", () => {
  it("maps lite_monthly → lite", () => {
    expect(IAP_PRODUCT_IDS.lite_monthly.tier).toBe("lite");
  });
  it("maps pro_monthly → pro", () => {
    expect(IAP_PRODUCT_IDS.pro_monthly.tier).toBe("pro");
  });
  it("tierForIapProductId returns tier for known id", () => {
    expect(tierForIapProductId("lite_monthly")).toBe("lite");
    expect(tierForIapProductId("pro_monthly")).toBe("pro");
  });
  it("tierForIapProductId returns null for unknown id", () => {
    expect(tierForIapProductId("nonsense" as IAPProductId)).toBeNull();
  });
  it("iapProductIdForTier is the inverse of tierForIapProductId", () => {
    expect(iapProductIdForTier("lite")).toBe("lite_monthly");
    expect(iapProductIdForTier("pro")).toBe("pro_monthly");
  });
});
