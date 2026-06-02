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
vi.mock("../src/plaid/reconcile.js", () => ({
  reconcilePlaidItemsForUser: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  reconcileOrphanPlaidItems: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  retryPendingPlaidBillingCleanups: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  refreshBillingStateForUser: vi.fn().mockResolvedValue(undefined),
}));

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import Stripe from "stripe";
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

// Real Stripe webhook signing — we use the actual SDK helper so our
// signature verification path is exercised end-to-end.
function signedEvent(payload: Record<string, unknown>): { rawBody: string; signature: string } {
  const raw = JSON.stringify(payload);
  const sig = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  return { rawBody: raw, signature: sig };
}

describe("POST /webhooks/stripe — signature + idempotency", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("400 webhook_invalid_signature when signature header missing or bad", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_x", type: "ping" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("webhook_invalid_signature");
  });

  it("200 OK for unknown event type (no-op)", async () => {
    const app = await buildApp(env);
    const { rawBody, signature } = signedEvent({
      id: "evt_unknown",
      type: "ping",
      data: { object: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const stored = await prisma.webhookEvent.count();
    expect(stored).toBe(1);
  });

  it("same event id delivered twice is no-op (idempotent)", async () => {
    const app = await buildApp(env);
    const { rawBody, signature } = signedEvent({
      id: "evt_dup",
      type: "ping",
      data: { object: {} },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(second.statusCode).toBe(200);
    const stored = await prisma.webhookEvent.count({ where: { id: "evt_dup" } });
    expect(stored).toBe(1);
  });
});

import { signUpAndGetCookie } from "./helpers/auth.js";

function fakeStripeSub(opts: {
  id?: string; customer?: string; priceId?: string; status?: string; cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id ?? "sub_w",
    customer: opts.customer ?? "cus_w",
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
    items: { data: [{ price: { id: opts.priceId ?? env.STRIPE_PRICE_PRO_MONTHLY } }] },
  } as any;
}

describe("POST /webhooks/stripe — event dispatch", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it("checkout.session.completed → sub upserted, customerId set", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w1@example.com", name: "W One" });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_w1", customer: "cus_w1" }));

    const { rawBody, signature } = signedEvent({
      id: "evt_w1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_w1",
          customer: "cus_w1",
          subscription: "sub_w1",
          client_reference_id: user.userId,
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_w1");
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w1" } },
    });
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.userId);
  });

  it("subscription.updated before any .created still creates the row", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w2@example.com", name: "W Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_w2" },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_w2", customer: "cus_w2" }));

    const { rawBody, signature } = signedEvent({
      id: "evt_w2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_w2", customer: "cus_w2" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUnique({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w2" } },
    });
    expect(sub).not.toBeNull();
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.userId);
  });

  it("stale subscription.created retry after newer .updated keeps latest state", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w3@example.com", name: "W Three" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_w3" },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w3", customer: "cus_w3", cancelAtPeriodEnd: true }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w3_stale",
      type: "customer.subscription.created",
      data: { object: { id: "sub_w3", customer: "cus_w3" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w3" } },
    });
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("subscription.deleted → row status=canceled", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w4@example.com", name: "W Four" });
    await prisma.user.update({ where: { id: user.userId }, data: { stripeCustomerId: "cus_w4" } });
    await prisma.subscription.create({
      data: {
        userId: user.userId, tier: "pro", source: "stripe",
        sourceSubscriptionId: "sub_w4", status: "active" as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w4", customer: "cus_w4", status: "canceled" }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w4",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_w4", customer: "cus_w4" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w4" } },
    });
    expect(sub.status).toBe("canceled");
    expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.userId);
  });

  it("unknown price ID → 200, no row created, error logged", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w5@example.com", name: "W Five" });
    await prisma.user.update({ where: { id: user.userId }, data: { stripeCustomerId: "cus_w5" } });
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w5", customer: "cus_w5", priceId: "price_unknown" }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w5",
      type: "customer.subscription.created",
      data: { object: { id: "sub_w5", customer: "cus_w5" } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    const stored = await prisma.subscription.count();
    expect(stored).toBe(0);
    expect(reconcilePlaidItemsForUser).not.toHaveBeenCalled();
  });

  it("reconciliation cleanup failure returns 500 and does not record webhook event", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w6@example.com", name: "W Six" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_w6" },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_w6", customer: "cus_w6" }));
    vi.mocked(reconcilePlaidItemsForUser).mockResolvedValueOnce({
      kept: [],
      disconnected: [],
      failed: [{ id: "plaid-failed", error: new Error("cleanup failed") }],
    });

    const { rawBody, signature } = signedEvent({
      id: "evt_w6",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_w6", customer: "cus_w6" } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(500);
    await expect(prisma.webhookEvent.count({ where: { id: "evt_w6" } })).resolves.toBe(0);
  });
});
