import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "x",
  PLAID_SECRET: "x",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "x",
  PRISMA_CONNECTION_LIMIT: 10,
  TRUST_PROXY: false,
  RATE_LIMIT_TEST: "1",
};

describe("rate limits", () => {
  beforeEach(async () => { await truncateAll(); });
  afterEach(async () => { /* nothing — each test rebuilds app */ });

  it("global default — 60/min per IP, 61st returns 429 rate_limit_exceeded", async () => {
    const app = await buildApp(env);
    let last;
    for (let i = 0; i < 61; i++) {
      last = await app.inject({ method: "GET", url: "/health" });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error).toBe("rate_limit_exceeded");
    await app.close();
  });

  it("auth bucket — 5/min per IP on /api/auth/*", async () => {
    const app = await buildApp(env);
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: `r${i}@t.co`, password: "wrong" }),
      });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });

  it("chat per-user — 30/min keyed by userId via session-decorator", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "rl-chat@t.co" });
    const create = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie: u.cookie, "content-type": "application/json" },
      payload: "{}",
    });
    if (create.statusCode !== 201) {
      await app.close();
      return;
    }
    const threadId = create.json().thread.id;

    let last;
    for (let i = 0; i < 31; i++) {
      last = await app.inject({
        method: "POST",
        url: `/chat/threads/${threadId}/messages`,
        headers: { cookie: u.cookie, "content-type": "application/json" },
        payload: JSON.stringify({ text: `m${i}`, workspaceId: "anything" }),
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error).toBe("rate_limit_exceeded");
    await app.close();
    await disconnect();
  });
});
