import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncSubscriptionFromIAP } from "../../src/iap/sync-sub.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { deriveAppleToken, deriveGoogleToken } from "../../src/iap/binding.js";
import { HttpError } from "../../src/auth/context.js";

const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = {
  fetchAndNormalize: vi.fn(),
  acknowledgeIfPending: vi.fn().mockResolvedValue(true),
};

const cfg = {
  apple: {
    bundleId: "com.fina.app",
    env: "sandbox" as const,
    ascIssuerId: "i",
    ascKeyId: "k",
    ascPrivateKey: "p",
  },
  google: {
    packageName: "app.fina",
    serviceAccount: {} as any,
    pubsubVerifyAudience: "a",
    pubsubVerifyEmail: "e",
    pubsubSubscriptionName: "s",
  },
};

describe("syncSubscriptionFromIAP — Apple checkout path", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
  });

  it("upserts Subscription + writes User.iapAppleAccountToken on success", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "max_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });
    const periodEnd = new Date(Date.now() + 30 * 86400_000);
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: periodEnd,
      productId: "max_monthly",
      pendingProductId: "fina_pro_monthly",
      pendingAt: periodEnd,
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub).not.toBeNull();
    expect(sub!.source).toBe("iap_apple");
    expect(sub!.sourceSubscriptionId).toBe("OT-1");
    expect(sub!.tier).toBe("max");
    expect(sub!.pendingTier).toBe("pro");
    expect(sub!.pendingTierAt?.getTime()).toBe(periodEnd.getTime());
    expect(sub!.environment).toBe("Sandbox");

    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapAppleAccountToken).toBe(deriveAppleToken("u1"));
  });

  it("consumes the app trial when Apple sync confirms an active subscription", async () => {
    const futureTrialEnd = new Date(Date.now() + 7 * 86400_000);
    await prisma.user.update({
      where: { id: "u1" },
      data: { trialStartedAt: new Date(), trialEndsAt: futureTrialEnd, trialConsumed: false },
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "max_monthly",
      originalTransactionId: "OT-trial",
      transactionId: "T-trial",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(user.trialConsumed).toBe(true);
    expect(user.trialEndsAt!.getTime()).toBeLessThan(futureTrialEnd.getTime());
  });

  it("403 user_mismatch when verified appAccountToken disagrees with expected", async () => {
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

    await expect(
      syncSubscriptionFromIAP(
        cfg,
        {
          platform: "ios",
          receipt: "jws",
          userId: "u1",
          expectedAppAccountToken: deriveAppleToken("u1"),
        },
        { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
      ),
    ).rejects.toMatchObject({ code: "user_mismatch", statusCode: 403 });
  });

  it("derives tier from latest ASC status productId, not stale receipt or request body", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Production",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "fina_pro_monthly",
      originalTransactionId: "OT-2",
      transactionId: "T-2",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "jws",
        userId: "u1",
        productId: "max_monthly",
        expectedAppAccountToken: deriveAppleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.tier).toBe("max");
  });

  it("uses restore verification context for Apple restore", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now() - 30 * 86400_000,
      appAccountToken: deriveAppleToken("u1"),
      productId: "max_monthly",
      originalTransactionId: "OT-restore",
      transactionId: "T-restore",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "old-restore-jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
        context: "restore",
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    expect(fakeAppleClient.verifyAndDecodeTransaction).toHaveBeenCalledWith("old-restore-jws", {
      context: "restore",
    });
  });

  it("allows Apple restore to claim an unbound subscription with an old appAccountToken", async () => {
    const oldToken = deriveAppleToken("OLD-USER");
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: oldToken,
      productId: "max_monthly",
      originalTransactionId: "OT-old-token-restore",
      transactionId: "T-old-token-restore",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "old-token-restore-jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
        context: "restore",
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.tier).toBe("max");
    expect(sub!.sourceSubscriptionId).toBe("OT-old-token-restore");
    expect(sub!.sourceCustomerId).toBe(oldToken);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(user.iapAppleAccountToken).toBe(oldToken);
  });

  it("rejects Apple restore when the old appAccountToken is bound to another user", async () => {
    const oldToken = deriveAppleToken("OLD-USER");
    await prisma.user.create({
      data: { id: "u2", email: "u2@test", iapAppleAccountToken: oldToken },
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: oldToken,
      productId: "max_monthly",
      originalTransactionId: "OT-bound-token-restore",
      transactionId: "T-bound-token-restore",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await expect(
      syncSubscriptionFromIAP(
        cfg,
        {
          platform: "ios",
          receipt: "bound-token-restore-jws",
          userId: "u1",
          expectedAppAccountToken: deriveAppleToken("u1"),
          context: "restore",
        },
        { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
      ),
    ).rejects.toMatchObject({ code: "user_mismatch", statusCode: 403 });
  });

  it("restores a native Apple subscription without appAccountToken for the signed-in user", async () => {
    const futureTrialEnd = new Date(Date.now() + 7 * 86400_000);
    await prisma.user.update({
      where: { id: "u1" },
      data: { trialStartedAt: new Date(), trialEndsAt: futureTrialEnd, trialConsumed: false },
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: null,
      productId: "max_monthly",
      originalTransactionId: "OT-native-restore",
      transactionId: "T-native-restore",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "max_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "native-restore-jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
        context: "restore",
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.source).toBe("iap_apple");
    expect(sub!.sourceSubscriptionId).toBe("OT-native-restore");
    expect(sub!.tier).toBe("max");
    expect(sub!.sourceCustomerId).toBeNull();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(user.iapAppleAccountToken).toBeNull();
    expect(user.trialConsumed).toBe(true);
    expect(user.trialEndsAt!.getTime()).toBeLessThan(futureTrialEnd.getTime());
  });

  it("falls back to the verified Apple transaction when ASC status is unavailable during restore", async () => {
    const expiresDate = new Date(Date.now() + 30 * 86400_000);
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app",
      environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: null,
      productId: "fina_pro_monthly",
      originalTransactionId: "OT-asc-unavailable-restore",
      transactionId: "T-asc-unavailable-restore",
      raw: { expiresDate: expiresDate.getTime() },
    });
    fakeAppleClient.getSubscriptionStatus.mockRejectedValue(
      new HttpError(502, "platform_unavailable", "asc api: status=401"),
    );

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "ios",
        receipt: "native-restore-jws",
        userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
        context: "restore",
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub).toMatchObject({
      source: "iap_apple",
      sourceSubscriptionId: "OT-asc-unavailable-restore",
      tier: "pro",
      status: "active",
      environment: "Sandbox",
    });
    expect(sub!.currentPeriodEnd.getTime()).toBe(expiresDate.getTime());
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
      productId: "max_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      pendingProductId: "pro_monthly",
      pendingAt: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null,
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockResolvedValue(true);

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "android",
        receipt: "pt-1",
        userId: "u1",
        expectedObfuscatedAccountId: deriveGoogleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.source).toBe("iap_google");
    expect(sub!.sourceSubscriptionId).toBe("pt-1");
    expect(sub!.pendingTier).toBe("pro");
    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapGoogleObfuscatedId).toBe(deriveGoogleToken("u1"));
    expect(fakeGoogleClient.acknowledgeIfPending).toHaveBeenCalledWith({
      purchaseToken: "pt-1",
      productId: "max_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
  });

  it("acknowledge runs AFTER upsert succeeds (not before)", async () => {
    const order: string[] = [];
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "max_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null,
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockImplementation(async () => {
      order.push("ack");
    });
    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "android",
        receipt: "pt-2",
        userId: "u1",
        expectedObfuscatedAccountId: deriveGoogleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );
    const sub = await prisma.subscription.findFirst({
      where: { userId: "u1", sourceSubscriptionId: "pt-2" },
    });
    expect(sub).not.toBeNull();
    expect(order).toEqual(["ack"]);
  });

  it("rewrites existing row on linkedPurchaseToken chain", async () => {
    await prisma.subscription.create({
      data: {
        userId: "u1",
        tier: "pro",
        source: "iap_google",
        sourceSubscriptionId: "pt-old",
        sourceCustomerId: deriveGoogleToken("u1"),
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Production",
      },
    });

    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "max_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: "pt-old",
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });

    await syncSubscriptionFromIAP(
      cfg,
      {
        platform: "android",
        receipt: "pt-new",
        userId: "u1",
        expectedObfuscatedAccountId: deriveGoogleToken("u1"),
      },
      { appleClient: fakeAppleClient, googleClient: fakeGoogleClient },
    );

    const all = await prisma.subscription.findMany({ where: { userId: "u1" } });
    expect(all.length).toBe(1);
    expect(all[0]!.sourceSubscriptionId).toBe("pt-new");
    expect(all[0]!.tier).toBe("max");
  });
});
