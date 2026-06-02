import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const stripe = await vi.hoisted(async () => {
  const { makeStripeMock } = await import("./helpers/stripe-mock.js");
  return makeStripeMock();
});
vi.mock("../src/stripe/client.js", () => ({
  stripeClient: () => stripe.asStripe(),
  _clearStripeClientCache: () => {},
}));
vi.mock("../src/plaid/reconcile.js", () => ({
  reconcilePlaidItemsForUser: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  reconcileOrphanPlaidItems: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  retryPendingPlaidBillingCleanups: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  refreshBillingStateForUser: vi.fn().mockResolvedValue(undefined),
}));

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { reconcilePlaidItemsForUser } from "../src/plaid/reconcile.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3100",
  PLAID_CLIENT_ID: "test",
  PLAID_SECRET: "test",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
};

function fakeStripeSub(opts: {
  id?: string; customer?: string; priceId?: string; status?: string; cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id ?? "sub_test",
    customer: opts.customer ?? "cus_test",
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
    items: { data: [{ price: { id: opts.priceId ?? env.STRIPE_PRICE_PRO_MONTHLY } }] },
  } as any;
}

describe("POST /billing/sync", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    // Default: no subs for list calls (individual tests override as needed).
    stripe.fns.subsList.mockResolvedValue({ data: [] });
  });
  afterAll(async () => {
    await disconnect();
  });

  it("resolves first-Checkout return via sessionId even without stored customerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s1@example.com", name: "S One" });
    stripe.fns.sessionsRetrieve.mockResolvedValue({
      id: "cs_xyz",
      customer: "cus_first",
      subscription: "sub_first",
      client_reference_id: user.userId,
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_first", customer: "cus_first" }));

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { sessionId: "cs_xyz" },
    });

    expect(res.statusCode).toBe(200);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_first");
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_first" } },
    });
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
    expect(res.json().subscription).toMatchObject({ tier: "pro", status: "active", source: "stripe" });
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.userId);
  });

  it("rejects sessionId that does not belong to the caller", async () => {
    const app = await buildApp(env);
    const attacker = await signUpAndGetCookie(app, { email: "s2a@example.com", name: "Attacker" });
    const victim = await signUpAndGetCookie(app, { email: "s2v@example.com", name: "Victim" });
    stripe.fns.sessionsRetrieve.mockResolvedValue({
      id: "cs_victim",
      customer: "cus_victim",
      subscription: "sub_victim",
      client_reference_id: victim.userId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: attacker.cookie, "content-type": "application/json" },
      payload: { sessionId: "cs_victim" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("checkout_failed");
    const stillNoSub = await prisma.subscription.count({ where: { userId: attacker.userId } });
    expect(stillNoSub).toBe(0);
  });

  it("falls back to customer.subscriptions.list when no sessionId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s3@example.com", name: "S Three" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_s3" },
    });
    stripe.fns.subsList.mockResolvedValue({
      data: [fakeStripeSub({ id: "sub_s3", customer: "cus_s3" })],
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_s3", customer: "cus_s3" }));

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(stripe.fns.subsList).toHaveBeenCalledWith({
      customer: "cus_s3",
      status: "all",
      limit: 10,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_s3" } },
    });
    expect(sub.tier).toBe("pro");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.userId);
  });

  it("no-op for user with neither sessionId nor stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s4@example.com", name: "S Four" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(stripe.fns.sessionsRetrieve).not.toHaveBeenCalled();
    expect(stripe.fns.subsList).not.toHaveBeenCalled();
    expect(reconcilePlaidItemsForUser).not.toHaveBeenCalled();
    expect(res.json().subscription).toBeNull();
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "POST", url: "/billing/sync", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
