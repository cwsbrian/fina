import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finishPurchase: vi.fn(),
  listAvailablePurchases: vi.fn(),
  listCurrentNativeEntitlements: vi.fn(),
  postIAPRestore: vi.fn(),
  postIAPIntegrityCheck: vi.fn(),
  apiFetch: vi.fn(),
  listNativeSubscriptionStoreEntitlements: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("@fina/shared", () => ({
  tierForIapProductId: (productId: string) =>
    productId === "max_monthly" ? "max" : "pro",
}));

vi.mock("./client", () => ({
  finishPurchase: mocks.finishPurchase,
  IapPurchaseError: class IapPurchaseError extends Error {
    constructor(
      public code: string,
      public recoverable: boolean,
      message: string,
    ) {
      super(message);
    }
  },
  isIapAvailable: () => true,
  listAvailablePurchases: mocks.listAvailablePurchases,
  listCurrentNativeEntitlements: mocks.listCurrentNativeEntitlements,
  requestSubscriptionPurchase: vi.fn(),
  showNativeSubscriptionManagement: vi.fn(),
}));

vi.mock("../api/billing", () => ({
  postIAPCheckout: vi.fn(),
  postIAPIntegrityCheck: mocks.postIAPIntegrityCheck,
  postIAPRestore: mocks.postIAPRestore,
}));

vi.mock("../api/client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("../billing/recovery-ui", () => ({
  isBillingLocked: () => false,
}));

vi.mock("./native-subscription-store", () => ({
  listNativeSubscriptionStoreEntitlements: mocks.listNativeSubscriptionStoreEntitlements,
}));

import {
  fetchMeWithNativeSubscriptionSync,
  restoreCurrentNativeSubscriptions,
  syncCurrentNativeSubscriptions,
} from "./sync";

describe("native subscription sync", () => {
  let now = 1_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    now += 60_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses StoreKit native entitlements for background sync on iOS", async () => {
    const nextMe = { subscription: { tier: "max", source: "iap_apple" } };
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "silent-jws" },
    ]);
    mocks.postIAPRestore.mockResolvedValue(nextMe);

    await expect(syncCurrentNativeSubscriptions()).resolves.toBe(nextMe);

    expect(mocks.listNativeSubscriptionStoreEntitlements).toHaveBeenCalledTimes(1);
    expect(mocks.listCurrentNativeEntitlements).not.toHaveBeenCalled();
    expect(mocks.listAvailablePurchases).not.toHaveBeenCalled();
    expect(mocks.postIAPRestore).toHaveBeenCalledWith({
      platform: "ios",
      purchases: [{ productId: "max_monthly", receipt: "silent-jws" }],
    });
    expect(mocks.finishPurchase).not.toHaveBeenCalled();
  });

  it("keeps explicit restore on the App Store restore API path", async () => {
    const purchase = { id: "purchase" };
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([]);
    mocks.listAvailablePurchases.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "restore-jws", purchase },
    ]);
    mocks.postIAPRestore.mockResolvedValue({ subscription: { tier: "max" } });

    await restoreCurrentNativeSubscriptions();

    expect(mocks.listAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mocks.finishPurchase).toHaveBeenCalledWith(purchase);
  });

  it("prefers StoreKit current entitlements over stale purchase history for restore", async () => {
    const nextMe = { subscription: { tier: "pro", source: "iap_apple" } };
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([
      { platform: "ios", productId: "fina_pro_monthly", receipt: "current-pro-jws" },
    ]);
    mocks.listAvailablePurchases.mockResolvedValue([
      {
        platform: "ios",
        productId: "fina_pro_monthly",
        receipt: "old-expired-purchase-jws",
        purchase: { id: "old" },
      },
    ]);
    mocks.postIAPRestore.mockResolvedValue(nextMe);

    await expect(restoreCurrentNativeSubscriptions()).resolves.toBe(nextMe);

    expect(mocks.postIAPRestore).toHaveBeenCalledWith({
      platform: "ios",
      purchases: [{ productId: "fina_pro_monthly", receipt: "current-pro-jws" }],
    });
    expect(mocks.listAvailablePurchases).not.toHaveBeenCalled();
    expect(mocks.finishPurchase).not.toHaveBeenCalled();
  });

  it("uses StoreKit native entitlements before RN-IAP on iOS reload", async () => {
    const trialMe = {
      subscription: null,
      iapIntegrity: { requiresCheck: false, isPlanMismatch: false },
      billingRecovery: { locked: false },
    };
    const syncedMe = {
      ...trialMe,
      subscription: { tier: "max", source: "iap_apple" },
    };
    mocks.apiFetch.mockResolvedValue(trialMe);
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "silent-max-jws" },
    ]);
    mocks.postIAPRestore.mockResolvedValue(syncedMe);

    await expect(fetchMeWithNativeSubscriptionSync()).resolves.toBe(syncedMe);

    expect(mocks.postIAPRestore).toHaveBeenCalledWith({
      platform: "ios",
      purchases: [{ productId: "max_monthly", receipt: "silent-max-jws" }],
    });
    expect(mocks.listCurrentNativeEntitlements).not.toHaveBeenCalled();
    expect(mocks.postIAPIntegrityCheck).not.toHaveBeenCalled();
  });

  it("locks a trial-only account when native entitlement restore fails", async () => {
    const trialMe = {
      subscription: null,
      iapIntegrity: { requiresCheck: false, isPlanMismatch: false },
      billingRecovery: { locked: false },
    };
    const recoveryMe = {
      ...trialMe,
      iapIntegrity: { requiresCheck: false, isPlanMismatch: true },
      billingRecovery: { locked: true },
    };
    mocks.apiFetch.mockResolvedValue(trialMe);
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "storekit-max-jws" },
    ]);
    mocks.postIAPRestore.mockRejectedValue(new Error("restore failed"));
    mocks.postIAPIntegrityCheck.mockResolvedValue(recoveryMe);

    await expect(fetchMeWithNativeSubscriptionSync()).resolves.toBe(recoveryMe);

    expect(mocks.postIAPRestore).toHaveBeenCalledWith({
      platform: "ios",
      purchases: [{ productId: "max_monthly", receipt: "storekit-max-jws" }],
    });
    expect(mocks.postIAPIntegrityCheck).toHaveBeenCalledWith({
      platform: "ios",
      result: "mismatched",
      nativeProductId: "max_monthly",
      receipt: "storekit-max-jws",
    });
  });
});
