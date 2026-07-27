import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { HttpError } from "../src/auth/context.js";
import type { AdminTokenVerifier } from "../src/auth/admin-token.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { getOwnerWorkspaceId, signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv({ APPLE_ENV: "production" });
const actor = {
  sub: "cf-operator-1",
  email: "operator@example.com",
  jti: "request-token-1",
};
const requestId = "d9428888-122b-11e1-b85c-61cd3cbb3210";
const adminTokenVerifier: AdminTokenVerifier = vi.fn().mockResolvedValue(actor);
const internalHeaders = {
  authorization: "Bearer delegated-token",
  "x-request-id": requestId,
};

function buildInternalApp(verifier: AdminTokenVerifier = adminTokenVerifier) {
  return buildApp(env, { adminTokenVerifier: verifier });
}

function expectSafeUserShape(row: Record<string, unknown>) {
  expect(Object.keys(row).sort()).toEqual(
    [
      "activeSubscriptionCount",
      "createdAt",
      "deviceSummary",
      "email",
      "id",
      "isPlanMismatch",
      "name",
      "role",
      "subscription",
      "tier",
      "trial",
    ].sort(),
  );
  expect(Object.keys(row.trial as Record<string, unknown>).sort()).toEqual(["active", "endsAt"]);
  if (row.subscription) {
    expect(Object.keys(row.subscription as Record<string, unknown>).sort()).toEqual(
      [
        "cancelAtPeriodEnd",
        "currentPeriodEnd",
        "environment",
        "pendingTier",
        "pendingTierAt",
        "source",
        "status",
        "tier",
      ].sort(),
    );
  }
}

async function createAdmin(app: Awaited<ReturnType<typeof buildApp>>) {
  const admin = await signUpAndGetCookie(app, { email: "admin-list@example.com" });
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "admin" } });
  return admin;
}

describe("internal admin delegation guard", () => {
  it.each([
    ["/internal/admin/users", "findMany"],
    ["/internal/admin/users/user-1", "findUnique"],
  ] as const)("rejects %s before querying", async (url, queryMethod) => {
    const verifier = vi.fn().mockRejectedValue(new HttpError(401, "unauthenticated"));
    const query = vi.spyOn(prisma.user, queryMethod);
    const app = await buildInternalApp(verifier);

    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer rejected" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /admin/users", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("401 without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
    await app.close();
  });

  it("403 for a workspace owner who is not a global admin", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "owner-not-admin@example.com" });
    const wsId = await getOwnerWorkspaceId(user.userId);
    const res = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie: user.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_required");
    await app.close();
  });

  it("400 for an invalid cursor", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
    const res = await app.inject({
      method: "GET",
      url: "/admin/users?cursor=not-a-valid-cursor",
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_query");
    await app.close();
  });

  it("retains Better Auth admin access to the legacy list and detail routes", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);

    const list = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie: admin.cookie },
    });
    const detail = await app.inject({
      method: "GET",
      url: `/admin/users/${admin.userId}`,
      headers: { cookie: admin.cookie },
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().users).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: admin.userId })]),
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json().user.id).toBe(admin.userId);
    await app.close();
  });
});

