import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

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

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { userId: u.userId, cookie: u.cookie, wsId };
}

describe("lazy binding races", () => {
  it("two concurrent first-messages targeting DIFFERENT workspaces — exactly one binds, the other 400 workspace_mismatch", async () => {
    const { userId, cookie, wsId } = await setup("rb1@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.membership.create({ data: { userId, workspaceId: otherWs.id, role: "owner" } });
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = (ws: string) => app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: ws }),
    });

    const [a, b] = await Promise.all([post(wsId), post(otherWs.id)]);
    // Numeric sort with explicit comparator — JS default sort is
    // lexicographic, which coincidentally works for [200, 400] but
    // breaks if status codes ever differ in length (e.g., 200 vs 1000).
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 400]);
    const loser = a.statusCode === 400 ? a : b;
    expect(loser.json().error).toBe("workspace_mismatch");

    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect([wsId, otherWs.id]).toContain(reload.workspaceId);
  });

  it("two concurrent first-messages targeting the SAME workspace — both succeed; thread bound exactly once", async () => {
    const { userId, cookie, wsId } = await setup("rb2@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = () => app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });

    const [a, b] = await Promise.all([post(), post()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.workspaceId).toBe(wsId);
    const userMessages = await prisma.chatMessage.count({
      where: { threadId: t.id, role: "user" },
    });
    expect(userMessages).toBe(2);
  });

  it("archive-during-bind — DELETE racing with first-message: either archive wins (POST 404) or bind wins (DELETE archives bound thread); never archived-but-bound visible", async () => {
    const { userId, cookie, wsId } = await setup("rb3@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    const del = app.inject({
      method: "DELETE", url: `/chat/threads/${t.id}`,
      headers: { cookie },
    });

    const [p, d] = await Promise.all([post, del]);
    // Either outcome is acceptable; both must be terminal and consistent.
    // Validate consistency: if POST succeeded, the thread is now both
    // bound and archived (acceptable — DELETE landed after bind).
    // If POST 404'd, the thread is archived and unbound.
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    if (p.statusCode === 200) {
      expect(d.statusCode).toBe(204);
      expect(reload.workspaceId).toBe(wsId);
      expect(reload.archivedAt).toBeTruthy();
    } else {
      expect(p.statusCode).toBe(404);
      expect(reload.workspaceId).toBeNull();
      expect(reload.archivedAt).toBeTruthy();
    }
  });
});
