import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { resetGeminiMock } from "./helpers/gemini-mock.js";

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
  resetGeminiMock();
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

describe("POST /workspaces/:wsId/chat/threads", () => {
  it("creates an empty thread for a Pro editor", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "First chat" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.thread.title).toBe("First chat");
    expect(body.thread.archivedAt).toBeNull();
    expect(body.thread.lastMessageAt).toBeNull();
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: body.thread.id } });
    expect(row.workspaceId).toBe(wsId);
  });

  it("title is optional", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.title).toBeNull();
  });

  it("rejects viewer-role members with 403", async () => {
    const { cookie, wsId, userId } = await setupProUser(`p-${Date.now()}@t.co`);
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });

  it("rejects free-tier with 402", async () => {
    const { cookie, wsId, userId } = await setupProUser(`p-${Date.now()}@t.co`);
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
  });

  it("rejects title longer than 200 chars with 400", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});
