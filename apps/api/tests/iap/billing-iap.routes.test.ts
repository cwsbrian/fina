import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { signUpAndGetCookie } from "../helpers/auth.js";
import { testEnv } from "../helpers/test-env.js";
import { deriveAppleToken, deriveGoogleToken } from "../../src/iap/binding.js";
import { HttpError } from "../../src/auth/context.js";
import { CLIENT_DEVICE_ID_HEADER, CLIENT_PLATFORM_HEADER } from "@fina/shared";

vi.mock("../../src/plaid/reconcile.js", () => ({
  reconcilePlaidItemsForUser: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  reconcileOrphanPlaidItems: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  retryPendingPlaidBillingCleanups: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  refreshBillingStateForUser: vi.fn().mockResolvedValue(undefined),
}));

import { reconcilePlaidItemsForUser } from "../../src/plaid/reconcile.js";

// Set IAP env vars so platform-specific env guards inside the route handlers pass.
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
    expect(body.tier).toBe("max");
    expect(body.trial.active).toBe(false);
    expect(body.subscription.tier).toBe("max");
    expect(body.subscription.source).toBe("iap_apple");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.trialConsumed).toBe(true);
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
    const body = res.json();
    expect(body.tier).toBe("pro");
    expect(body.trial.active).toBe(false);
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

  it("restores Android purchases with receipt env only", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u7@test.com" });
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken(userId),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      pendingProductId: null,
      pendingAt: null,
      linkedPurchaseToken: null,
      environment: "Sandbox",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/restore",
      headers: { cookie },
      payload: {
        platform: "android",
        purchases: [{ productId: "pro_monthly", receipt: "purchase-token" }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().subscription.source).toBe("iap_google");
    expect(fakeGoogleClient.fetchAndNormalize).toHaveBeenCalledWith("purchase-token");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(testEnv(), userId);
  });
});

describe("POST /billing/iap/integrity-check", () => {
  it("records a matched native entitlement without locking the user", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u8@test.com" });
    await prisma.subscription.create({
      data: {
        userId,
        tier: "pro",
        source: "iap_apple",
        sourceSubscriptionId: "OT-integrity-1",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Sandbox",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/integrity-check",
      headers: {
        cookie,
        [CLIENT_DEVICE_ID_HEADER]: "ios-device-integrity-1",
        [CLIENT_PLATFORM_HEADER]: "ios",
      },
      payload: {
        platform: "ios",
        result: "matched",
        nativeProductId: "fina_pro_monthly",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().iapIntegrity.isPlanMismatch).toBe(false);
    const [user, device] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.userDevice.findUniqueOrThrow({
        where: {
          userId_clientDeviceId: {
            userId,
            clientDeviceId: "ios-device-integrity-1",
          },
        },
      }),
    ]);
    expect(user.isPlanMismatch).toBe(false);
    expect(device.lastIapIntegrityResult).toBe("matched");
    expect(device.lastIapIntegrityCheckedAt).toBeTruthy();
  });

  it("locks the user when native entitlement tier mismatches the server tier", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "u9@test.com" });
    await prisma.subscription.create({
      data: {
        userId,
        tier: "pro",
        source: "iap_apple",
        sourceSubscriptionId: "OT-integrity-2",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Sandbox",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/iap/integrity-check",
      headers: {
        cookie,
        [CLIENT_DEVICE_ID_HEADER]: "ios-device-integrity-2",
        [CLIENT_PLATFORM_HEADER]: "ios",
      },
      payload: {
        platform: "ios",
        result: "matched",
        nativeProductId: "max_monthly",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().iapIntegrity.isPlanMismatch).toBe(true);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.isPlanMismatch).toBe(true);
  });
});
