import { beforeEach, describe, expect, it, vi } from "vitest";

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
  });

  it("uses silent current entitlements for background sync", async () => {
    const nextMe = { subscription: { tier: "max", source: "iap_apple" } };
    mocks.listCurrentNativeEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "silent-jws" },
    ]);
    mocks.postIAPRestore.mockResolvedValue(nextMe);

    await expect(syncCurrentNativeSubscriptions()).resolves.toBe(nextMe);

    expect(mocks.listCurrentNativeEntitlements).toHaveBeenCalledTimes(1);
    expect(mocks.listAvailablePurchases).not.toHaveBeenCalled();
    expect(mocks.postIAPRestore).toHaveBeenCalledWith({
      platform: "ios",
      purchases: [{ productId: "max_monthly", receipt: "silent-jws" }],
    });
    expect(mocks.finishPurchase).not.toHaveBeenCalled();
  });

  it("keeps explicit restore on the App Store restore API path", async () => {
    const purchase = { id: "purchase" };
    mocks.listAvailablePurchases.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "restore-jws", purchase },
    ]);
    mocks.postIAPRestore.mockResolvedValue({ subscription: { tier: "max" } });

    await restoreCurrentNativeSubscriptions();

    expect(mocks.listAvailablePurchases).toHaveBeenCalledTimes(1);
    expect(mocks.finishPurchase).toHaveBeenCalledWith(purchase);
  });

  it("checks silent native entitlements even when the Fina account is still trial-only", async () => {
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
    mocks.listCurrentNativeEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "silent-max-jws" },
    ]);
    mocks.postIAPIntegrityCheck.mockResolvedValue(recoveryMe);

    await expect(fetchMeWithNativeSubscriptionSync()).resolves.toBe(recoveryMe);

    expect(mocks.postIAPIntegrityCheck).toHaveBeenCalledWith({
      platform: "ios",
      result: "mismatched",
      nativeProductId: "max_monthly",
      receipt: "silent-max-jws",
    });
  });

  it("falls back to StoreKit native entitlements when react-native-iap sees none", async () => {
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
    mocks.listCurrentNativeEntitlements.mockResolvedValue([]);
    mocks.listNativeSubscriptionStoreEntitlements.mockResolvedValue([
      { platform: "ios", productId: "max_monthly", receipt: "storekit-max-jws" },
    ]);
    mocks.postIAPIntegrityCheck.mockResolvedValue(recoveryMe);

    await expect(fetchMeWithNativeSubscriptionSync()).resolves.toBe(recoveryMe);

    expect(mocks.postIAPIntegrityCheck).toHaveBeenCalledWith({
      platform: "ios",
      result: "mismatched",
      nativeProductId: "max_monthly",
      receipt: "storekit-max-jws",
    });
  });
});
