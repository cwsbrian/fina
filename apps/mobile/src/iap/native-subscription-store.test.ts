import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  present: vi.fn(),
  openManageBilling: vi.fn(),
  postIAPCheckout: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  NativeModules: {
    FinaNativeSubscriptionStore: {
      present: mocks.present,
    },
  },
}));

vi.mock("../env", () => ({ isExpoGo: false }));
vi.mock("../api/billing", () => ({ postIAPCheckout: mocks.postIAPCheckout }));
vi.mock("./manage", () => ({ openManageBilling: mocks.openManageBilling }));
vi.mock("./products", () => ({ productIdsForPlatform: () => ["pro_monthly", "max_monthly"] }));
vi.mock("./binding", () => ({ deriveAppleToken: () => "apple-token" }));

import { presentNativeSubscriptionStoreAndSync } from "./native-subscription-store";

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
});