describe("GET /internal/admin/users", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("rejects a valid Better Auth admin cookie without delegation", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);

    const res = await app.inject({
      method: "GET",
      url: "/internal/admin/users",
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthenticated");
    await app.close();
  });

  it("paginates without skipping or duplicating users", async () => {
    const app = await buildInternalApp();
    const a = await signUpAndGetCookie(app, { email: "page-a@example.com" });
    const b = await signUpAndGetCookie(app, { email: "page-b@example.com" });
    const c = await signUpAndGetCookie(app, { email: "page-c@example.com" });
    await prisma.user.update({
      where: { id: c.userId },
      data: { createdAt: new Date("2026-06-12T00:00:03Z") },
    });
    await prisma.user.update({
      where: { id: b.userId },
      data: { createdAt: new Date("2026-06-12T00:00:02Z") },
    });
    await prisma.user.update({
      where: { id: a.userId },
      data: { createdAt: new Date("2026-06-12T00:00:01Z") },
    });

    const page1 = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=2",
      headers: internalHeaders,
    });
    expect(page1.statusCode).toBe(200);
    expect(typeof page1.json().nextCursor).toBe("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/internal/admin/users?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers: internalHeaders,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().nextCursor).toBeNull();

    const ids = [...page1.json().users, ...page2.json().users].map((u: { id: string }) => u.id);
    expect(ids).toEqual([c.userId, b.userId, a.userId]);
    expect(new Set(ids).size).toBe(ids.length);
    await app.close();
  });

  it("returns safe fields and filters production subscription state", async () => {
    const app = await buildInternalApp();
    const paid = await signUpAndGetCookie(app, { email: "paid@example.com", name: "Paid User" });
    const infoSpy = vi.spyOn(app.log, "info");
    await prisma.user.update({
      where: { id: paid.userId },
      data: {
        trialEndsAt: new Date("2026-06-01T00:00:00Z"),
        trialConsumed: true,
        stripeCustomerId: "cus_secret_admin",
        iapAppleAccountToken: "apple-secret-token",
        iapGoogleObfuscatedId: "google-secret-obf",
        notificationPrefs: { productUpdates: false },
        isPlanMismatch: true,
      },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: paid.userId,
          tier: "max",
          source: "iap_google",
          sourceSubscriptionId: "google_secret_sub",
          status: "active",
          currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
          environment: "Sandbox",
        },
        {
          userId: paid.userId,
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "stripe_secret_active",
          sourceCustomerId: "cus_secret_admin",
          status: "past_due",
          currentPeriodEnd: new Date("2026-07-02T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: paid.userId,
          tier: "max",
          source: "stripe",
          sourceSubscriptionId: "stripe_secret_canceled",
          sourceCustomerId: "cus_secret_admin",
          status: "canceled",
          currentPeriodEnd: new Date("2026-07-03T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: paid.userId,
          tier: "max",
          source: "stripe",
          sourceSubscriptionId: "stripe_secret_unpaid",
          sourceCustomerId: "cus_secret_admin",
          status: "unpaid",
          currentPeriodEnd: new Date("2026-07-04T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: paid.userId,
          tier: "max",
          source: "stripe",
          sourceSubscriptionId: "stripe_secret_incomplete",
          sourceCustomerId: "cus_secret_admin",
          status: "incomplete",
          currentPeriodEnd: new Date("2026-07-05T00:00:00Z"),
          environment: "Production",
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=10",
      headers: internalHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const paidRow = res.json().users.find((u: { email: string }) => u.email === "paid@example.com");
    expectSafeUserShape(paidRow);
    expect(paidRow).toMatchObject({
      email: "paid@example.com",
      name: "Paid User",
      role: "user",
      tier: "pro",
      deviceSummary: expect.any(Array),
      activeSubscriptionCount: 1,
      isPlanMismatch: true,
      subscription: {
        tier: "pro",
        status: "past_due",
        source: "stripe",
        environment: "Production",
      },
    });
    const serialized = JSON.stringify(paidRow);
    expect(serialized).not.toContain("cus_secret_admin");
    expect(serialized).not.toContain("apple-secret-token");
    expect(serialized).not.toContain("google-secret-obf");
    expect(serialized).not.toContain("stripe_secret");
    expect(serialized).not.toContain("google_secret_sub");
    expect(serialized).not.toContain("notificationPrefs");
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        adminSubject: actor.sub,
        limit: 10,
        returned: expect.any(Number),
      }),
      "admin_users_listed",
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("paid@example.com");
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("delegated-token");
    await app.close();
  });

  it("uses Stripe as primary subscription even when IAP has a higher tier", async () => {
    const app = await buildInternalApp();
    const user = await signUpAndGetCookie(app, { email: "stripe-primary@example.com" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date("2026-06-01T00:00:00Z"), trialConsumed: true },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: user.userId,
          tier: "max",
          source: "iap_apple",
          sourceSubscriptionId: "apple-prod-max",
          status: "active",
          currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: user.userId,
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "stripe-prod-pro",
          status: "active",
          currentPeriodEnd: new Date("2026-07-02T00:00:00Z"),
          environment: "Production",
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=10",
      headers: internalHeaders,
    });

    const row = res
      .json()
      .users.find((u: { email: string }) => u.email === "stripe-primary@example.com");
    expect(row.tier).toBe("max");
    expect(row.activeSubscriptionCount).toBe(2);
    expect(row.subscription).toMatchObject({ source: "stripe", tier: "pro" });
    await app.close();
  });

  it("uses max over pro among non-Stripe subscriptions", async () => {
    const app = await buildInternalApp();
    const user = await signUpAndGetCookie(app, { email: "iap-primary@example.com" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date("2026-06-01T00:00:00Z"), trialConsumed: true },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: user.userId,
          tier: "pro",
          source: "iap_apple",
          sourceSubscriptionId: "apple-prod-pro",
          status: "active",
          currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: user.userId,
          tier: "max",
          source: "iap_google",
          sourceSubscriptionId: "google-prod-max",
          status: "active",
          currentPeriodEnd: new Date("2026-07-02T00:00:00Z"),
          environment: "Production",
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=10",
      headers: internalHeaders,
    });

    const row = res
      .json()
      .users.find((u: { email: string }) => u.email === "iap-primary@example.com");
    expect(row.tier).toBe("max");
    expect(row.activeSubscriptionCount).toBe(2);
    expect(row.subscription).toMatchObject({ source: "iap_google", tier: "max" });
    await app.close();
  });
});

