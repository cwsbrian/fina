import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

describe("GET /me", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns user + tier=pro + trial active for fresh signup", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "me1@example.com", name: "Me One" });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("me1@example.com");
    expect(body).not.toHaveProperty("workspace");
    expect(body.tier).toBe("pro");
    expect(body.trial.active).toBe(true);
    expect(typeof body.trial.endsAt).toBe("string");
    await app.close();
  });

  it("returns tier=free when trial has ended", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "exp@example.com", name: "Exp" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("free");
    expect(body.trial.active).toBe(false);
    await app.close();
  });

  it("refreshes due native IAP subscription state before returning /me", async () => {
    const fakeAppleClient = {
      getSubscriptionStatus: vi.fn().mockResolvedValue({
        expiresDate: new Date("2026-06-11T22:27:02Z"),
        productId: "fina_pro_monthly",
        pendingProductId: null,
        pendingAt: null,
        mapped: { status: "active", cancelAtPeriodEnd: false },
      }),
    };
    const app = await buildApp(env, {
      iap: {
        appleClient: fakeAppleClient,
        googleClient: { fetchAndNormalize: vi.fn(), acknowledgeIfPending: vi.fn() },
        oidcClient: { verifyIdToken: vi.fn() },
      },
    });
    const user = await signUpAndGetCookie(app, { email: "iap-due@example.com", name: "IAP Due" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: new Date("2026-06-01T00:00:00Z"), trialConsumed: true },
    });
    await prisma.subscription.create({
      data: {
        userId: user.userId,
        tier: "max",
        source: "iap_apple",
        sourceSubscriptionId: "OT-DUE",
        status: "active",
        currentPeriodEnd: new Date(Date.now() - 1000),
        pendingTier: "pro",
        pendingTierAt: new Date(Date.now() - 1000),
        environment: "Sandbox",
      },
    });

    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie: user.cookie } });

    expect(res.statusCode).toBe(200);
    expect(fakeAppleClient.getSubscriptionStatus).toHaveBeenCalledWith("OT-DUE");
    expect(res.json().subscription).toMatchObject({
      tier: "pro",
      pendingTier: null,
      source: "iap_apple",
    });
    const sub = await prisma.subscription.findFirstOrThrow({
      where: { userId: user.userId, source: "iap_apple" },
    });
    expect(sub.tier).toBe("pro");
    expect(sub.pendingTier).toBeNull();
    await app.close();
  });

  it("returns 401 without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("PATCH /me", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("updates morningTime", async () => {
    const app = await buildApp(testEnv());
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "patchme1@t.co" });
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ morningTime: "09:30" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.morningTime).toBe("09:30");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.morningTime).toBe("09:30");
    await app.close();
  });

  it("rejects invalid morningTime", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "patchme2@t.co" });
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ morningTime: "9am" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    await app.close();
  });

  it("snoozeUntil null clears, string sets, undefined leaves alone", async () => {
    const app = await buildApp(testEnv());
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "patchme3@t.co" });

    // Set
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ snoozeUntil: "2026-06-15" }),
    });
    const afterSet = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterSet.snoozeUntil).not.toBeNull();

    // Leave alone (undefined — empty body)
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    const afterNoop = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterNoop.snoozeUntil?.getTime()).toBe(afterSet.snoozeUntil!.getTime());

    // Clear
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ snoozeUntil: null }),
    });
    const afterClear = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(afterClear.snoozeUntil).toBeNull();

    await app.close();
  });

  it("rejects invalid IANA tz", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "patchme4@t.co" });
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ tz: "Foo/Bar" }),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("PATCH then GET returns new user.morningTime", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "patchme5@t.co" });
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ morningTime: "07:15", pauseEnabled: true }),
    });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.morningTime).toBe("07:15");
    expect(res.json().user.pauseEnabled).toBe(true);
    await app.close();
  });

  it("GET /me default user.morningTime is 08:00 and snoozeUntil is null", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "patchme6@t.co" });
    const res = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(res.json().user.morningTime).toBe("08:00");
    expect(res.json().user.snoozeUntil).toBeNull();
    expect(res.json().user.pauseEnabled).toBe(false);
    await app.close();
  });
});

describe("categorizationMode", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("GET /me returns default 'flexible' for new user", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "cm1@t.co", name: "T" });
    const r = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.user.categorizationMode).toBe("flexible");
    await app.close();
  });

  it("PATCH /me sets categorizationMode='strict'", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "cm2@t.co", name: "T" });
    const r = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ categorizationMode: "strict" }),
    });
    expect(r.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
    expect(JSON.parse(me.body).user.categorizationMode).toBe("strict");
    await app.close();
  });

  it("PATCH /me rejects invalid categorizationMode", async () => {
    const app = await buildApp(testEnv());
    const { cookie } = await signUpAndGetCookie(app, { email: "cm3@t.co", name: "T" });
    const r = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ categorizationMode: "yolo" }),
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });
});

describe("PATCH /me notificationPrefs", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("PATCH applies new prefs (single field) → 200 + merged blob persisted", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np1@t.co" });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { morningBrief: false } }),
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, boolean>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.largeCharges).toBe(true);  // default merged in by route
    await app.close();
  });

  it("PATCH merges with existing prefs across 2 sequential patches", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np2@t.co" });

    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { morningBrief: false } }),
    });
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { largeCharges: false } }),
    });

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, boolean>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.largeCharges).toBe(false);
    expect(blob.bankReconnect).toBe(true);  // untouched default
    await app.close();
  });

  it("GET returns fully-populated notificationPrefs (defaults for unset)", async () => {
    const app = await buildApp(env);
    const { cookie } = await signUpAndGetCookie(app, { email: "np3@t.co" });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { user: { notificationPrefs: Record<string, boolean> } };
    expect(body.user.notificationPrefs).toEqual({
      morningBrief: true,
      bankReconnect: true,
      workspaceInvites: true,
      trialExpiring: true,
      goalMilestones: true,
      largeCharges: true,
      transactionAdded: true,
      productUpdates: true,
    });
    await app.close();
  });

  it("PATCH silently drops unknown keys (zod .partial() default-strip)", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np4@t.co" });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        notificationPrefs: { unknown: false, morningBrief: false },
      }),
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, unknown>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.unknown).toBeUndefined();
    await app.close();
  });
});
