import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { HttpError } from "../src/auth/context.js";
import type { AdminTokenVerifier } from "../src/auth/admin-token.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import {
  getOwnerWorkspaceId,
  signUpAndGetCookie as signUpFixtureUser,
  type SignedUpUser,
} from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";
import { plaidApiError } from "./helpers/plaid-mock.js";
import { plaidClient } from "../src/plaid/client.js";
import { storeAccessToken } from "../src/plaid/items.js";

const env = testEnv({ APPLE_ENV: "production" });
const sandboxEnv = testEnv({ APPLE_ENV: "sandbox" });
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
let observedUserQuery: "findMany" | "findUnique" | null = null;
let observedUserQueryCalled = false;

async function signUpAndGetCookie(
  app: Parameters<typeof signUpFixtureUser>[0],
  opts?: Parameters<typeof signUpFixtureUser>[1],
): Promise<SignedUpUser> {
  const user = await signUpFixtureUser(app, opts);
  await prisma.user.update({
    where: { id: user.userId },
    data: { signupEnvironment: "PRODUCTION" },
  });
  return user;
}

prisma.$use(async (params, next) => {
  if (params.model === "User" && params.action === observedUserQuery) {
    observedUserQueryCalled = true;
  }
  return next(params);
});

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
      "signupEnvironment",
      "signupPlatform",
      "signupBuildNumber",
      "appleStoreEnvironment",
      "environmentVerifiedAt",
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
    ["/internal/admin/users", "findMany", "admin_users_listed"],
    ["/internal/admin/users/user-1", "findUnique", "admin_user_detail_viewed"],
  ] as const)(
    "rejects %s before session resolution or querying",
    async (url, queryMethod, action) => {
      const verifier = vi.fn().mockRejectedValue(new HttpError(401, "unauthenticated"));
      observedUserQuery = queryMethod;
      observedUserQueryCalled = false;
      const app = await buildInternalApp(verifier);
      const sessionResolver = vi
        .spyOn(app.fina.auth.api, "getSession")
        .mockRejectedValue(new Error("customer session resolver called"));
      const infoSpy = vi.spyOn(app.log, "info");

      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer rejected", cookie: "better-auth.session_token=secret" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().error).toBe("unauthenticated");
      expect(sessionResolver).not.toHaveBeenCalled();
      expect(verifier).toHaveBeenCalledWith("Bearer rejected");
      expect(observedUserQueryCalled).toBe(false);
      expect(infoSpy.mock.calls.find((call) => call[1] === "internal_admin_audit")?.[0]).toEqual({
        requestId: expect.any(String),
        action,
        outcome: "failure",
        status: 401,
        latencyMs: expect.any(Number),
      });
      observedUserQuery = null;
      await app.close();
    },
  );

  it.each(["/me", "/admin/users"])("keeps Better Auth session resolution on %s", async (url) => {
    const app = await buildInternalApp();
    const sessionResolver = vi.spyOn(app.fina.auth.api, "getSession").mockResolvedValue(null);

    await app.inject({
      method: "GET",
      url,
      headers: { cookie: "better-auth.session_token=customer" },
    });

    expect(sessionResolver).toHaveBeenCalled();
    await app.close();
  });

  it("includes the verified subject in a failed internal audit event", async () => {
    const app = await buildInternalApp();
    const infoSpy = vi.spyOn(app.log, "info");

    const res = await app.inject({
      method: "GET",
      url: "/internal/admin/users?cursor=invalid",
      headers: internalHeaders,
    });

    expect(res.statusCode).toBe(400);
    const auditCall = infoSpy.mock.calls.find((call) => call[1] === "internal_admin_audit");
    expect(auditCall?.[0]).toEqual({
      requestId,
      adminSubject: actor.sub,
      action: "admin_users_listed",
      outcome: "failure",
      status: 400,
      latencyMs: expect.any(Number),
    });
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

  it("shows production by default and keeps test and unknown users separate", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
    const testUser = await signUpAndGetCookie(app, { email: "test-user@example.com" });
    const unknownUser = await signUpAndGetCookie(app, { email: "unknown-user@example.com" });
    await prisma.user.update({
      where: { id: testUser.userId },
      data: { signupEnvironment: "TEST" },
    });
    await prisma.user.update({
      where: { id: unknownUser.userId },
      data: { signupEnvironment: "UNKNOWN" },
    });

    const production = await app.inject({
      method: "GET",
      url: "/admin/users",
      headers: { cookie: admin.cookie },
    });
    expect(production.json().users.map((user: { id: string }) => user.id)).toEqual([admin.userId]);

    const test = await app.inject({
      method: "GET",
      url: "/admin/users?environment=test",
      headers: { cookie: admin.cookie },
    });
    expect(test.json().users).toEqual([
      expect.objectContaining({ id: testUser.userId, signupEnvironment: "TEST" }),
    ]);

    const unknown = await app.inject({
      method: "GET",
      url: "/admin/users?environment=unknown",
      headers: { cookie: admin.cookie },
    });
    expect(unknown.json().users).toEqual([
      expect.objectContaining({ id: unknownUser.userId, signupEnvironment: "UNKNOWN" }),
    ]);
    await app.close();
  });
});