describe("GET /internal/admin/users/:userId", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("returns device, Plaid, activity, and AI usage detail without secrets", async () => {
    const app = await buildInternalApp();
    const infoSpy = vi.spyOn(app.log, "info");
    const user = await signUpAndGetCookie(app, {
      email: "detail@example.com",
      name: "Detail User",
    });
    const wsId = await getOwnerWorkspaceId(user.userId);
    await prisma.session.updateMany({
      where: { userId: user.userId },
      data: {
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        updatedAt: new Date("2026-06-15T10:00:00Z"),
      },
    });
    await prisma.userDevice.createMany({
      data: [
        {
          userId: user.userId,
          clientDeviceId: "secret-device-id",
          expoPushToken: "ExponentPushToken[secret]",
          platform: "ios",
          lastSeenAt: new Date("2026-06-20T10:00:00Z"),
        },
        {
          userId: user.userId,
          platform: "android",
          lastSeenAt: new Date("2026-06-10T10:00:00Z"),
        },
      ],
    });
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        connectedBy: user.userId,
        accessTokenCiphertext: Buffer.from("access-secret-token"),
        accessTokenIv: Buffer.from("123456789012"),
        itemId: "plaid-secret-item-id",
        institutionId: "ins_1",
        institutionName: "Test Bank",
        lastSyncAt: new Date("2026-06-18T10:00:00Z"),
      },
    });
    const account = await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidItemId: item.id,
        plaidAccountId: "plaid-secret-account-id",
        name: "Chequing",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        lastBalanceSyncAt: new Date("2026-06-18T10:00:00Z"),
      },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: account.id,
        plaidItemId: item.id,
        plaidTransactionId: "plaid-secret-transaction-id",
        amount: "12.34",
        merchantRaw: "Coffee",
        occurredAt: new Date("2026-06-19T12:00:00Z"),
        rawData: {},
      },
    });
    const thread = await prisma.chatThread.create({
      data: {
        userId: user.userId,
        workspaceId: wsId,
        lastMessageAt: new Date("2026-06-21T10:00:00Z"),
      },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        role: "user",
        blocks: [{ type: "text", markdown: "hello" }],
        createdAt: new Date("2026-06-21T10:00:00Z"),
      },
    });
    await prisma.llmCallLog.createMany({
      data: [
        {
          userId: user.userId,
          source: "chat",
          model: "deepseek-v4-flash",
          inputTokens: 100,
          outputTokens: 20,
          costUsd: "0.010000",
          costCad: "0.014000",
          usdToCadRate: "1.400000",
          createdAt: new Date("2026-06-21T10:00:00Z"),
        },
        {
          userId: user.userId,
          source: "brief",
          model: "deepseek-v4-flash",
          inputTokens: 50,
          outputTokens: 10,
          costUsd: "0.020000",
          costCad: "0.028000",
          usdToCadRate: "1.400000",
          createdAt: new Date("2026-05-01T10:00:00Z"),
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${user.userId}`,
      headers: internalHeaders,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({
      user: { id: user.userId, email: "detail@example.com" },
      activity: {
        lastSeenAt: "2026-06-21T10:00:00.000Z",
        transactionCount: 1,
        chatMessageCount: 1,
      },
      aiUsage: {
        total: { callCount: 2, inputTokens: 150, outputTokens: 30, costCad: "0.042000" },
        monthly: [
          {
            month: "2026-06",
            callCount: 1,
            inputTokens: 100,
            outputTokens: 20,
            costCad: "0.014000",
          },
          {
            month: "2026-05",
            callCount: 1,
            inputTokens: 50,
            outputTokens: 10,
            costCad: "0.028000",
          },
        ],
      },
      plaidItems: [
        {
          institutionName: "Test Bank",
          status: "active",
          accounts: [{ name: "Chequing", mask: "1234", type: "depository", subtype: "checking" }],
        },
      ],
    });
    expect(res.json().devices.map((d: { platform: string }) => d.platform)).toEqual([
      "ios",
      "android",
    ]);
    const serialized = JSON.stringify(res.json());
    expect(serialized).not.toContain("access-secret-token");
    expect(serialized).not.toContain("plaid-secret");
    expect(serialized).not.toContain("ExponentPushToken");
    expect(serialized).not.toContain("secret-device-id");
    const detailLog = infoSpy.mock.calls.find((call) => call[1] === "admin_user_detail_viewed");
    expect(detailLog?.[0]).toMatchObject({
      requestId,
      adminSubject: actor.sub,
      action: "admin_user_detail_viewed",
    });
    expect(JSON.stringify(detailLog)).not.toContain("detail@example.com");
    expect(JSON.stringify(detailLog)).not.toContain("delegated-token");
    await app.close();
  });
});
