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
import { resetGeminiMock, chatGeminiMock } from "./helpers/gemini-mock.js";

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

describe("GET /workspaces/:wsId/chat/threads", () => {
  it("returns non-archived threads sorted by lastMessageAt desc, with messageCount and firstMessagePreview", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    const t1 = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "older" } });
    const t2 = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "newer" } });
    await prisma.chatThread.update({ where: { id: t1.id }, data: { lastMessageAt: new Date("2026-05-10T00:00:00Z") } });
    await prisma.chatThread.update({ where: { id: t2.id }, data: { lastMessageAt: new Date("2026-05-15T00:00:00Z") } });
    await prisma.chatMessage.create({ data: { threadId: t1.id, role: "user", blocks: [{ type: "text", markdown: "Hello world" }] } });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual([t2.id, t1.id]);
    const older = body.threads.find((t: { id: string }) => t.id === t1.id);
    expect(older.title).toBe("older");
    expect(older.messageCount).toBe(1);
    expect(older.firstMessagePreview).toBe("Hello world");
  });

  it("excludes archived threads by default; include_archived=true returns them", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    const archived = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "old", archivedAt: new Date() } });
    const active = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "live" } });

    const def = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads`, headers: { cookie, "x-workspace-id": wsId } });
    expect(def.json().threads.map((t: { id: string }) => t.id)).toEqual([active.id]);

    const full = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?include_archived=true`, headers: { cookie, "x-workspace-id": wsId } });
    expect(full.json().threads.map((t: { id: string }) => t.id).sort()).toEqual([active.id, archived.id].sort());
  });

  it("respects limit (default 50, max 100)", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    for (let i = 0; i < 3; i++) await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?limit=2`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.json().threads).toHaveLength(2);

    const over = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?limit=101`, headers: { cookie, "x-workspace-id": wsId } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("invalid_query");
  });

  it("succeeds for viewer + free-tier (GET is not tier-gated)", async () => {
    const { cookie, wsId, userId } = await setupProUser(`l-${Date.now()}@t.co`);
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
  });

  it("isolates by workspace", async () => {
    const a = await setupProUser(`l-${Date.now()}-a@t.co`);
    const b = await setupProUser(`l-${Date.now()}-b@t.co`);
    await prisma.chatThread.create({ data: { workspaceId: b.wsId, title: "B's thread" } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${a.wsId}/chat/threads`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.json().threads).toHaveLength(0);
  });
});

describe("GET /workspaces/:wsId/chat/threads/:tid", () => {
  it("returns the thread and messages (chronological)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "Detail" } });
    await prisma.chatMessage.create({ data: { threadId: t.id, role: "user", blocks: [{ type: "text", markdown: "first" }], createdAt: new Date("2026-05-15T10:00:00Z") } });
    await prisma.chatMessage.create({ data: { threadId: t.id, role: "assistant", blocks: [{ type: "text", markdown: "second" }], createdAt: new Date("2026-05-15T10:01:00Z") } });

    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thread.title).toBe("Detail");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
  });

  it("returns 404 for unknown thread id", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/does-not-exist`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`d-${Date.now()}-a@t.co`);
    const b = await setupProUser(`d-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns the most recent 100 messages (newest 100, chronologically ordered)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    // Seed 105 messages spread across distinct timestamps.
    for (let i = 0; i < 105; i++) {
      await prisma.chatMessage.create({
        data: {
          threadId: t.id,
          role: "user",
          blocks: [{ type: "text", markdown: `m-${i}` }],
          createdAt: new Date(2026_000_000_000 + i * 1000),
        },
      });
    }
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(100);
    // newest 100 → m-5 through m-104, in chronological order
    expect((body.messages[0].blocks as Array<{ markdown: string }>)[0].markdown).toBe("m-5");
    expect((body.messages[99].blocks as Array<{ markdown: string }>)[0].markdown).toBe("m-104");
  });

  it("returns 200 for archived threads (read access preserved)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.archivedAt).not.toBeNull();
  });

  it("succeeds for viewer + free-tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
  });
});

describe("PATCH /workspaces/:wsId/chat/threads/:tid", () => {
  it("renames the thread", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "before" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "after" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBe("after");
  });

  it("title: null clears the title", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "some" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBeNull();
  });

  it("renames archived threads (read+tidy access preserved)", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "old", archivedAt: new Date() } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "renamed-archive" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBe("renamed-archive");
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`r-${Date.now()}-a@t.co`);
    const b = await setupProUser(`r-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects title longer than 200 chars", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /workspaces/:wsId/chat/threads/:tid", () => {
  it("archives the thread (sets archivedAt) and returns 204", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(204);
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.archivedAt).not.toBeNull();
  });

  it("is idempotent: second DELETE on an archived thread also returns 204", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for unknown thread", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/does-not-exist`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`del-${Date.now()}-a@t.co`);
    const b = await setupProUser(`del-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(403);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(402);
  });
});

describe("POST /workspaces/:wsId/chat/threads/:tid/messages", () => {
  it("posts a user message, runs a turn, returns assistant message + tool calls", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    chatGeminiMock.responses.push({ text: "Hi back" });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "Hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.threadId).toBe(t.id);
    expect(body.userMessage.role).toBe("user");
    expect(body.assistantMessage.role).toBe("assistant");
    expect(body.toolCalls).toEqual([]);

    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.lastMessageAt).not.toBeNull();
  });

  it("returns 404 for archived thread", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns 404 for cross-workspace thread", async () => {
    const a = await setupProUser(`m-${Date.now()}-a@t.co`);
    const b = await setupProUser(`m-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}/messages`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(402);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects empty text and text longer than 4000 chars with 400", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const empty = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "" },
    });
    expect(empty.statusCode).toBe(400);
    const huge = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "x".repeat(4001) },
    });
    expect(huge.statusCode).toBe(400);
  });

  it("on Gemini failure returns 500 chat_provider_error and does NOT persist the assistant message", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    chatGeminiMock.responses.push(new Error("network down"));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "Hello" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("chat_provider_error");
    const msgs = await prisma.chatMessage.findMany({ where: { threadId: t.id } });
    // Existing behavior: the user message persists before the turn runs.
    // The assistant message is not created, and lastMessageAt should reflect the user message only.
    expect(msgs.every((m) => m.role !== "assistant")).toBe(true);
  });
});
