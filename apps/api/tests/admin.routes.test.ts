import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { getOwnerWorkspaceId, signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv({ APPLE_ENV: "production" });

function expectSafeUserShape(row: Record<string, unknown>) {
  expect(Object.keys(row).sort()).toEqual([
    "activeSubscriptionCount",
    "createdAt",
    "email",
    "id",
    "isPlanMismatch",
    "name",
    "role",
    "subscription",
    "tier",
    "trial",
  ].sort());
  expect(Object.keys(row.trial as Record<string, unknown>).sort()).toEqual(["active", "endsAt"]);
  if (row.subscription) {
    expect(Object.keys(row.subscription as Record<string, unknown>).sort()).toEqual([
      "cancelAtPeriodEnd",
      "currentPeriodEnd",
      "environment",
      "pendingTier",
      "pendingTierAt",
      "source",
      "status",
      "tier",
    ].sort());
  }
}

async function createAdmin(app: Awaited<ReturnType<typeof buildApp>>) {
  const admin = await signUpAndGetCookie(app, { email: "admin-list@example.com" });
  await prisma.user.update({ where: { id: admin.userId }, data: { role: "admin" } });
  return admin;
}

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

  it("paginates without skipping or duplicating users", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
    const a = await signUpAndGetCookie(app, { email: "page-a@example.com" });
    const b = await signUpAndGetCookie(app, { email: "page-b@example.com" });
    const c = await signUpAndGetCookie(app, { email: "page-c@example.com" });
    await prisma.user.update({ where: { id: admin.userId }, data: { createdAt: new Date("2026-06-12T00:00:04Z") } });
    await prisma.user.update({ where: { id: c.userId }, data: { createdAt: new Date("2026-06-12T00:00:03Z") } });
    await prisma.user.update({ where: { id: b.userId }, data: { createdAt: new Date("2026-06-12T00:00:02Z") } });
    await prisma.user.update({ where: { id: a.userId }, data: { createdAt: new Date("2026-06-12T00:00:01Z") } });

    const page1 = await app.inject({
      method: "GET",
      url: "/admin/users?limit=2",
      headers: { cookie: admin.cookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(typeof page1.json().nextCursor).toBe("string");

    const page2 = await app.inject({
      method: "GET",
      url: `/admin/users?limit=2&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers: { cookie: admin.cookie },
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().nextCursor).toBeNull();

    const ids = [...page1.json().users, ...page2.json().users].map((u: { id: string }) => u.id);
    expect(ids).toEqual([admin.userId, c.userId, b.userId, a.userId]);
    expect(new Set(ids).size).toBe(ids.length);
    await app.close();
  });

  it("returns safe fields and filters production subscription state", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
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
      url: "/admin/users?limit=10",
      headers: { cookie: admin.cookie },
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
      expect.objectContaining({ adminUserId: admin.userId, limit: 10, returned: expect.any(Number) }),
      "admin_users_listed",
    );
    expect(JSON.stringify(infoSpy.mock.calls)).not.toContain("paid@example.com");
    await app.close();
  });

  it("uses Stripe as primary subscription even when IAP has a higher tier", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
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
      url: "/admin/users?limit=10",
      headers: { cookie: admin.cookie },
    });

    const row = res.json().users.find((u: { email: string }) => u.email === "stripe-primary@example.com");
    expect(row.tier).toBe("max");
    expect(row.activeSubscriptionCount).toBe(2);
    expect(row.subscription).toMatchObject({ source: "stripe", tier: "pro" });
    await app.close();
  });

  it("uses max over pro among non-Stripe subscriptions", async () => {
    const app = await buildApp(env);
    const admin = await createAdmin(app);
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
      url: "/admin/users?limit=10",
      headers: { cookie: admin.cookie },
    });

    const row = res.json().users.find((u: { email: string }) => u.email === "iap-primary@example.com");
    expect(row.tier).toBe("max");
    expect(row.activeSubscriptionCount).toBe(2);
    expect(row.subscription).toMatchObject({ source: "iap_google", tier: "max" });
    await app.close();
  });
});