describe("GET /internal/admin/plaid-items", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("compares stored Items with Plaid without exposing access tokens", async () => {
    const app = await buildInternalApp();
    const user = await signUpAndGetCookie(app, { email: "plaid-owner@example.com" });
    const workspaceId = await getOwnerWorkspaceId(user.userId);
    await storeAccessToken(env, prisma, {
      workspaceId,
      connectedBy: user.userId,
      itemId: "item-reachable",
      institutionId: "ins_1",
      institutionName: "Reachable Bank",
      accessToken: "access-reachable",
    });
    await storeAccessToken(env, prisma, {
      workspaceId,
      connectedBy: user.userId,
      itemId: "item-missing",
      institutionId: "ins_2",
      institutionName: "Missing Bank",
      accessToken: "access-missing",
    });

    const itemGet = vi.spyOn(plaidClient(env), "itemGet").mockImplementation(async (request) => {
      if (request.access_token === "access-missing") {
        throw plaidApiError({ error_code: "ITEM_NOT_FOUND", http_status: 404 });
      }
      return {
        data: {
          item: {
            item_id: "item-reachable",
            institution_id: "ins_1",
            institution_name: "Reachable Bank",
            webhook: null,
            error: null,
            available_products: [],
            billed_products: ["transactions"],
            products: ["transactions"],
            consent_expiration_time: null,
            update_type: "background",
          },
          status: { transactions: { last_successful_update: "2026-09-10T12:00:00Z" } },
          request_id: "request-1",
        },
      } as never;
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/internal/admin/plaid-items",
        headers: internalHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        environment: "sandbox",
        summary: {
          trackedItemCount: 2,
          reachableItemCount: 1,
          transactionsBilledItemCount: 1,
          missingItemCount: 1,
          checkFailedItemCount: 0,
        },
        items: expect.arrayContaining([
          expect.objectContaining({
            itemId: "item-reachable",
            plaidStatus: "reachable",
            billedProducts: ["transactions"],
          }),
          expect.objectContaining({
            itemId: "item-missing",
            plaidStatus: "missing",
            plaidErrorCode: "ITEM_NOT_FOUND",
          }),
        ]),
      });
      expect(JSON.stringify(response.json())).not.toContain("access-reachable");
      expect(JSON.stringify(response.json())).not.toContain("access-missing");
    } finally {
      itemGet.mockRestore();
      await app.close();
    }
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

  it("returns the same whole-database summary on every page without double-counting users", async () => {
    const app = await buildInternalApp();
    const trial = await signUpAndGetCookie(app, { email: "summary-trial@example.com" });
    const pro = await signUpAndGetCookie(app, { email: "summary-pro@example.com" });
    const max = await signUpAndGetCookie(app, { email: "summary-max@example.com" });
    const sandbox = await signUpAndGetCookie(app, { email: "summary-sandbox@example.com" });
    const free = await signUpAndGetCookie(app, { email: "summary-free@example.com" });
    const expiredTrial = new Date("2026-01-01T00:00:00Z");

    await prisma.user.updateMany({
      where: { id: { in: [pro.userId, max.userId, sandbox.userId, free.userId] } },
      data: { trialEndsAt: expiredTrial, trialConsumed: true },
    });
    await prisma.user.update({
      where: { id: trial.userId },
      data: { trialEndsAt: new Date("2099-01-01T00:00:00Z") },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: trial.userId,
          tier: "max",
          source: "iap_google",
          sourceSubscriptionId: "summary-trial-over-max",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: pro.userId,
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "summary-prod-pro",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: max.userId,
          tier: "pro",
          source: "iap_apple",
          sourceSubscriptionId: "summary-overlap-pro",
          status: "past_due",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: max.userId,
          tier: "max",
          source: "iap_google",
          sourceSubscriptionId: "summary-overlap-max",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: sandbox.userId,
          tier: "max",
          source: "iap_apple",
          sourceSubscriptionId: "summary-sandbox-max",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Sandbox",
        },
        {
          userId: free.userId,
          tier: "max",
          source: "stripe",
          sourceSubscriptionId: "summary-canceled-max",
          status: "canceled",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
      ],
    });

    const page1 = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=2",
      headers: internalHeaders,
    });
    const page2 = await app.inject({
      method: "GET",
      url: `/internal/admin/users?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers: internalHeaders,
    });

    const expectedSummary = {
      userCount: 5,
      proUserCount: 2,
      maxUserCount: 1,
      activeTrialCount: 1,
    };
    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);
    expect(page1.json().summary).toEqual(expectedSummary);
    expect(page2.json().summary).toEqual(expectedSummary);

    const fullPage = await app.inject({
      method: "GET",
      url: "/internal/admin/users?limit=10",
      headers: internalHeaders,
    });
    const sandboxRow = fullPage
      .json()
      .users.find((user: { id: string }) => user.id === sandbox.userId);
    expect(sandboxRow).toMatchObject({
      tier: "free",
      subscription: null,
      activeSubscriptionCount: 0,
    });
    await app.close();
  });

  it("uses only Production subscriptions even when the API runtime is sandbox", async () => {
    const app = await buildApp(sandboxEnv, { adminTokenVerifier });
    const user = await signUpAndGetCookie(app, { email: "admin-production-only@example.com" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date("2026-01-01T00:00:00Z"), trialConsumed: true },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: user.userId,
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "admin-production-pro",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Production",
        },
        {
          userId: user.userId,
          tier: "max",
          source: "iap_apple",
          sourceSubscriptionId: "admin-sandbox-max",
          status: "active",
          currentPeriodEnd: new Date("2099-02-01T00:00:00Z"),
          environment: "Sandbox",
        },
      ],
    });

    const list = await app.inject({
      method: "GET",
      url: "/internal/admin/users",
      headers: internalHeaders,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${user.userId}`,
      headers: internalHeaders,
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().summary).toEqual({
      userCount: 1,
      proUserCount: 1,
      maxUserCount: 0,
      activeTrialCount: 0,
    });
    expect(list.json().users[0]).toMatchObject({
      tier: "pro",
      activeSubscriptionCount: 1,
      subscription: { tier: "pro", source: "stripe", environment: "Production" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().user).toMatchObject({
      tier: "pro",
      activeSubscriptionCount: 1,
      subscription: { tier: "pro", source: "stripe", environment: "Production" },
    });
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
    const successAuditCall = infoSpy.mock.calls.find((call) => call[1] === "internal_admin_audit");
    expect(successAuditCall?.[0]).toEqual({
      requestId,
      adminSubject: actor.sub,
      action: "admin_users_listed",
      outcome: "success",
      status: 200,
      returned: expect.any(Number),
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(successAuditCall)).not.toContain("paid@example.com");
    expect(JSON.stringify(successAuditCall)).not.toContain("delegated-token");
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
    const detailLog = infoSpy.mock.calls.find((call) => call[1] === "internal_admin_audit");
    expect(detailLog?.[0]).toEqual({
      requestId,
      adminSubject: actor.sub,
      action: "admin_user_detail_viewed",
      outcome: "success",
      status: 200,
      latencyMs: expect.any(Number),
    });
    expect(JSON.stringify(detailLog)).not.toContain("detail@example.com");
    expect(JSON.stringify(detailLog)).not.toContain("delegated-token");
    await app.close();
  });
});

describe("internal admin user transactions and chat content", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("requires delegated authorization for every content route", async () => {
    const verifier = vi.fn().mockRejectedValue(new HttpError(401, "unauthenticated"));
    const app = await buildInternalApp(verifier);
    const sessionResolver = vi
      .spyOn(app.fina.auth.api, "getSession")
      .mockRejectedValue(new Error("customer session resolver called"));
    const routes = [
      "/internal/admin/users/user-1/transactions",
      "/internal/admin/users/user-1/chat-threads",
      "/internal/admin/users/user-1/chat-threads/thread-1/messages",
    ];

    for (const url of routes) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer rejected" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().error).toBe("unauthenticated");
    }
    expect(verifier).toHaveBeenCalledTimes(3);
    expect(sessionResolver).not.toHaveBeenCalled();
    await app.close();
  });

  it("paginates safe transaction and message content without crossing users", async () => {
    const app = await buildInternalApp();
    const infoSpy = vi.spyOn(app.log, "info");
    const target = await signUpAndGetCookie(app, { email: "content-target@example.com" });
    const other = await signUpAndGetCookie(app, { email: "content-other@example.com" });
    const targetWorkspaceId = await getOwnerWorkspaceId(target.userId);
    const otherWorkspaceId = await getOwnerWorkspaceId(other.userId);
    const targetAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: targetWorkspaceId,
        name: "Daily chequing",
        mask: "4242",
        type: "depository",
      },
    });
    const otherAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: otherWorkspaceId,
        name: "Other account",
        type: "depository",
      },
    });
    const category = await prisma.category.create({
      data: { workspaceId: targetWorkspaceId, name: "Coffee" },
    });
    const olderTransaction = await prisma.transaction.create({
      data: {
        workspaceId: targetWorkspaceId,
        accountId: targetAccount.id,
        amount: "4.50",
        merchantRaw: "Old cafe",
        occurredAt: new Date("2026-07-01T12:00:00Z"),
        rawData: { secret: "plaid-raw-secret" },
        note: "Morning coffee",
        allocations: {
          create: { amount: "4.50", categoryId: category.id, source: "manual" },
        },
      },
    });
    const newerTransaction = await prisma.transaction.create({
      data: {
        workspaceId: targetWorkspaceId,
        accountId: targetAccount.id,
        amount: "18.25",
        merchantRaw: "New cafe",
        occurredAt: new Date("2026-07-02T12:00:00Z"),
        rawData: { secret: "another-raw-secret" },
      },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: otherWorkspaceId,
        accountId: otherAccount.id,
        amount: "99.00",
        merchantRaw: "Other user merchant",
        occurredAt: new Date("2026-07-03T12:00:00Z"),
        rawData: {},
      },
    });

    const firstTransactions = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/transactions?limit=1`,
      headers: internalHeaders,
    });
    expect(firstTransactions.statusCode).toBe(200);
    expect(firstTransactions.json()).toMatchObject({
      transactions: [
        {
          id: newerTransaction.id,
          merchantRaw: "New cafe",
          account: { name: "Daily chequing", mask: "4242" },
        },
      ],
    });
    expect(firstTransactions.json().nextCursor).toEqual(expect.any(String));

    const secondTransactions = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/transactions?limit=1&cursor=${encodeURIComponent(firstTransactions.json().nextCursor)}`,
      headers: internalHeaders,
    });
    expect(secondTransactions.statusCode).toBe(200);
    expect(secondTransactions.json()).toMatchObject({
      transactions: [
        {
          id: olderTransaction.id,
          note: "Morning coffee",
          allocations: [{ amount: "4.50", categoryName: "Coffee" }],
        },
      ],
      nextCursor: null,
    });
    const serializedTransactions = JSON.stringify([
      firstTransactions.json(),
      secondTransactions.json(),
    ]);
    expect(serializedTransactions).not.toContain("Other user merchant");
    expect(serializedTransactions).not.toContain("raw-secret");

    const targetThread = await prisma.chatThread.create({
      data: {
        userId: target.userId,
        workspaceId: targetWorkspaceId,
        title: "Budget check-in",
        lastMessageAt: new Date("2026-07-05T12:00:00Z"),
      },
    });
    const otherThread = await prisma.chatThread.create({
      data: {
        userId: other.userId,
        workspaceId: otherWorkspaceId,
        title: "Other private chat",
      },
    });
    await prisma.chatMessage.createMany({
      data: [
        {
          id: "content-message-1",
          threadId: targetThread.id,
          role: "user",
          blocks: [{ type: "text", markdown: "oldest" }],
          createdAt: new Date("2026-07-05T10:00:00Z"),
        },
        {
          id: "content-message-2",
          threadId: targetThread.id,
          role: "assistant",
          blocks: [{ type: "text", markdown: "middle" }],
          createdAt: new Date("2026-07-05T11:00:00Z"),
        },
        {
          id: "content-message-3",
          threadId: targetThread.id,
          role: "user",
          blocks: [{ type: "text", markdown: "newest" }],
          createdAt: new Date("2026-07-05T12:00:00Z"),
        },
        {
          id: "other-private-message",
          threadId: otherThread.id,
          role: "user",
          blocks: [{ type: "text", markdown: "private" }],
        },
      ],
    });

    const threads = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/chat-threads`,
      headers: internalHeaders,
    });
    expect(threads.statusCode).toBe(200);
    expect(threads.json().threads).toEqual([
      expect.objectContaining({ id: targetThread.id, title: "Budget check-in", messageCount: 3 }),
    ]);

    const firstMessages = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/chat-threads/${targetThread.id}/messages?limit=2`,
      headers: internalHeaders,
    });
    expect(firstMessages.statusCode).toBe(200);
    expect(firstMessages.json().messages.map((message: { id: string }) => message.id)).toEqual([
      "content-message-2",
      "content-message-3",
    ]);
    expect(firstMessages.json().nextCursor).toEqual(expect.any(String));

    const olderMessages = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/chat-threads/${targetThread.id}/messages?limit=2&cursor=${encodeURIComponent(firstMessages.json().nextCursor)}`,
      headers: internalHeaders,
    });
    expect(olderMessages.statusCode).toBe(200);
    expect(olderMessages.json().messages.map((message: { id: string }) => message.id)).toEqual([
      "content-message-1",
    ]);
    expect(olderMessages.json().nextCursor).toBeNull();

    const crossUserMessages = await app.inject({
      method: "GET",
      url: `/internal/admin/users/${target.userId}/chat-threads/${otherThread.id}/messages`,
      headers: internalHeaders,
    });
    expect(crossUserMessages.statusCode).toBe(404);
    const auditCalls = infoSpy.mock.calls.filter((call) => call[1] === "internal_admin_audit");
    expect(
      auditCalls.some(
        (call) => (call[0] as { action?: string }).action === "admin_user_transactions_viewed",
      ),
    ).toBe(true);
    expect(JSON.stringify(auditCalls)).not.toContain("plaid-raw-secret");
    expect(JSON.stringify(auditCalls)).not.toContain("delegated-token");
    await app.close();
  });
});
