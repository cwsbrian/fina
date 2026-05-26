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
  const u = await signUpAndGetCookie(app, { email: `cr-${counter++}@x.com`, name: "T" });
  const thread = await prisma.chatThread.create({
    data: { userId: u.userId, workspaceId: null },
  });
  return { cookie: u.cookie, userId: u.userId, threadId: thread.id };
}

describe("POST /chat/threads/:tid/read", () => {
  it("marks thread as read (sets lastReadAt)", async () => {
    const { cookie, threadId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/chat/threads/${threadId}/read`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.lastReadAt).not.toBeNull();
  });

  it("returns 404 for thread owned by another user", async () => {
    const { threadId } = await setup();
    const other = await signUpAndGetCookie(app, { email: `cr-other-${counter++}@x.com`, name: "B" });
    const r = await app.inject({
      method: "POST",
      url: `/chat/threads/${threadId}/read`,
      headers: { cookie: other.cookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it("idempotent — second call updates lastReadAt again", async () => {
    const { cookie, threadId } = await setup();
    await app.inject({ method: "POST", url: `/chat/threads/${threadId}/read`, headers: { cookie } });
    const first = await prisma.chatThread.findUnique({ where: { id: threadId } });
    await new Promise((r) => setTimeout(r, 20));
    const r = await app.inject({ method: "POST", url: `/chat/threads/${threadId}/read`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const second = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(second!.lastReadAt!.getTime()).toBeGreaterThan(first!.lastReadAt!.getTime());
  });
});
