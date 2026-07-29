import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

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

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { userId: u.userId, cookie: u.cookie, wsId };
}

describe("canonical workspace thread races", () => {
  it("concurrent opens for different workspaces return one thread per workspace", async () => {
    const { userId, cookie, wsId } = await setup("rb1@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.membership.create({ data: { userId, workspaceId: otherWs.id, role: "owner" } });

    const open = (workspaceId: string) => app.inject({
      method: "POST", url: "/chat/threads",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-workspace-id": workspaceId,
      },
      payload: "{}",
    });

    const [a, b] = await Promise.all([open(wsId), open(otherWs.id)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().thread.workspaceId).toBe(wsId);
    expect(b.json().thread.workspaceId).toBe(otherWs.id);
    expect(a.json().thread.id).not.toBe(b.json().thread.id);
  });

  it("concurrent opens for the same workspace return the same thread", async () => {
    const { cookie, wsId } = await setup("rb2@t.co");
    const open = () => app.inject({
      method: "POST", url: "/chat/threads",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-workspace-id": wsId,
      },
      payload: "{}",
    });

    const [a, b] = await Promise.all([open(), open()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().thread.id).toBe(b.json().thread.id);
  });

  it("archive racing with a message never changes the thread's workspace", async () => {
    const { userId, cookie, wsId } = await setup("rb3@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: wsId } });

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
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.workspaceId).toBe(wsId);
    expect(reload.archivedAt).toBeTruthy();
    if (p.statusCode === 200) {
      expect(d.statusCode).toBe(204);
    } else {
      expect(p.statusCode).toBe(404);
    }
  });
});
