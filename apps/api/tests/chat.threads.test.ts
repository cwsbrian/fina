import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { threadsService } from "../src/chat/threads.js";

describe("threadsService (user-scoped)", () => {
  let userId: string;
  let otherUserId: string;
  let workspaceId: string;

  beforeEach(async () => {
    const stamp = `ths-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "T" } });
    await prisma.user.create({ data: { id: `${stamp}-other`, email: `${stamp}-other@t.co`, name: "O" } });
    const ws = await prisma.workspace.create({ data: { name: "ths-ws" } });
    await prisma.membership.create({ data: { userId: stamp, workspaceId: ws.id, role: "owner" } });
    userId = stamp;
    otherUserId = `${stamp}-other`;
    workspaceId = ws.id;
  });

  afterEach(async () => {
    await prisma.chatMessage.deleteMany({});
    await prisma.chatThread.deleteMany({});
    await prisma.membership.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  describe("create", () => {
    it("creates an unbound thread (workspaceId null)", async () => {
      const t = await threadsService.create({ userId, title: null });
      expect(t.userId).toBe(userId);
      expect(t.workspaceId).toBeNull();
      expect(t.title).toBeNull();
    });

    it("accepts an optional title", async () => {
      const t = await threadsService.create({ userId, title: "hello" });
      expect(t.title).toBe("hello");
    });
  });

  describe("list", () => {
    it("returns the user's threads, ordered by lastMessageAt DESC NULLS LAST", async () => {
      const older = await prisma.chatThread.create({
        data: { userId, workspaceId: null, lastMessageAt: new Date("2026-05-10T12:00:00Z") },
      });
      const newer = await prisma.chatThread.create({
        data: { userId, workspaceId: null, lastMessageAt: new Date("2026-05-15T12:00:00Z") },
      });
      const empty = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out.map((t) => t.id)).toEqual([newer.id, older.id, empty.id]);
    });

    it("does not return other users' threads", async () => {
      await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out).toEqual([]);
    });

    it("excludes archived by default", async () => {
      await prisma.chatThread.create({ data: { userId, workspaceId: null, archivedAt: new Date() } });
      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out).toEqual([]);
    });

    it("includes archived when requested", async () => {
      const arch = await prisma.chatThread.create({
        data: { userId, workspaceId: null, archivedAt: new Date() },
      });
      const out = await threadsService.list({ userId, includeArchived: true, limit: 10 });
      expect(out.map((t) => t.id)).toContain(arch.id);
    });
  });

  describe("findOwned", () => {
    it("returns the thread when userId matches", async () => {
      const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const found = await threadsService.findOwned({ threadId: t.id, userId });
      expect(found?.id).toBe(t.id);
    });

    it("returns null for another user's thread", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const found = await threadsService.findOwned({ threadId: t.id, userId });
      expect(found).toBeNull();
    });
  });

  describe("patch", () => {
    it("renames the thread regardless of bound state", async () => {
      const unbound = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const bound = await prisma.chatThread.create({ data: { userId, workspaceId } });
      const u = await threadsService.patch({ threadId: unbound.id, userId, title: "new" });
      const b = await threadsService.patch({ threadId: bound.id, userId, title: "new" });
      expect(u?.title).toBe("new");
      expect(b?.title).toBe("new");
    });

    it("returns null for another user's thread (does not mutate)", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const result = await threadsService.patch({ threadId: t.id, userId, title: "stolen" });
      expect(result).toBeNull();
      const reload = await prisma.chatThread.findUnique({ where: { id: t.id } });
      expect(reload?.title).toBeNull();
    });
  });

  describe("archive", () => {
    it("soft-archives both bound and unbound threads", async () => {
      const unbound = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const bound = await prisma.chatThread.create({ data: { userId, workspaceId } });
      const u = await threadsService.archive({ threadId: unbound.id, userId });
      const b = await threadsService.archive({ threadId: bound.id, userId });
      expect(u?.archivedAt).toBeTruthy();
      expect(b?.archivedAt).toBeTruthy();
    });

    it("is idempotent on already-archived", async () => {
      const t = await prisma.chatThread.create({
        data: { userId, workspaceId: null, archivedAt: new Date("2026-05-01T00:00:00Z") },
      });
      const out = await threadsService.archive({ threadId: t.id, userId });
      expect(out?.archivedAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    });

    it("returns null for another user's thread", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const result = await threadsService.archive({ threadId: t.id, userId });
      expect(result).toBeNull();
    });
  });
});
