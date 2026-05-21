import { describe, it, expect, beforeEach, afterAll } from "vitest";
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

describe("Better Auth integration", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("sign-up creates user + workspace + owner membership + trial via post-create hook", async () => {
    const app = await buildApp(env);
    const { userId, email } = await signUpAndGetCookie(app, {
      email: "hook@example.com",
      name: "Hook",
    });

    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.email).toBe(email);
    expect(u.trialStartedAt).not.toBeNull();
    expect(u.trialEndsAt).not.toBeNull();

    const memberships = await prisma.membership.findMany({ where: { userId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    await app.close();
  });

  it("session cookie authenticates subsequent requests", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ses@example.com", name: "Ses" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user?.id).toBe(user.userId);
    await app.close();
  });

  it("rejects /me without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
