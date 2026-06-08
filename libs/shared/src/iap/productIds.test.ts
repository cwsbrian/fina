import { describe, it, expect } from "vitest";
import { IAP_PRODUCT_IDS, tierForIapProductId, iapProductIdForTier, type IAPProductId } from "./productIds.js";

describe("IAP_PRODUCT_IDS", () => {
  it("maps pro_monthly → pro", () => {
    expect(IAP_PRODUCT_IDS.pro_monthly.tier).toBe("pro");
  });
  it("maps max_monthly → max", () => {
    expect(IAP_PRODUCT_IDS.max_monthly.tier).toBe("max");
  });
  it("tierForIapProductId returns tier for known id", () => {
    expect(tierForIapProductId("pro_monthly")).toBe("pro");
    expect(tierForIapProductId("max_monthly")).toBe("max");
  });
  it("tierForIapProductId returns null for unknown id", () => {
    expect(tierForIapProductId("nonsense" as IAPProductId)).toBeNull();
  });
  it("iapProductIdForTier is the inverse of tierForIapProductId", () => {
    expect(iapProductIdForTier("pro")).toBe("pro_monthly");
    expect(iapProductIdForTier("max")).toBe("max_monthly");
  });
});
