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
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

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

  it("returns 401 without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
