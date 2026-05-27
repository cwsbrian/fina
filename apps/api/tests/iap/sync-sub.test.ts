import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncSubscriptionFromIAP } from "../../src/iap/sync-sub.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { deriveAppleToken, deriveGoogleToken } from "../../src/iap/binding.js";

const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = {
  fetchAndNormalize: vi.fn(),
  acknowledgeIfPending: vi.fn().mockResolvedValue(true),
};

const cfg = {
  apple: { bundleId: "com.fina.app", env: "sandbox" as const, ascIssuerId: "i", ascKeyId: "k", ascPrivateKey: "p" },
  google: { packageName: "app.fina", serviceAccount: {} as any, pubsubVerifyAudience: "a", pubsubVerifyEmail: "e", pubsubSubscriptionName: "s" },
};

describe("syncSubscriptionFromIAP — Apple checkout path", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
  });

  it("upserts Subscription + writes User.iapAppleAccountToken on success", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "pro_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(cfg, {
      platform: "ios",
      receipt: "jws",
      userId: "u1",
      expectedAppAccountToken: deriveAppleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub).not.toBeNull();
    expect(sub!.source).toBe("iap_apple");
    expect(sub!.sourceSubscriptionId).toBe("OT-1");
    expect(sub!.tier).toBe("pro");
    expect(sub!.environment).toBe("Sandbox");

    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapAppleAccountToken).toBe(deriveAppleToken("u1"));
  });

  it("403 user_mismatch when verified appAccountToken disagrees with expected", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("OTHER-USER"),
      productId: "pro_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });

    await expect(
      syncSubscriptionFromIAP(cfg, {
        platform: "ios", receipt: "jws", userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
      }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient }),
    ).rejects.toMatchObject({ code: "user_mismatch", statusCode: 403 });
  });

  it("derives tier from VERIFIED productId, not from request body", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Production",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "lite_monthly",
      originalTransactionId: "OT-2", transactionId: "T-2",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "lite_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    await syncSubscriptionFromIAP(cfg, {
      platform: "ios", receipt: "jws", userId: "u1",
      productId: "pro_monthly",
      expectedAppAccountToken: deriveAppleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.tier).toBe("lite");
  });
});

describe("syncSubscriptionFromIAP — Google checkout path", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
  });

  it("upserts + writes iapGoogleObfuscatedId + acknowledges", async () => {
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null,
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockResolvedValue(true);

    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-1", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.source).toBe("iap_google");
    expect(sub!.sourceSubscriptionId).toBe("pt-1");
    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapGoogleObfuscatedId).toBe(deriveGoogleToken("u1"));
    expect(fakeGoogleClient.acknowledgeIfPending).toHaveBeenCalledWith({
      purchaseToken: "pt-1",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
  });

  it("acknowledge runs AFTER upsert succeeds (not before)", async () => {
    const order: string[] = [];
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null, environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockImplementation(async () => {
      order.push("ack");
    });
    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-2", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });
    const sub = await prisma.subscription.findFirst({ where: { userId: "u1", sourceSubscriptionId: "pt-2" } });
    expect(sub).not.toBeNull();
    expect(order).toEqual(["ack"]);
  });

  it("rewrites existing row on linkedPurchaseToken chain", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "lite", source: "iap_google",
      sourceSubscriptionId: "pt-old", sourceCustomerId: deriveGoogleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30*86400_000),
      environment: "Production",
    } });

    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: "pt-old",
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });

    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-new", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const all = await prisma.subscription.findMany({ where: { userId: "u1" } });
    expect(all.length).toBe(1);
    expect(all[0].sourceSubscriptionId).toBe("pt-new");
    expect(all[0].tier).toBe("pro");
  });
});
