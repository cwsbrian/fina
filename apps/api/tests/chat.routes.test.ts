import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

// `processChatTurn` and `callTitleLLM` are mocked — message-route tests
// don't need a real LLM. The auto-title mock is critical: without it,
// the fire-and-forget `void generateAndPersistThreadTitle(...)` in the
// message route would issue a real Gemini HTTP call in test, which
// (a) hangs in CI without GEMINI_API_KEY, and (b) under vitest
// singleFork can bleed into subsequent tests in the same file.
vi.mock("../src/chat/turn.js", () => ({
  processChatTurn: vi.fn().mockResolvedValue({
    assistantText: "ok",
    presentationBlocks: [],
    toolCalls: [],
  }),
}));
vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn().mockResolvedValue("Auto Title"),
}));

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

async function setup(email: string): Promise<{ userId: string; cookie: string; wsId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { userId: u.userId, cookie: u.cookie, wsId };
}

// Tier upgrade: fresh signup is auto-trial (Pro). For non-Pro tests,
// set User.trialEndsAt to the past so `effectiveTier` returns "free".
async function downgradeToFree(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date("2020-01-01T00:00:00Z"), trialConsumed: true },
  });
}

describe("POST /chat/threads", () => {
  it("201 — creates an unbound thread, returns DTO with workspaceId: null", async () => {
    const { cookie } = await setup("ct1@t.co");
    const res = await app.inject({
      method: "POST",
      url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "hello" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.thread.workspaceId).toBeNull();
    expect(body.thread.title).toBe("hello");
    expect(body.thread.userId).toBeTruthy();
  });

  it("201 — without title", async () => {
    const { cookie } = await setup("ct2@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.title).toBeNull();
  });

  it("401 — no session", async () => {
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
  });

  it("402 — non-Pro user", async () => {
    const { userId, cookie } = await setup("ct3@t.co");
    await downgradeToFree(userId);
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(402);
  });

  it("400 — invalid_body when title is too long", async () => {
    const { cookie } = await setup("ct4@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(201) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("ignores X-Workspace-Id header (transport policy)", async () => {
    const { cookie } = await setup("ct5@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json", "x-workspace-id": "bogus-ws-id" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.workspaceId).toBeNull();
  });
});

describe("GET /chat/threads", () => {
  it("200 — returns the user's threads (bound + unbound)", async () => {
    const { userId, cookie, wsId } = await setup("gt1@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null, title: "unbound" } });
    await prisma.chatThread.create({ data: { userId, workspaceId: wsId, title: "bound" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = res.json().threads.map((t: { title: string | null }) => t.title);
    expect(titles).toContain("bound");
    expect(titles).toContain("unbound");
  });

  it("200 — does not return other users' threads", async () => {
    const { cookie: cookieA } = await setup("gt2a@t.co");
    const { userId: userB } = await setup("gt2b@t.co");
    await prisma.chatThread.create({ data: { userId: userB, workspaceId: null, title: "B-thread" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie: cookieA } });
    expect(res.json().threads).toEqual([]);
  });

  it("200 — open to non-Pro users (Lite needs to read brief threads)", async () => {
    const { userId, cookie } = await setup("gt3@t.co");
    await downgradeToFree(userId);
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("401 — no session", async () => {
    const res = await app.inject({ method: "GET", url: "/chat/threads" });
    expect(res.statusCode).toBe(401);
  });

  it("200 — returns user's threads even when user has zero workspace memberships", async () => {
    const { userId, cookie } = await setup("gt4@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await prisma.membership.deleteMany({ where: { userId } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().threads).toHaveLength(1);
  });

  it("200 — DTO includes workspaceId, userId, title, lastMessageAt, archivedAt", async () => {
    const { userId, cookie } = await setup("gt5@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null, title: "t" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const row = res.json().threads[0];
    expect(row).toMatchObject({
      userId, workspaceId: null, title: "t",
      lastMessageAt: null, archivedAt: null,
    });
    expect(typeof row.createdAt).toBe("string");
  });
});
