import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ cookie: string; wsId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { cookie: u.cookie, wsId, categoryId: cat.id };
}

describe("POST /workspaces/:id/schedules", () => {
  it("201 happy", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-add@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 100, scheduledDate: "2026-05-25", note: "x" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.schedule.id).toBeTruthy();
    expect(body.schedule.amount).toBe("100");
  });

  it("400 invalid_body bad JSON", async () => {
    const { cookie, wsId } = await setup("sr-badbody@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: "not-a-number" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_amount", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-amt@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 0, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });

  it("404 category_not_found (archived)", async () => {
    const { cookie, wsId } = await setup("sr-arch@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch", archivedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-wmm@t.co");
    const other = await prisma.workspace.create({ data: { name: "other-wmm" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${other.id}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("401 no session", async () => {
    const { wsId, categoryId } = await setup("sr-401@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 viewer", async () => {
    const owner = await signUpAndGetCookie(app, { email: "sr-403-owner@t.co" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C403" } });
    const viewer = await signUpAndGetCookie(app, { email: "sr-403-viewer@t.co" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});

describe("GET /workspaces/:id/schedules", () => {
  it("happy returns array with derived status", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-list@t.co");
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2099-05-25" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].status).toBe("upcoming");
  });

  it("filter status=upcoming", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-stfilt@t.co");
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2099-05-25" }),
    });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 30, scheduledDate: "2020-01-01" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/schedules?status=upcoming`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].status).toBe("upcoming");
  });
});

describe("POST /workspaces/:id/schedules/:scheduleId/dismiss", () => {
  it("happy 200", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-dis@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.id).toBe(id);
  });

  it("idempotent already dismissed", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-disid@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissed: false, alreadyDismissed: true });
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setup("sr-dis404@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/no-such/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

describe("DELETE /workspaces/:id/schedules/:scheduleId", () => {
  it("happy 200 removed=true", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-rm@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/schedules/${id}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("idempotent missing returns alreadyRemoved=true (no 404)", async () => {
    const { cookie, wsId } = await setup("sr-rmid@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/schedules/no-such-id`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false, alreadyRemoved: true });
  });
});
