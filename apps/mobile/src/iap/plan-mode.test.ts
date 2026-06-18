import { describe, expect, it } from "vitest";

import {
  canOpenNativeSubscriptionSurface,
  planEntryAction,
  usesNativeSubscriptionSurface,
} from "./plan-mode";

describe("iOS plan mode", () => {
  it("uses the native App Store subscription surface instead of in-app plan cards", () => {
    expect(usesNativeSubscriptionSurface("ios")).toBe(true);
    expect(usesNativeSubscriptionSurface("android")).toBe(false);
  });

  it("lets iOS users open the native surface even before Fina has a subscription", () => {
    expect(canOpenNativeSubscriptionSurface("ios", null)).toBe(true);
    expect(canOpenNativeSubscriptionSurface("ios", "iap_apple")).toBe(true);
    expect(canOpenNativeSubscriptionSurface("ios", "stripe")).toBe(false);
  });

  it("opens native subscriptions from the Plan row on iOS", () => {
    expect(planEntryAction("ios", null)).toBe("native-subscriptions");
    expect(planEntryAction("ios", "iap_apple")).toBe("native-subscriptions");
    expect(planEntryAction("ios", "stripe")).toBe("web-billing");
    expect(planEntryAction("android", null)).toBe("plan-screen");
  });
});
