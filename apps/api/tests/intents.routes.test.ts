import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { createIntentService } from "../src/intents/service.js";

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

describe("POST /workspaces/:id/intents/:intentId/consume", () => {
  it("POST 200 happy path: owner creates and consumes a createCategory intent", async () => {
    const { cookie, wsId, userId } = await setupProUser(`int-200-${Date.now()}@t.co`);
    const { intent } = await createIntentService(
      { workspaceId: wsId, userId },
      { tool: "createCategory", args: { name: "NewCat" } },
    );

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/${intent.id}/consume`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result.category.name).toBe("NewCat");
  });

  it("POST 404 intent_not_found for unknown intentId", async () => {
    const { cookie, wsId } = await setupProUser(`int-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/nonexistent-intent-id/consume`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("intent_not_found");
  });

  it("POST 403 intent_owner_mismatch when intent belongs to different workspace", async () => {
    const owner = await setupProUser(`int-mismatch-a-${Date.now()}@t.co`);
    const other = await setupProUser(`int-mismatch-b-${Date.now()}@t.co`);

    // Create intent in other's workspace
    const { intent } = await createIntentService(
      { workspaceId: other.wsId, userId: other.userId },
      { tool: "createCategory", args: { name: "OtherCat" } },
    );

    // Owner tries to consume with their own workspace — intent is in other workspace
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.wsId}/intents/${intent.id}/consume`,
      headers: { cookie: owner.cookie, "x-workspace-id": owner.wsId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("intent_owner_mismatch");
  });

  it("POST 410 intent_gone after first consume", async () => {
    const { cookie, wsId, userId } = await setupProUser(`int-410-${Date.now()}@t.co`);
    const { intent } = await createIntentService(
      { workspaceId: wsId, userId },
      { tool: "createCategory", args: { name: "GoneCat" } },
    );

    // First consume — should succeed
    const first = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/${intent.id}/consume`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(first.statusCode).toBe(200);

    // Second consume — should be gone
    const second = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/${intent.id}/consume`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(second.statusCode).toBe(410);
    expect(second.json().error).toBe("intent_gone");
  });

  it("POST 402 upgrade_required on Free tier (expired trial)", async () => {
    const { cookie, wsId, userId } = await setupProUser(`int-402-${Date.now()}@t.co`);
    const { intent } = await createIntentService(
      { workspaceId: wsId, userId },
      { tool: "createCategory", args: { name: "FreeCat" } },
    );

    // Expire trial → free tier
    await prisma.user.update({
      where: { id: userId },
      data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/${intent.id}/consume`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
  });

  it("POST 400 workspace_mismatch when path :id differs from X-Workspace-Id header", async () => {
    const a = await setupProUser(`int-wsmismatch-a-${Date.now()}@t.co`);
    const b = await setupProUser(`int-wsmismatch-b-${Date.now()}@t.co`);
    const { intent } = await createIntentService(
      { workspaceId: b.wsId, userId: b.userId },
      { tool: "createCategory", args: { name: "MismatchCat" } },
    );

    // X-Workspace-Id is b.wsId (so auth passes) but URL path uses a.wsId
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.wsId}/intents/${intent.id}/consume`,
      headers: { cookie: b.cookie, "x-workspace-id": b.wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("POST 403 insufficient_role: editor-only user cannot run createCategory", async () => {
    const u = await signUpAndGetCookie(app, { email: `int-role-${Date.now()}@t.co` });
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    // Demote user to editor
    await prisma.membership.update({
      where: { userId_workspaceId: { userId: u.userId, workspaceId: wsId } },
      data: { role: "editor" },
    });

    // Create intent as this (now-editor) user
    const { intent } = await createIntentService(
      { workspaceId: wsId, userId: u.userId },
      { tool: "createCategory", args: { name: "EditorCat" } },
    );

    // Consume as editor — consumeIntentService dispatches createCategory.run which checks role === "owner"
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/intents/${intent.id}/consume`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});
