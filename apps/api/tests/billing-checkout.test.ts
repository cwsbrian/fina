import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// vi.mock is hoisted by vitest's AST transform, so it must not reference
// any top-level const that is initialized after the hoist point. Use
// vi.hoisted() to create the mock object inside the hoisted scope, then
// reference only that binding in the vi.mock factory.
const stripe = await vi.hoisted(async () => {
  const { makeStripeMock } = await import("./helpers/stripe-mock.js");
  return makeStripeMock();
});
vi.mock("../src/stripe/client.js", () => ({
  stripeClient: () => stripe.asStripe(),
  _clearStripeClientCache: () => {},
}));

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

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
  DEEPSEEK_API_KEY: "test",
  LLM_BUDGET_USD_TO_CAD_RATE: 1.4,
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  STRIPE_PRICE_MAX_MONTHLY: "price_max_test",
};

describe("POST /billing/checkout", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    stripe.fns.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripe.fns.sessionsCreate.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.com/cs_test",
    });
  });
  afterAll(async () => {
    await disconnect();
  });

  it("creates Customer then Checkout Session for first-time user", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck1@example.com", name: "CK One" });
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: null } });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "max" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://checkout.stripe.com/cs_test" });
    expect(stripe.fns.customersCreate).toHaveBeenCalledOnce();
    expect(stripe.fns.customersCreate.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: `customer-create-${user.userId}`,
    });
    expect(stripe.fns.sessionsCreate).toHaveBeenCalledOnce();
    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.customer).toBe("cus_new");
    expect(sessionCall.customer_email).toBeUndefined();
    expect(sessionCall.client_reference_id).toBe(user.userId);
    expect(sessionCall.line_items[0].price).toBe(env.STRIPE_PRICE_MAX_MONTHLY);
    expect(sessionCall.success_url).toContain("{CHECKOUT_SESSION_ID}");
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_new");
  });

  it("reuses existing stripeCustomerId without recreating", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck2@example.com", name: "CK Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: null, stripeCustomerId: "cus_existing" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "pro" },
    });

    expect(res.statusCode).toBe(200);
    expect(stripe.fns.customersCreate).not.toHaveBeenCalled();
    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.customer).toBe("cus_existing");
    expect(sessionCall.line_items[0].price).toBe(env.STRIPE_PRICE_PRO_MONTHLY);
  });

  it("passes trial_end when trial >48h away", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck3@example.com", name: "CK Three" });
    const trialEnd = new Date(Date.now() + 10 * 86400_000);
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: trialEnd } });

    await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "max" },
    });

    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.subscription_data).toEqual({
      metadata: { app: "fina" },
      trial_end: Math.floor(trialEnd.getTime() / 1000),
    });
  });

  it("omits trial_end when trial <48h away (Stripe minimum)", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck4@example.com", name: "CK Four" });
    const soon = new Date(Date.now() + 24 * 3600_000);
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: soon } });

    await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "max" },
    });

    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    // subscription_data is still set (carries app metadata) but trial_end is omitted.
    expect(sessionCall.subscription_data).toEqual({ metadata: { app: "fina" } });
    expect(sessionCall.subscription_data.trial_end).toBeUndefined();
  });

  it("returns 409 already_subscribed when user has active sub", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck5@example.com", name: "CK Five" });
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: null } });
    await prisma.subscription.create({
      data: {
        userId: user.userId,
        tier: "max",
        source: "stripe",
        sourceSubscriptionId: "sub_existing",
        status: "active" as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "pro" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_subscribed");
    expect(stripe.fns.sessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_body for bad tier", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck6@example.com", name: "CK Six" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "free" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { "content-type": "application/json" },
      payload: { tier: "max" },
    });
    expect(res.statusCode).toBe(401);
  });
});
