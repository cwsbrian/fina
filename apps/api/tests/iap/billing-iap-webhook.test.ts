import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { testEnv } from "../helpers/test-env.js";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

// IAP env preamble — mirrors tests/iap/billing-iap.routes.test.ts.
process.env.APPLE_BUNDLE_ID = "com.fina.app";
process.env.APPLE_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
process.env.APPLE_ASC_KEY_ID = "K1";
process.env.APPLE_ASC_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
process.env.APPLE_ENV = "sandbox";
process.env.GOOGLE_PACKAGE_NAME = "app.fina";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"client_email":"iap@fina.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}';
process.env.GOOGLE_PUBSUB_VERIFY_AUDIENCE = "https://api.fina.app/webhooks/iap/google";
process.env.GOOGLE_PUBSUB_VERIFY_EMAIL = "iap@fina.iam.gserviceaccount.com";
process.env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME = "projects/fina/subscriptions/iap-rtdn";

let app: Awaited<ReturnType<typeof buildApp>>;
const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  verifyAndDecodeNotification: vi.fn(),
  verifyAndDecodeRenewalInfo: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = { fetchAndNormalize: vi.fn(), acknowledgeIfPending: vi.fn().mockResolvedValue(true) };
const fakeOidcClient: any = { verifyIdToken: vi.fn() };

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  app = await buildApp(testEnv(), { iap: { appleClient: fakeAppleClient, googleClient: fakeGoogleClient, oidcClient: fakeOidcClient } });
  await prisma.user.create({ data: { id: "u1", email: "u1@test", iapAppleAccountToken: deriveAppleToken("u1") } });
});

describe("POST /webhooks/iap/apple", () => {
  const appleTx = () => ({
    bundleId: "com.fina.app", environment: "Sandbox", signedDate: Date.now(),
    appAccountToken: deriveAppleToken("u1"),
    productId: "pro_monthly", originalTransactionId: "OT-1", transactionId: "T-1", raw: {},
  });

  it("happy path: existing Subscription row, syncs to active", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "pro", source: "iap_apple",
      sourceSubscriptionId: "OT-1", sourceCustomerId: deriveAppleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), environment: "Sandbox",
    } });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-1", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 60 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("step 4.2 fallback: webhook before checkout — finds user via binding", async () => {
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-2", notificationType: "SUBSCRIBED",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { userId: "u1", source: "iap_apple" } });
    expect(sub).not.toBeNull();
  });

  it("step 4.3 tombstone hit returns 200 (deleted user, stop retrying)", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapAppleAccountToken: null } });
    await prisma.iapDeletedBinding.create({
      data: { source: "iap_apple", tokenHash: hashBindingToken(deriveAppleToken("u1")) },
    });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-3", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { source: "iap_apple" } });
    expect(sub).toBeNull();
    const tombstoneEvent = await prisma.webhookEvent.findFirst({ where: { type: "unattributable_after_delete" } });
    expect(tombstoneEvent).not.toBeNull();
  });

  it("step 4.4 unknown user returns 500 up to retry-cap, then forensic 200", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapAppleAccountToken: null } });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-4-stable", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST", url: "/webhooks/iap/apple",
        payload: { signedPayload: "fake-jws" },
      });
      expect(res.statusCode).toBe(500);
    }
    const res6 = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res6.statusCode).toBe(200);
    const forensic = await prisma.webhookEvent.findFirst({ where: { type: "unattributable_giveup" } });
    expect(forensic).not.toBeNull();
    const res7 = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res7.statusCode).toBe(200);
  });

  it("dedup — second delivery of same notificationUUID short-circuits", async () => {
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-dup", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    await app.inject({ method: "POST", url: "/webhooks/iap/apple", payload: { signedPayload: "fake-jws" } });
    fakeAppleClient.getSubscriptionStatus.mockClear();
    await app.inject({ method: "POST", url: "/webhooks/iap/apple", payload: { signedPayload: "fake-jws" } });
    expect(fakeAppleClient.getSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("Family Sharing revocation flips Subscription.status to canceled", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "pro", source: "iap_apple",
      sourceSubscriptionId: "OT-1", sourceCustomerId: deriveAppleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), environment: "Sandbox",
    } });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-fs", notificationType: "DID_CHANGE_RENEWAL_STATUS",
      subtype: "PRODUCT_NOT_FOR_SALE",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { source: "iap_apple", sourceSubscriptionId: "OT-1" } });
    expect(sub!.status).toBe("canceled");
  });
});

describe("POST /webhooks/iap/google", () => {
  beforeEach(() => {
    fakeOidcClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        aud: "https://api.fina.app/webhooks/iap/google",
        iss: "https://accounts.google.com",
        email: "iap@fina.iam.gserviceaccount.com",
        azp: "iap@fina.iam.gserviceaccount.com",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    });
  });

  it("happy path", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapGoogleObfuscatedId: deriveGoogleToken("u1") } });
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null, environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({
          subscriptionNotification: { purchaseToken: "pt-1", subscriptionId: "pro_monthly", notificationType: 4 },
        })).toString("base64"),
        messageId: "msg-1",
      },
      subscription: "projects/fina/subscriptions/iap-rtdn",
    };
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/google",
      headers: { authorization: "Bearer fake-jwt" },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
  });

  it("testNotification → 200 ignore", async () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ testNotification: { version: "1.0" } })).toString("base64"),
        messageId: "msg-test",
      },
      subscription: "projects/fina/subscriptions/iap-rtdn",
    };
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/google",
      headers: { authorization: "Bearer fake-jwt" },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
    expect(fakeGoogleClient.fetchAndNormalize).not.toHaveBeenCalled();
  });
});
