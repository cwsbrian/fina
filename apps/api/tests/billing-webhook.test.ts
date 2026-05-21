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
import Stripe from "stripe";

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
