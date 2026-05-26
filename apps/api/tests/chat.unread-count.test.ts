import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `uc-${counter++}@x.com`, name: "T" });
  const thread = await prisma.chatThread.create({ data: { userId: u.userId, workspaceId: null } });
  return { cookie: u.cookie, userId: u.userId, threadId: thread.id };
}

async function addMsg(threadId: string, role: "assistant" | "user" | "tool", at?: Date) {
  await prisma.chatMessage.create({
    data: {
      threadId,
      role,
      blocks: [{ type: "text", markdown: "x" }],
      createdAt: at ?? new Date(),
    },
  });
}

describe("GET /chat/threads — unreadCount", () => {
  it("lastReadAt=null → all assistant messages count as unread", async () => {
    const { cookie, threadId } = await setup();
    await addMsg(threadId, "assistant");
    await addMsg(threadId, "assistant");
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(2);
  });

  it("filters out user/tool role messages", async () => {
    const { cookie, threadId } = await setup();
    await addMsg(threadId, "assistant");
    await addMsg(threadId, "user");
    await addMsg(threadId, "tool");
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(1);
  });

  it("lastReadAt set in past → only messages after that count", async () => {
    const { cookie, threadId } = await setup();
    const past = new Date(Date.now() - 60_000);
    await addMsg(threadId, "assistant", new Date(past.getTime() - 1000));
    await prisma.chatThread.update({ where: { id: threadId }, data: { lastReadAt: past } });
    await addMsg(threadId, "assistant", new Date(past.getTime() + 1000));
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(1);
  });

  it("includes lastReadAt as ISO string in response", async () => {
    const { cookie, threadId } = await setup();
    await prisma.chatThread.update({ where: { id: threadId }, data: { lastReadAt: new Date("2026-05-01T00:00:00Z") } });
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(typeof t.lastReadAt).toBe("string");
    expect(t.lastReadAt).toContain("2026-05-01");
  });
});
