import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { signUpAndGetCookie } from "../helpers/auth.js";
import { testEnv } from "../helpers/test-env.js";
import { deriveAppleToken } from "../../src/iap/binding.js";
import { HttpError } from "../../src/auth/context.js";

vi.mock("../../src/plaid/reconcile.js", () => ({
  reconcilePlaidItemsForUser: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  reconcileOrphanPlaidItems: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  retryPendingPlaidBillingCleanups: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  refreshBillingStateForUser: vi.fn().mockResolvedValue(undefined),
}));

import { reconcilePlaidItemsForUser } from "../../src/plaid/reconcile.js";

// Set IAP env vars so requireIapEnv(process.env) inside the route handlers passes.
// These are sandbox-safe fake values — same shape used in env-guard.test.ts.
process.env.APPLE_BUNDLE_ID = "com.fina.app";
process.env.APPLE_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
process.env.APPLE_ASC_KEY_ID = "K1";
process.env.APPLE_ASC_PRIVATE_KEY = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
process.env.APPLE_ENV = "sandbox";
process.env.GOOGLE_PACKAGE_NAME = "app.fina";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "iap@fina.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
});
process.env.GOOGLE_PUBSUB_VERIFY_AUDIENCE = "https://api.fina.app/webhooks/iap/google";
process.env.GOOGLE_PUBSUB_VERIFY_EMAIL = "iap-pubsub@fina.iam.gserviceaccount.com";
process.env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME = "projects/fina/subscriptions/iap-rtdn";

let app: Awaited<ReturnType<typeof buildApp>>;
const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = {
  fetchAndNormalize: vi.fn(),
  acknowledgeIfPending: vi.fn().mockResolvedValue(true),
};

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  fakeGoogleClient.acknowledgeIfPending.mockResolvedValue(true);
  app = await buildApp(testEnv(), {
    iap: {
      appleClient: fakeAppleClient,
      googleClient: fakeGoogleClient,
      oidcClient: { verifyIdToken: vi.fn() },
    },
  });
});

describe("POST /billing/iap/checkout", () => {
  it("400 invalid_body when payload malformed", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "u1@test.com" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/checkout",
      headers: { cookie },
      payload: { platform: "ios" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("409 already_subscribed_stripe when user already has active Stripe sub", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u2@test.com" });
    await prisma.subscription.create({
      data: {
        userId,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_x",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Production",
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/checkout",
      headers: { cookie },
      payload: { platform: "ios", productId: "max_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_subscribed_stripe");
  });

  it("happy path returns MeDTO with new IAP sub", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u3@test.com" });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken(userId),
      productId: "max_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/checkout",
      headers: { cookie },
      payload: { platform: "ios", productId: "max_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("pro");
    expect(body.subscription.tier).toBe("max");
    expect(body.subscription.source).toBe("iap_apple");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(testEnv(), userId);
  });

  it("403 user_mismatch when appAccountToken doesn't match caller", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "u4@test.com" });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("OTHER-USER"),
      productId: "max_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/checkout",
      headers: { cookie },
      payload: { platform: "ios", productId: "max_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("user_mismatch");
  });
});

describe("POST /billing/iap/restore", () => {
  it("partial success — skips failures, returns MeDTO", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u5@test.com" });
    // Expire the trial so computeEffectiveTier falls through to the subscription tier.
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: null } });
    fakeAppleClient.verifyAndDecodeTransaction.mockImplementation(async (jws: string) => {
      if (jws === "ok")
        return {
          bundleId: "com.fina.app",
          environment: "Sandbox",
          signedDate: Date.now(),
          appAccountToken: deriveAppleToken(userId),
          productId: "fina_pro_monthly",
          originalTransactionId: "OT-1",
          transactionId: "T-1",
          raw: {},
        };
      throw new Error("bad");
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "fina_pro_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/restore",
      headers: { cookie },
      payload: {
        platform: "ios",
        purchases: [
          { productId: "fina_pro_monthly", receipt: "ok" },
          { productId: "max_monthly", receipt: "bad" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("pro");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledTimes(1);
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(testEnv(), userId);
  });

  it("returns first concrete restore error when no purchase syncs", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "u6@test.com" });
    fakeAppleClient.verifyAndDecodeTransaction.mockRejectedValue(
      new HttpError(403, "user_mismatch", "appAccountToken mismatch"),
    );

    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/restore",
      headers: { cookie },
      payload: {
        platform: "ios",
        purchases: [
          { productId: "max_monthly", receipt: "mismatched-user-jws" },
        ],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("user_mismatch");
  });
});
