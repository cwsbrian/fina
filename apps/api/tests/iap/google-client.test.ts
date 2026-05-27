import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleClient } from "../../src/iap/google-client.js";
import type { GoogleIapConfig } from "../../src/iap/env-guard.js";

const cfg: GoogleIapConfig = {
  packageName: "app.fina",
  serviceAccount: { client_email: "x@y", private_key: "k" } as any,
  pubsubVerifyAudience: "aud",
  pubsubVerifyEmail: "x@y",
  pubsubSubscriptionName: "projects/fina/subscriptions/iap-rtdn",
};

const mkV2 = (overrides: Partial<{
  obfuscatedExternalAccountId: string;
  acknowledgementState: string;
  subscriptionState: string;
  expiryTime: string;
  productId: string;
  linkedPurchaseToken: string | null;
  environment: "Production" | "Sandbox";
}> = {}) => ({
  externalAccountIdentifiers: {
    obfuscatedExternalAccountId: overrides.obfuscatedExternalAccountId ?? "obf-1",
  },
  acknowledgementState: overrides.acknowledgementState ?? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  subscriptionState: overrides.subscriptionState ?? "SUBSCRIPTION_STATE_ACTIVE",
  lineItems: [
    {
      productId: overrides.productId ?? "pro_monthly",
      expiryTime: overrides.expiryTime ?? new Date(Date.now() + 86400_000).toISOString(),
      offerDetails: {},
    },
  ],
  linkedPurchaseToken: overrides.linkedPurchaseToken ?? null,
  testPurchase: overrides.environment === "Sandbox" ? {} : undefined,
});

describe("GoogleClient.fetchAndNormalize", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns normalized v2 payload + 'Production' environment", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2());
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.obfuscatedExternalAccountId).toBe("obf-1");
    expect(out.environment).toBe("Production");
    expect(out.mapped.status).toBe("active");
  });

  it("tags Sandbox when testPurchase is set", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2({ environment: "Sandbox" }));
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.environment).toBe("Sandbox");
  });

  it("acknowledges when state is PENDING", async () => {
    const c = new GoogleClient(cfg);
    const ackSpy = vi.spyOn(c as any, "_acknowledge").mockResolvedValue(undefined);
    await c.acknowledgeIfPending({
      purchaseToken: "token-abc",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
    expect(ackSpy).toHaveBeenCalledWith("token-abc", "pro_monthly");
  });

  it("does not acknowledge when state is already ACKNOWLEDGED", async () => {
    const c = new GoogleClient(cfg);
    const ackSpy = vi.spyOn(c as any, "_acknowledge").mockResolvedValue(undefined);
    await c.acknowledgeIfPending({
      purchaseToken: "token-abc",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    });
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("surfaces linkedPurchaseToken when present", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2({ linkedPurchaseToken: "prev-token" }));
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.linkedPurchaseToken).toBe("prev-token");
  });
});
