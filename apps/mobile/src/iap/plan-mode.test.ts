import { describe, expect, it } from "vitest";

import {
  canOpenNativeSubscriptionSurface,
  planEntryAction,
  usesNativeSubscriptionSurface,
} from "./plan-mode";

describe("iOS plan mode", () => {
  it("uses in-app plan cards for iOS purchases", () => {
    expect(usesNativeSubscriptionSurface("ios")).toBe(false);
    expect(usesNativeSubscriptionSurface("android")).toBe(false);
  });

  it("only opens native subscription management for existing native subscriptions", () => {
    expect(canOpenNativeSubscriptionSurface("ios", null)).toBe(false);
    expect(canOpenNativeSubscriptionSurface("ios", "iap_apple")).toBe(true);
    expect(canOpenNativeSubscriptionSurface("ios", "stripe")).toBe(false);
  });

  it("opens the plan screen from the Plan row on iOS", () => {
    expect(planEntryAction("ios", null)).toBe("plan-screen");
    expect(planEntryAction("ios", "iap_apple")).toBe("plan-screen");
    expect(planEntryAction("ios", "stripe")).toBe("web-billing");
    expect(planEntryAction("android", null)).toBe("plan-screen");
  });
});
