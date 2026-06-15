import { describe, expect, it } from "vitest";
import type { SubscriptionDTO } from "@fina/shared";
import {
  canManageSubscriptionOnWeb,
  canSwitchPlanOnWeb,
  externalBillingManagementText,
  priceForBillingSource,
} from "./plan-page-model";

const baseSub: SubscriptionDTO = {
  tier: "pro",
  status: "active",
  currentPeriodEnd: "2026-07-01T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  source: "stripe",
  pendingTier: null,
  pendingTierAt: null,
};

describe("plan page billing source policy", () => {
  it("allows Stripe subscriptions to be managed and switched on web", () => {
    expect(canManageSubscriptionOnWeb(baseSub)).toBe(true);
    expect(canSwitchPlanOnWeb(baseSub)).toBe(true);
    expect(externalBillingManagementText(baseSub)).toBeNull();
  });

  it("blocks App Store subscriptions from Stripe management on web", () => {
    const sub = { ...baseSub, source: "iap_apple" as const };

    expect(canManageSubscriptionOnWeb(sub)).toBe(false);
    expect(canSwitchPlanOnWeb(sub)).toBe(false);
    expect(externalBillingManagementText(sub)).toBe(
      "Manage this subscription in the App Store.",
    );
  });

  it("blocks Google Play subscriptions from Stripe management on web", () => {
    const sub = { ...baseSub, source: "iap_google" as const };

    expect(canManageSubscriptionOnWeb(sub)).toBe(false);
    expect(canSwitchPlanOnWeb(sub)).toBe(false);
    expect(externalBillingManagementText(sub)).toBe(
      "Manage this subscription in Google Play.",
    );
  });

  it("returns source-specific display prices", () => {
    expect(priceForBillingSource("stripe", "pro")).toBe("$7");
    expect(priceForBillingSource("stripe", "max")).toBe("$15");
    expect(priceForBillingSource("iap_apple", "pro")).toBe("$7.99");
    expect(priceForBillingSource("iap_google", "max")).toBe("$16.99");
  });
});
