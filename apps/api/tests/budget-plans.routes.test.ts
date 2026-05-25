import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe("POST /workspaces/:id/budget-plans/suggest-split", () => {
  it("402 upgrade_required for Free tier (trial expired + consumed)", async () => {
    const u = await signUpAndGetCookie(app, { email: `bp-free-${Date.now()}@t.co` });
    const wsId = await getOwnerWorkspaceId(u.userId);
    // Expire trial → Free tier.
    await prisma.user.update({
      where: { id: u.userId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        trialConsumed: true,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budget-plans/suggest-split`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { totalAmount: 1000 },
    });
    expect(res.statusCode).toBe(402);
    // Strict body shape — no extra payload alongside the error code.
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });
});
