import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finishPurchase: vi.fn(),
  listAvailablePurchases: vi.fn(),
  listCurrentNativeEntitlements: vi.fn(),
  postIAPRestore: vi.fn(),
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
  postIAPIntegrityCheck: vi.fn(),
  postIAPRestore: mocks.postIAPRestore,
}));

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
}));

vi.mock("../billing/recovery-ui", () => ({
  isBillingLocked: () => false,
}));

import {
  restoreCurrentNativeSubscriptions,
  syncCurrentNativeSubscriptions,
} from "./sync";

describe("native subscription sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
