import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

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
