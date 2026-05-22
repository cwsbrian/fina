import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv({ RATE_LIMIT_TEST: "1" });

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

  it("authStrict bucket — 5/min per IP on /api/auth/sign-in/*", async () => {
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
    expect(last?.json().error).toBe("rate_limit_exceeded");
    await app.close();
  });

  it("authStrict bucket — 5/min per IP on /api/auth/sign-up/*", async () => {
    const app = await buildApp(env);
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: `n${i}@t.co`, password: "validpw1234", name: `n${i}` }),
      });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });

  it("auth (lenient) bucket — 30/min per IP on /api/auth/get-session", async () => {
    const app = await buildApp(env);
    let last;
    for (let i = 0; i < 31; i++) {
      last = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });

  it("sign-in failures do NOT consume the auth/get-session bucket", async () => {
    const app = await buildApp(env);
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ email: `s${i}@t.co`, password: "wrong" }),
      });
    }
    const sessionRes = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(sessionRes.statusCode).not.toBe(429);
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
    expect(create.statusCode).toBe(201);
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
