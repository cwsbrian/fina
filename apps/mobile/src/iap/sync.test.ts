import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearPendingNativeTransactions: vi.fn(),
  finishPurchase: vi.fn(),
  listAvailablePurchases: vi.fn(),
  listCurrentNativeEntitlements: vi.fn(),
  postIAPCheckout: vi.fn(),
  postIAPRestore: vi.fn(),
  postIAPIntegrityCheck: vi.fn(),
  requestSubscriptionPurchase: vi.fn(),
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
  clearPendingNativeTransactions: mocks.clearPendingNativeTransactions,
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
  requestSubscriptionPurchase: mocks.requestSubscriptionPurchase,
  showNativeSubscriptionManagement: vi.fn(),
}));

vi.mock("../api/billing", () => ({
  postIAPCheckout: mocks.postIAPCheckout,
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
  checkoutNativeSubscription,
  fetchMeWithNativeSubscriptionSync,
  restoreCurrentNativeSubscriptions,
  syncCurrentNativeSubscriptions,
} from "./sync";
import { IapPurchaseError } from "./client";

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

  it("finishes a native checkout purchase even when server sync rejects it", async () => {
    const purchase = { id: "stale-purchase" };
    const error = Object.assign(new Error("expired"), { code: "expired_receipt" });
    mocks.requestSubscriptionPurchase.mockResolvedValue({
      platform: "ios",
      productId: "fina_pro_monthly",
      receipt: "expired-jws",
      purchase,
    });
    mocks.postIAPCheckout.mockRejectedValue(error);

    await expect(checkoutNativeSubscription("pro", "user-1")).rejects.toBe(error);

    expect(mocks.finishPurchase).toHaveBeenCalledWith(purchase);
  });

  it("retries checkout after finishing a stale expired native purchase", async () => {
    const stalePurchase = { id: "stale-purchase" };
    const freshPurchase = { id: "fresh-purchase" };
    const expired = Object.assign(new Error("expired"), { code: "expired_receipt" });
    const nextMe = { subscription: { tier: "max", source: "iap_apple" } };
    mocks.requestSubscriptionPurchase
      .mockResolvedValueOnce({
        platform: "ios",
        productId: "max_monthly",
        receipt: "expired-max-jws",
        purchase: stalePurchase,
      })
      .mockResolvedValueOnce({
        platform: "ios",
        productId: "max_monthly",
        receipt: "fresh-max-jws",
        purchase: freshPurchase,
      });
    mocks.postIAPCheckout.mockRejectedValueOnce(expired).mockResolvedValueOnce(nextMe);

    await expect(checkoutNativeSubscription("max", "user-1")).resolves.toBe(nextMe);

    expect(mocks.finishPurchase).toHaveBeenCalledWith(stalePurchase);
    expect(mocks.finishPurchase).toHaveBeenCalledWith(freshPurchase);
    expect(mocks.requestSubscriptionPurchase).toHaveBeenCalledTimes(2);
    expect(mocks.postIAPCheckout).toHaveBeenCalledTimes(2);
  });

  it("clears iOS pending transactions and retries when checkout hits duplicate purchase", async () => {
    const duplicate = new IapPurchaseError(
      "E_ALREADY_OWNED",
      true,
      "Duplicate purchase update skipped",
    );
    const purchase = { id: "fresh-pro-purchase" };
    const nextMe = { subscription: { tier: "pro", source: "iap_apple" } };
    mocks.requestSubscriptionPurchase
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({
        platform: "ios",
        productId: "fina_pro_monthly",
        receipt: "fresh-pro-jws",
        purchase,
      });
    mocks.postIAPCheckout.mockResolvedValue(nextMe);

    await expect(checkoutNativeSubscription("pro", "user-1")).resolves.toBe(nextMe);

    expect(mocks.clearPendingNativeTransactions).toHaveBeenCalledTimes(1);
    expect(mocks.requestSubscriptionPurchase).toHaveBeenCalledTimes(2);
    expect(mocks.finishPurchase).toHaveBeenCalledWith(purchase);
    expect(mocks.postIAPCheckout).toHaveBeenCalledWith({
      platform: "ios",
      productId: "fina_pro_monthly",
      receipt: "fresh-pro-jws",
    });
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
