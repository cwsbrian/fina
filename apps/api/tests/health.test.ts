import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { disconnect } from "./helpers/db.js";

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
};

afterAll(async () => { await disconnect(); });

describe("health endpoints", () => {
  it("GET /live always 200 with { status: 'ok' }", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /ready 200 with HealthDTO when DB is up", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ db: "ok" });
    await app.close();
  });

  it("GET /ready 503 with degraded payload when DB throws", async () => {
    const app = await buildApp(env);
    // Manual save/restore — vi.spyOn on Prisma delegate properties is
    // forbidden (commit 3ecc538). Prisma's runtime proxies them in a way
    // that breaks spy restore under singleFork, leaving the next test
    // with a stubbed $queryRaw. Replace + finally-restore is the rule.
    const original = prisma.$queryRaw;
    // Return a rejected Promise (not a sync throw) so the race in
    // readyPayload actually runs against the rejecting branch instead
    // of throwing before Promise.race constructs.
    (prisma as unknown as { $queryRaw: unknown }).$queryRaw = () =>
      Promise.reject(new Error("simulated db down"));
    try {
      const res = await app.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe("degraded");
      expect(body.checks).toEqual({ db: "down" });
    } finally {
      (prisma as unknown as { $queryRaw: typeof original }).$queryRaw = original;
      await app.close();
    }
  });

  it("GET /health aliases /ready and includes status:ok on success", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
    await app.close();
  });
});
