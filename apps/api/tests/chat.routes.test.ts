import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

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
  resetGeminiMock();
});

async function makePro(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() + 7 * 86400_000), trialConsumed: false },
  });
}

async function makeExpiredTrial(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() - 86400_000), trialConsumed: true },
  });
}

describe("chat routes", () => {
  it("Free (expired trial) → POST /chat/message → 402 upgrade_required, no thread/messages created", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makeExpiredTrial(u.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hi" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    expect(await prisma.chatThread.count({ where: { workspaceId: wsId } })).toBe(0);
    expect(await prisma.chatMessage.count()).toBe(0);
  });

  it("Pro → POST /chat/message → 200, thread upserted, user+assistant messages saved", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    chatGeminiMock.responses.push({ text: "Hi there!" });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hello" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.userMessage.blocks[0].markdown).toBe("hello");
    expect(body.assistantMessage.blocks[0].markdown).toBe("Hi there!");
    expect(body.toolCalls).toEqual([]);

    const thread = await prisma.chatThread.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(thread.type).toBe("adhoc");
    const msgs = await prisma.chatMessage.findMany({ where: { threadId: thread.id } });
    expect(msgs).toHaveLength(2);
  });

  it("second POST reuses the same thread (composite unique on workspaceId+type)", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    chatGeminiMock.responses.push({ text: "a" });
    chatGeminiMock.responses.push({ text: "b" });

    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "first" }),
    });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "second" }),
    });

    expect(await prisma.chatThread.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it("GET /chat/thread → returns thread + messages oldest-first", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    chatGeminiMock.responses.push({ text: "reply!" });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "msg" }),
    });

    const res = await app.inject({
      method: "GET", url: `/workspaces/${wsId}/chat/thread`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
  });

  it("GET /chat/thread with no thread yet → upserts empty", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    const res = await app.inject({
      method: "GET", url: `/workspaces/${wsId}/chat/thread`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([]);
    expect(await prisma.chatThread.count({ where: { workspaceId: wsId } })).toBe(1);
  });

  it("POST without X-Workspace-Id header → 400 missing_workspace_header", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hi" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_workspace_header");
  });

  it("POST with workspace path mismatch → 400 workspace_mismatch", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    const other = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.membership.create({ data: { userId: u.userId, workspaceId: other.id, role: "editor" } });

    const res = await app.inject({
      method: "POST", url: `/workspaces/${other.id}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hi" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("POST as viewer-only member → 403 insufficient_role", async () => {
    const owner = await signUpAndGetCookie(app);
    const ownerWs = await getOwnerWorkspaceId(owner.userId);
    await makePro(owner.userId);

    const viewer = await signUpAndGetCookie(app);
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: ownerWs, role: "viewer" },
    });
    await makePro(viewer.userId);

    const res = await app.inject({
      method: "POST", url: `/workspaces/${ownerWs}/chat/message`,
      headers: { cookie: viewer.cookie, "x-workspace-id": ownerWs, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hi" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });

  it("Gemini throws → 500 chat_provider_error; user message IS persisted, no assistant", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    chatGeminiMock.responses.push(new Error("boom"));

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hi" }),
    });
    spy.mockRestore();

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("chat_provider_error");

    const userMsgs = await prisma.chatMessage.count({ where: { thread: { workspaceId: wsId }, role: "user" } });
    const asstMsgs = await prisma.chatMessage.count({ where: { thread: { workspaceId: wsId }, role: "assistant" } });
    expect(userMsgs).toBe(1);
    expect(asstMsgs).toBe(0);
  });

  it("invalid body (empty text) → 400 invalid_body", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("categorizeTransaction tool call → applies merchant_mapping + back-fills siblings", async () => {
    const u = await signUpAndGetCookie(app);
    const wsId = await getOwnerWorkspaceId(u.userId);
    await makePro(u.userId);

    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    const tx1 = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "t1", amount: "5", merchantRaw: "STARBUCKS", merchantNormalized: "starbucks", occurredAt: new Date(), rawData: {} },
    });
    const tx2 = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "t2", amount: "6", merchantRaw: "STARBUCKS #2", merchantNormalized: "starbucks", occurredAt: new Date(), rawData: {} },
    });

    chatGeminiMock.responses.push({ functionCalls: [{ name: "categorizeTransaction", args: { tx_id: tx1.id, category: "Coffee" } }] });
    chatGeminiMock.responses.push({ text: "Categorized." });

    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/chat/message`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ text: "categorize this" }),
    });
    expect(res.statusCode).toBe(200);

    const tx1Row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx1.id } });
    expect(tx1Row.categoryId).toBe(cat.id);
    expect(tx1Row.categorizationSource).toBe("manual");

    const tx2Row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx2.id } });
    expect(tx2Row.categoryId).toBe(cat.id);
    expect(tx2Row.categorizationSource).toBe("mapping");

    const mapping = await prisma.merchantMapping.findUniqueOrThrow({
      where: { workspaceId_merchantNormalized: { workspaceId: wsId, merchantNormalized: "starbucks" } },
    });
    expect(mapping.source).toBe("manual");
  });
});
