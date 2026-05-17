import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";

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
  GEMINI_API_KEY: "test_gemini_key",
};

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

describe("POST /workspaces/:id/budgets", () => {
  it("POST 201 with valid body", async () => {
    const { cookie, wsId } = await setupProUser(`b-post-201-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { categoryId, amount: 500, period: "this_month" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.budget.categoryId).toBe(categoryId);
    expect(body.budget.amount).toBe("500.00");
    expect(body.budget.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it("POST 400 invalid_amount on amount=0", async () => {
    const { cookie, wsId } = await setupProUser(`b-post-zero-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { categoryId, amount: 0, period: "this_month" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });

  it("POST 404 category_not_found on missing category", async () => {
    const { cookie, wsId } = await setupProUser(`b-post-nocat-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { categoryId: "non-existent-category-id", amount: 100, period: "this_month" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("POST 402 upgrade_required when user is Free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`b-post-free-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(wsId);
    // Expire trial and mark consumed → free tier
    await prisma.user.update({
      where: { id: userId },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { categoryId, amount: 100, period: "this_month" },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
  });

  it("POST 400 invalid_body on missing required field", async () => {
    const { cookie, wsId } = await setupProUser(`b-post-bad-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { amount: 100, period: "this_month" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});

describe("GET /workspaces/:id/budgets", () => {
  it("GET 200 viewer can read budgets", async () => {
    const owner = await setupProUser(`b-get-owner-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(owner.wsId);

    // Create a budget as owner
    await app.inject({
      method: "POST",
      url: `/workspaces/${owner.wsId}/budgets`,
      headers: { cookie: owner.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: { categoryId, amount: 300, period: "this_month" },
    });

    // Sign up a second user and add as viewer
    const viewer = await signUpAndGetCookie(app, { email: `b-get-viewer-${Date.now()}@t.co` });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: owner.wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${owner.wsId}/budgets`,
      headers: { cookie: viewer.cookie, "x-workspace-id": owner.wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.budgets).toHaveLength(1);
    expect(body.budgets[0].amount).toBe("300.00");
  });

  it("GET 400 invalid_period_start for bad date", async () => {
    const { cookie, wsId } = await setupProUser(`b-get-baddate-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/budgets?period_start=2026-13-01`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_period_start");
  });
});

describe("DELETE /workspaces/:id/budgets/:budgetId", () => {
  it("DELETE 204 happy path", async () => {
    const { cookie, wsId } = await setupProUser(`b-del-ok-${Date.now()}@t.co`);
    const categoryId = await getFirstCategoryId(wsId);

    const postRes = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budgets`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { categoryId, amount: 200, period: "this_month" },
    });
    expect(postRes.statusCode).toBe(201);
    const budgetId = postRes.json().budget.id;

    const delRes = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/budgets/${budgetId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(delRes.statusCode).toBe(204);

    // Verify deleted
    const row = await prisma.budget.findUnique({ where: { id: budgetId } });
    expect(row).toBeNull();
  });

  it("DELETE 404 on cross-workspace budget id", async () => {
    const a = await setupProUser(`b-del-xws-a-${Date.now()}@t.co`);
    const b = await setupProUser(`b-del-xws-b-${Date.now()}@t.co`);

    const catB = await getFirstCategoryId(b.wsId);
    const postRes = await app.inject({
      method: "POST",
      url: `/workspaces/${b.wsId}/budgets`,
      headers: { cookie: b.cookie, "x-workspace-id": b.wsId, "content-type": "application/json" },
      payload: { categoryId: catB, amount: 100, period: "this_month" },
    });
    expect(postRes.statusCode).toBe(201);
    const bBudgetId = postRes.json().budget.id;

    // User A tries to delete B's budget using A's workspace in the URL
    const delRes = await app.inject({
      method: "DELETE",
      url: `/workspaces/${a.wsId}/budgets/${bBudgetId}`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId },
    });
    expect(delRes.statusCode).toBe(404);
    expect(delRes.json().error).toBe("budget_not_found");
  });
});
