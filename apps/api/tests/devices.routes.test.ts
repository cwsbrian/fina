import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });

beforeEach(async () => { await truncateAll(); });

describe("POST /devices", () => {
  it("requires session (401 when no cookie)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]", platform: "ios" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("upserts a UserDevice row (create on first call)", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "dev1@t.co" });
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]", platform: "ios" }),
    });
    expect(res.statusCode).toBe(204);
    const devices = await prisma.userDevice.findMany({ where: { userId } });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.expoPushToken).toBe("ExponentPushToken[abc]");
    expect(devices[0]!.platform).toBe("ios");
  });

  it("upserts a UserDevice row (update lastSeenAt on repeat call)", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "dev2@t.co" });

    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[xyz]", platform: "android" }),
    });
    const first = await prisma.userDevice.findFirstOrThrow({ where: { userId } });

    await new Promise(r => setTimeout(r, 50));

    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[xyz]", platform: "android" }),
    });
    const second = await prisma.userDevice.findFirstOrThrow({ where: { userId } });

    expect(second.id).toBe(first.id);  // same row — proves no duplicate
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
  });

  it("rejects invalid platform (400 invalid_body)", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "dev3@t.co" });
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]", platform: "windows" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects empty expoPushToken (400 invalid_body)", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "dev4@t.co" });
    const res = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "", platform: "ios" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("multi-account device — UserA's row remains when UserB registers same token", async () => {
    const userA = await signUpAndGetCookie(app, { email: "multi-a@t.co" });
    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie: userA.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[shared]", platform: "ios" }),
    });

    const userB = await signUpAndGetCookie(app, { email: "multi-b@t.co" });
    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie: userB.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[shared]", platform: "ios" }),
    });

    // Both users have a row with the same token. UNIQUE is (userId, token),
    // not just token. UserA's row is "stale" but undetectable here — it
    // will get cleaned via DeviceNotRegistered on next push attempt.
    const devicesA = await prisma.userDevice.findMany({ where: { userId: userA.userId } });
    const devicesB = await prisma.userDevice.findMany({ where: { userId: userB.userId } });
    expect(devicesA).toHaveLength(1);
    expect(devicesB).toHaveLength(1);
  });
});
