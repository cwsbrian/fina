import { afterEach, describe, expect, it, vi } from "vitest";

import { productIdsForPlatform, productIdsForTier, purchaseFlowTimeoutMessage } from "./products";

describe("IAP client helpers", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("react-native");
    vi.doUnmock("react-native-iap");
    vi.doUnmock("../env");
  });

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

  it("prefers the storefront-formatted price", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../env", () => ({ isExpoGo: false }));
    vi.doMock("./binding", () => ({
      deriveAppleToken: () => "apple-token",
      deriveGoogleToken: () => "google-token",
    }));
    const { __private } = await import("./client");

    expect(
      __private.formattedStorePrice({
        displayPrice: "12,99 €",
        price: "12.99",
      }),
    ).toBe("12,99 €");
  });

  it("uses Google Play's recurring base-plan phase after an introductory phase", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "android" } }));
    vi.doMock("../env", () => ({ isExpoGo: false }));
    vi.doMock("./binding", () => ({
      deriveAppleToken: () => "apple-token",
      deriveGoogleToken: () => "google-token",
    }));
    const { __private } = await import("./client");

    expect(
      __private.formattedStorePrice({
        subscriptionOfferDetailsAndroid: [
          {
            pricingPhases: {
              pricingPhaseList: [
                { formattedPrice: "Free" },
                { formattedPrice: "₩9,900" },
              ],
            },
          },
        ],
      }),
    ).toBe("₩9,900");
  });

  it("maps App Store products to localized Pro and Max plan prices", async () => {
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../env", () => ({ isExpoGo: false }));
    vi.doMock("./binding", () => ({
      deriveAppleToken: () => "apple-token",
      deriveGoogleToken: () => "google-token",
    }));
    const { __private } = await import("./client");

    expect(
      __private.localizedPlanPricesFromProducts(
        [
          { id: "fina_pro_monthly", displayPrice: "US$7.99" },
          { id: "max_monthly", displayPrice: "US$16.99" },
        ],
        "ios",
      ),
    ).toEqual({
      pro: "US$7.99",
      max: "US$16.99",
    });
  });

  it("does not turn stale iOS transaction JWS values into restorable purchases", async () => {
    const mockIap = {
      currentEntitlementIOS: vi.fn().mockResolvedValue(null),
      getTransactionJwsIOS: vi.fn().mockResolvedValue("expired.transaction.jws"),
    };
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../env", () => ({ isExpoGo: false }));
    vi.doMock("./binding", () => ({
      deriveAppleToken: () => "apple-token",
      deriveGoogleToken: () => "google-token",
    }));
    const { __private } = await import("./client");
    const out: any[] = [];

    await __private.collectCurrentIOSEntitlements(mockIap as any, out, new Set());

    expect(out).toEqual([]);
    expect(mockIap.getTransactionJwsIOS).not.toHaveBeenCalled();
  });

  it("accepts RN-IAP iOS purchases whose id is the transaction id", async () => {
    const mockIap = {
      currentEntitlementIOS: vi.fn().mockResolvedValue({
        id: "2000001191010188",
        productId: "fina_pro_monthly",
        purchaseToken: "signed.transaction.jws",
        originalTransactionIdentifierIOS: "2000001191010188",
      }),
      getTransactionJwsIOS: vi.fn().mockResolvedValue(null),
    };
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("../env", () => ({ isExpoGo: false }));
    vi.doMock("./binding", () => ({
      deriveAppleToken: () => "apple-token",
      deriveGoogleToken: () => "google-token",
    }));
    const { __private } = await import("./client");
    const out: any[] = [];

    await __private.collectCurrentIOSEntitlements(mockIap as any, out, new Set());

    expect(out).toEqual([
      {
        platform: "ios",
        productId: "fina_pro_monthly",
        receipt: "signed.transaction.jws",
        purchase: {
          id: "2000001191010188",
          productId: "fina_pro_monthly",
          purchaseToken: "signed.transaction.jws",
          originalTransactionIdentifierIOS: "2000001191010188",
        },
      },
    ]);
  });
});
