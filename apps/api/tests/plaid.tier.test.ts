import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { effectiveTier, requireProTier, computeEffectiveTier } from "../src/auth/tier.js";
import { HttpError } from "../src/auth/context.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

// File-level lifecycle (Plan 2 convention).
beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("requireProTier / effectiveTier", () => {
  it("returns pro + trialActive=true on a fresh trial signup", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("pro");
    expect(t.trialActive).toBe(true);
    expect(t.source).toBe("trial");
    await app.close();
  });

  it("returns free after trial expires", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "exp@x.com", name: "Exp" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("free");
    expect(t.trialActive).toBe(false);
    expect(t.source).toBe("default");
    await app.close();
  });

  it("requireProTier passes for trial-active user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro2@x.com", name: "Pro2" });
    await expect(requireProTier(u.userId)).resolves.toBeUndefined();
    await app.close();
  });

  it("requireProTier throws 402 upgrade_required for free user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    await expect(requireProTier(u.userId)).rejects.toMatchObject({
      statusCode: 402,
      code: "upgrade_required",
    });
    expect((await requireProTier(u.userId).catch((e) => e)) as HttpError).toBeInstanceOf(HttpError);
    await app.close();
  });
});

describe("computeEffectiveTier — plaidItemLimit", () => {
  it("active trial → plaidItemLimit: 5", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() + 86_400_000) });
    expect(t.plaidItemLimit).toBe(5);
  });

  it("expired trial → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() - 1_000) });
    expect(t.plaidItemLimit).toBe(0);
  });

  it("no trial (null) → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: null });
    expect(t.plaidItemLimit).toBe(0);
  });
});
