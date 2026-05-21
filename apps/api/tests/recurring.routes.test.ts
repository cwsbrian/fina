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

beforeEach(async () => {
  await truncateAll();
});

async function makePro(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), trialConsumed: false },
  });
}

async function setupProUser(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  await makePro(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function getFirstCategoryId(wsId: string): Promise<string> {
  const cat = await prisma.category.findFirstOrThrow({
    where: { workspaceId: wsId, archivedAt: null },
    orderBy: { name: "asc" },
  });
  return cat.id;
}

describe("POST /workspaces/:id/recurring", () => {
  it("POST 201 with valid body", async () => {
    const { cookie, wsId } = await setupProUser(`r-post-201-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/recurring`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {
        name: "Netflix",
        amount: 15.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
        categoryId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.recurring.name).toBe("Netflix");
  });

  it("POST 400 invalid_amount on amount=0", async () => {
    const { cookie, wsId } = await setupProUser(`r-post-zero-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/recurring`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {
        name: "Netflix",
        amount: 0,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });

  it("POST 404 category_not_found on missing/cross-workspace category", async () => {
    const { cookie, wsId } = await setupProUser(`r-post-nocat-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/recurring`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {
        name: "Netflix",
        amount: 15.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
        categoryId: "non-existent-category-id",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("POST 402 upgrade_required when trial expired (Free tier)", async () => {
    const { cookie, wsId, userId } = await setupProUser(`r-post-free-${Date.now()}@t.co`);
    // Expire trial and mark consumed → free tier
    await prisma.user.update({
      where: { id: userId },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/recurring`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {
        name: "Netflix",
        amount: 15.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
      },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
  });

  it("POST 400 workspace_mismatch when path :id differs from X-Workspace-Id header", async () => {
    const a = await setupProUser(`r-post-mismatch-a-${Date.now()}@t.co`);
    const b = await setupProUser(`r-post-mismatch-b-${Date.now()}@t.co`);
    // Sign in as user A (x-workspace-id = a.wsId), but POST to workspace B's path
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${b.wsId}/recurring`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId, "content-type": "application/json" },
      payload: {
        name: "Netflix",
        amount: 15.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });
});

describe("GET /workspaces/:id/recurring", () => {
  it("GET 200 viewer can read recurring", async () => {
    const owner = await setupProUser(`r-get-owner-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(owner.wsId);

    // Create a recurring as owner
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.wsId}/recurring`,
      headers: { cookie: owner.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: {
        name: "Spotify",
        amount: 9.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
        categoryId,
      },
    });

    // Sign up a second user and add as viewer
    const viewer = await signUpAndGetCookie(app, { email: `r-get-viewer-${Date.now()}@t.co` });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: owner.wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.wsId}/recurring`,
      headers: { cookie: viewer.cookie, "x-workspace-id": owner.wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recurring).toHaveLength(1);
    expect(body.recurring[0].name).toBe("Spotify");
  });
});

describe("DELETE /workspaces/:id/recurring/:recurringId", () => {
  it("DELETE 204 happy path + DELETE 404 recurring_not_found on bogus id", async () => {
    const { cookie, wsId } = await setupProUser(`r-del-ok-${Date.now()}@t.co`);

    const postRes = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/recurring`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {
        name: "Adobe CC",
        amount: 54.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
      },
    });
    expect(postRes.statusCode).toBe(201);
    const recurringId = postRes.json().recurring.id;

    // Happy path DELETE
    const delRes = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/recurring/${recurringId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(delRes.statusCode).toBe(204);

    // 404 on bogus id
    const del404Res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/recurring/non-existent-id`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(del404Res.statusCode).toBe(404);
    expect(del404Res.json().error).toBe("recurring_not_found");
  });
});
