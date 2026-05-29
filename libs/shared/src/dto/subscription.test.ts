import { describe, it, expect } from "vitest";
import { subscriptionSourceLabel } from "./subscription.js";

describe("subscriptionSourceLabel", () => {
  it("stripe → Web", () => expect(subscriptionSourceLabel("stripe")).toBe("Web"));
  it("iap_apple → App Store", () =>
    expect(subscriptionSourceLabel("iap_apple")).toBe("App Store"));
  it("iap_google → Google Play", () =>
    expect(subscriptionSourceLabel("iap_google")).toBe("Google Play"));
});
