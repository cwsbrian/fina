import { describe, it, expect } from "vitest";
import { pickPrimarySub, filterEnvironmentRows } from "../../src/billing/precedence.js";

const mk = (over: any) => ({
  source: "stripe", tier: "lite", status: "active",
  currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
  cancelAtPeriodEnd: false, pendingTier: null, pendingTierAt: null,
  createdAt: new Date(),
  environment: "Production",
  sourceCustomerId: null,
  sourceSubscriptionId: "x",
  ...over,
});

describe("pickPrimarySub", () => {
  it("returns null on empty input", () => {
    expect(pickPrimarySub([])).toBeNull();
  });
  it("Stripe wins over IAP even when IAP has higher tier", () => {
    const stripeLite = mk({ source: "stripe", tier: "lite", createdAt: new Date("2026-01-01") });
    const iapPro = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-02-01") });
    expect(pickPrimarySub([iapPro, stripeLite])?.source).toBe("stripe");
  });
  it("Among non-Stripe, pro beats lite", () => {
    const iapLite = mk({ source: "iap_apple", tier: "lite" });
    const iapPro  = mk({ source: "iap_google", tier: "pro" });
    expect(pickPrimarySub([iapLite, iapPro])?.tier).toBe("pro");
  });
  it("Tiebreak by source: apple > google", () => {
    const apple = mk({ source: "iap_apple", tier: "pro" });
    const google = mk({ source: "iap_google", tier: "pro" });
    expect(pickPrimarySub([google, apple])?.source).toBe("iap_apple");
  });
  it("Tiebreak by createdAt ASC", () => {
    const a = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-01-01"), sourceSubscriptionId: "a" });
    const b = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-02-01"), sourceSubscriptionId: "b" });
    expect(pickPrimarySub([b, a])?.sourceSubscriptionId).toBe("a");
  });
});

describe("filterEnvironmentRows", () => {
  it("excludes Sandbox rows in production", () => {
    const rows = [mk({ environment: "Production" }), mk({ environment: "Sandbox", sourceSubscriptionId: "s" })];
    expect(filterEnvironmentRows(rows, "production").length).toBe(1);
  });
  it("keeps everything in sandbox runtime", () => {
    const rows = [mk({ environment: "Production" }), mk({ environment: "Sandbox" })];
    expect(filterEnvironmentRows(rows, "sandbox").length).toBe(2);
  });
});
