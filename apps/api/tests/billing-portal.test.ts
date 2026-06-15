import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

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

describe("POST /billing/portal", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    stripe.fns.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/portal_session",
    });
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns 404 portal_failed when user has no stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "p1@example.com", name: "P One" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("portal_failed");
    expect(stripe.fns.portalCreate).not.toHaveBeenCalled();
  });

  it("returns portal url when user has stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "p2@example.com", name: "P Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_p2" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://billing.stripe.com/portal_session" });
    expect(stripe.fns.portalCreate).toHaveBeenCalledWith({
      customer: "cus_p2",
      return_url: `${env.WEB_APP_URL}/settings/plan`,
    });
  });

  it("returns 409 when an active native IAP subscription owns billing", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "p3@example.com", name: "P Three" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_stale" },
    });
    await prisma.subscription.create({
      data: {
        userId: user.userId,
        tier: "pro",
        source: "iap_apple",
        sourceSubscriptionId: "apple-original-tx-p3",
        status: "active" as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Sandbox",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { cookie: user.cookie },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("non_stripe_subscription");
    expect(stripe.fns.portalCreate).not.toHaveBeenCalled();
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "POST", url: "/billing/portal" });
    expect(res.statusCode).toBe(401);
  });
});
