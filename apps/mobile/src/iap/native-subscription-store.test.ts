import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  present: vi.fn(),
  copyText: vi.fn(),
  appTransaction: vi.fn(),
  currentEntitlements: vi.fn(),
  products: vi.fn(),
  openManageBilling: vi.fn(),
  postIAPCheckout: vi.fn(),
  share: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Share: { share: mocks.share },
  NativeModules: {
    FinaNativeSubscriptionStore: {
      present: mocks.present,
      copyText: mocks.copyText,
      appTransaction: mocks.appTransaction,
      currentEntitlements: mocks.currentEntitlements,
      products: mocks.products,
    },
  },
}));

vi.mock("../env", () => ({ isExpoGo: false }));
vi.mock("../api/billing", () => ({ postIAPCheckout: mocks.postIAPCheckout }));
vi.mock("./manage", () => ({ openManageBilling: mocks.openManageBilling }));
vi.mock("./products", () => ({ productIdsForPlatform: () => ["pro_monthly", "max_monthly"] }));
vi.mock("./binding", () => ({ deriveAppleToken: () => "apple-token" }));

import {
  copyTextToClipboard,
  getSignedAppleAppTransaction,
  hasNativeSubscriptionStoreEntitlementReader,
  listNativeSubscriptionStoreProducts,
  listNativeSubscriptionStoreEntitlements,
  presentNativeSubscriptionStoreAndSync,
} from "./native-subscription-store";

describe("native subscription store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the native store without automatically restoring purchases", async () => {
    mocks.present.mockResolvedValue(null);

    await expect(presentNativeSubscriptionStoreAndSync("user_123")).resolves.toBeNull();

    expect(mocks.present).toHaveBeenCalledWith(["pro_monthly", "max_monthly"], "apple-token");
    expect(mocks.postIAPCheckout).not.toHaveBeenCalled();
    expect(mocks.openManageBilling).not.toHaveBeenCalled();
  });

  it("syncs the completed native subscription purchase through checkout", async () => {
    const nextMe = { subscription: { tier: "pro", source: "iap_apple" } };
    mocks.present.mockResolvedValue({
      platform: "ios",
      productId: "pro_monthly",
      receipt: "signed.transaction.jws",
    });
    mocks.postIAPCheckout.mockResolvedValue(nextMe);

    await expect(presentNativeSubscriptionStoreAndSync("user_123")).resolves.toBe(nextMe);

    expect(mocks.present).toHaveBeenCalledWith(["pro_monthly", "max_monthly"], "apple-token");
    expect(mocks.postIAPCheckout).toHaveBeenCalledWith({
      platform: "ios",
      productId: "pro_monthly",
      receipt: "signed.transaction.jws",
    });
  });

  it("reads current StoreKit entitlements from the native subscription module", async () => {
    const entitlement = {
      platform: "ios",
      productId: "max_monthly",
      receipt: "current.entitlement.jws",
    };
    mocks.currentEntitlements.mockResolvedValue([entitlement]);

    await expect(listNativeSubscriptionStoreEntitlements()).resolves.toEqual([entitlement]);

    expect(mocks.currentEntitlements).toHaveBeenCalledWith(["pro_monthly", "max_monthly"]);
  });

  it("reads the Apple-signed AppTransaction used for environment classification", async () => {
    mocks.appTransaction.mockResolvedValue({ signedAppTransaction: "signed.app.transaction" });

    await expect(getSignedAppleAppTransaction()).resolves.toBe("signed.app.transaction");

    expect(mocks.appTransaction).toHaveBeenCalledOnce();
  });

  it("reads StoreKit product metadata from the native subscription module", async () => {
    const product = {
      productId: "max_monthly",
      displayName: "Fina Max",
      displayPrice: "$12.99",
      price: "12.99",
      currencyCode: "USD",
    };
    mocks.products.mockResolvedValue([product]);

    await expect(listNativeSubscriptionStoreProducts()).resolves.toEqual([product]);

    expect(mocks.products).toHaveBeenCalledWith(["pro_monthly", "max_monthly"]);
  });

  it("reports when the native entitlement reader is available", () => {
    expect(hasNativeSubscriptionStoreEntitlementReader()).toBe(true);
  });

  it("copies debug text through the native pasteboard helper", async () => {
    mocks.copyText.mockResolvedValue(true);

    await expect(copyTextToClipboard("debug payload")).resolves.toBe("clipboard");

    expect(mocks.copyText).toHaveBeenCalledWith("debug payload");
    expect(mocks.share).not.toHaveBeenCalled();
  });
});
