import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";
import * as strategyMod from "../src/goals/generate-strategy.js";
import { Prisma } from "@prisma/client";

const env = testEnv();

// Partial mock: replace generateAndStoreGoalStrategy with vi.fn(), keep
// other exports as-is. vi.clearAllMocks in afterEach clears call history
// but PRESERVES this mock implementation (restoreAllMocks would restore
// the real Gemini-calling impl and break subsequent tests).
vi.mock("../src/goals/generate-strategy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goals/generate-strategy.js")>();
  return {
    ...actual,
    generateAndStoreGoalStrategy: vi.fn().mockResolvedValue(undefined),
  };
});

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function setupProUser(email: string): Promise<{ userId: string; wsId: string; cookie: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  // Bootstrap auto-starts trial → user is Pro (trialEndsAt in future).
  return { userId: u.userId, wsId, cookie: u.cookie };
}

async function setupFreeUser(email: string): Promise<{ userId: string; wsId: string; cookie: string }> {
  const u = await setupProUser(email);
  await prisma.user.update({
    where: { id: u.userId },
    data: { trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
  });
  return u;
}

async function seedGoal(wsId: string, overrides?: Partial<{ dueDate: Date; title: string }>): Promise<string> {
  const row = await prisma.goal.create({
    data: {
      workspaceId: wsId,
      title: overrides?.title ?? "Test Goal",
      targetAmount: new Prisma.Decimal(1000),
      savedAmount: new Prisma.Decimal(0),
      dueDate: overrides?.dueDate ?? new Date(Date.now() + 60 * 86_400_000),
    },
  });
  return row.id;
}

describe("GET /workspaces/:id/goals", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces/anything/goals" });
    expect(res.statusCode).toBe(401);
  });

  it("200 empty list initially", async () => {
    const u = await setupProUser(`gl-empty-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goals).toEqual([]);
  });

  it("200 with seeded goal (direct DB insert, no Pro setup needed for GET)", async () => {
    const u = await setupProUser(`gl-seed-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    const goals = res.json().goals as Array<{ id: string }>;
    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(goalId);
  });
});

describe("GET /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces/ws/goals/g" });
    expect(res.statusCode).toBe(401);
  });

  it("200 happy path", async () => {
    const u = await setupProUser(`gd-ok-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId, { title: "Detail Goal" });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.title).toBe("Detail Goal");
  });

  it("404 not_found on bogus goalId", async () => {
    const u = await setupProUser(`gd-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});

describe("POST /workspaces/:id/goals", () => {
  it("401 no session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws/goals",
      payload: { title: "X", targetAmount: 100, dueDate: dateOnly(45) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 invalid_body missing required fields", async () => {
    const u = await setupProUser(`gc-missing-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X" }),  // missing targetAmount + dueDate
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 invalid_body when dueDate < 1 calendar month (today+15d)", async () => {
    const u = await setupProUser(`gc-short-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(15) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 workspace_mismatch when path :id differs from X-Workspace-Id", async () => {
    // Two real users + workspaces. UserA's cookie+header → A's workspace
    // (membership passes), URL path → B's workspace → ctx.membership.
    // workspaceId !== params.id → 400 workspace_mismatch.
    // (Using an arbitrary "different-ws-id" string would fail at
    // membership check first → 404 no_membership, not the path we want
    // to exercise here.)
    const userA = await setupProUser(`gc-wsmm-A-${Date.now()}@t.co`);
    const userB = await setupProUser(`gc-wsmm-B-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${userB.wsId}/goals`,
      headers: { cookie: userA.cookie, "x-workspace-id": userA.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(45) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "workspace_mismatch" });
  });

  it("402 upgrade_required for Free tier (trial expired + consumed)", async () => {
    const u = await setupFreeUser(`gc-free-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(45) }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("201 happy path (Pro): row persisted + generateAndStoreGoalStrategy fire-and-forget", async () => {
    const u = await setupProUser(`gc-ok-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        title: "Save for Tokyo",
        targetAmount: 5000,
        dueDate: dateOnly(45),
      }),
    });
    expect(res.statusCode).toBe(201);
    const goalId = res.json().goal.id as string;
    expect(typeof goalId).toBe("string");

    const stored = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(stored.title).toBe("Save for Tokyo");

    // Fire-and-forget call landed. The `void`-prefixed call inside the
    // handler invokes the mocked vi.fn() synchronously (only its .then() is
    // async), so .mock.calls is populated before the response returns.
    const calls = vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls;
    expect(calls.length).toBe(1);
    // Don't assert env object identity — buildApp may wrap/clone. Just
    // verify the goalId was passed as the second arg.
    expect(calls[0]?.[1]).toBe(goalId);
  });
});

describe("PATCH /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/workspaces/ws/goals/g",
      payload: { title: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found on bogus goalId (Pro user, real wsId)", async () => {
    const u = await setupProUser(`gp-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("400 invalid_body when dueDate < 1 calendar month", async () => {
    const u = await setupProUser(`gp-short-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ dueDate: dateOnly(15) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("402 upgrade_required for Free tier", async () => {
    // Pre-seed a goal AS PRO USER via direct DB insert (POST is Pro-gated).
    const u = await setupFreeUser(`gp-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "New Title" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("200 happy path (Pro): title-only patch", async () => {
    const u = await setupProUser(`gp-title-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId, { title: "Old" });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "New" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.title).toBe("New");
  });

  it("200 happy path (Pro): dueDate extension to today+45d", async () => {
    const u = await setupProUser(`gp-due-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const newDue = dateOnly(45);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ dueDate: newDue }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.dueDate).toBe(newDue);
  });

  it("200 happy path (Pro): archived=true toggle sets archivedAt", async () => {
    const u = await setupProUser(`gp-arch-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ archived: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.archivedAt).not.toBeNull();
  });
});

describe("POST /workspaces/:id/goals/:goalId/strategy", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "POST", url: "/workspaces/ws/goals/g/strategy" });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found", async () => {
    const u = await setupProUser(`gs-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/bogus-id/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("402 upgrade_required for Free tier", async () => {
    const u = await setupFreeUser(`gs-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/${goalId}/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("200 happy path (Pro): generateAndStoreGoalStrategy called synchronously", async () => {
    const u = await setupProUser(`gs-ok-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/${goalId}/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.id).toBe(goalId);

    const calls = vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls;
    expect(calls.length).toBe(1);
    // Don't assert env object identity — buildApp may wrap/clone.
    expect(calls[0]?.[1]).toBe(goalId);
  });
});

describe("DELETE /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "DELETE", url: "/workspaces/ws/goals/g" });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found on bogus goalId", async () => {
    const u = await setupProUser(`gd-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("204 Free tier user can DELETE existing goal (cleanup unaffected by Pro-gate)", async () => {
    // Setup as Pro → seed goal via direct DB → expire trial + consumed → DELETE.
    const u = await setupFreeUser(`gd-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(204);
    const after = await prisma.goal.findUnique({ where: { id: goalId } });
    expect(after).toBeNull();
  });
});

describe("cross-workspace isolation", () => {
  it("404 not_found when user B requests goal G1 from their own workspace W2", async () => {
    const userA = await setupProUser(`xw-A-${Date.now()}@t.co`);
    const userB = await setupProUser(`xw-B-${Date.now()}@t.co`);
    const goalG1 = await seedGoal(userA.wsId);
    // User B uses their OWN wsId W2 but passes foreign goalId G1.
    // Route's findFirst({ id: G1, workspaceId: W2 }) returns null → 404.
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${userB.wsId}/goals/${goalG1}`,
      headers: { cookie: userB.cookie, "x-workspace-id": userB.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
