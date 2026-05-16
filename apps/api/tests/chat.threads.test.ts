import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { threadsService } from "../src/chat/threads.js";

describe("threadsService", () => {
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    await truncateAll();
    const u = await prisma.user.create({ data: { id: `th-${Date.now()}`, email: `th-${Date.now()}@t.co`, name: "TH" } });
    const ws = await prisma.workspace.create({ data: { name: "th-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const ws2 = await prisma.workspace.create({ data: { name: "other-ws" } });
    otherWsId = ws2.id;
  });

  afterAll(async () => { await disconnect(); });

  it("create returns a row scoped to the workspace", async () => {
    const t = await threadsService.create({ workspaceId: wsId, title: null });
    expect(t.workspaceId).toBe(wsId);
    expect(t.title).toBeNull();
    expect(t.archivedAt).toBeNull();
    expect(t.lastMessageAt).toBeNull();
  });

  it("list returns non-archived threads sorted by lastMessageAt desc, then createdAt desc", async () => {
    const a = await threadsService.create({ workspaceId: wsId, title: "a" });
    const b = await threadsService.create({ workspaceId: wsId, title: "b" });
    // bump b's lastMessageAt
    await prisma.chatThread.update({ where: { id: b.id }, data: { lastMessageAt: new Date("2026-05-15T10:00:00Z") } });
    const list = await threadsService.list({ workspaceId: wsId, includeArchived: false, limit: 50 });
    expect(list.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("list excludes archived by default", async () => {
    const a = await threadsService.create({ workspaceId: wsId });
    const b = await threadsService.create({ workspaceId: wsId });
    await prisma.chatThread.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    const visible = await threadsService.list({ workspaceId: wsId, includeArchived: false, limit: 50 });
    expect(visible.map((t) => t.id)).toEqual([b.id]);
    const all = await threadsService.list({ workspaceId: wsId, includeArchived: true, limit: 50 });
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("findOwned returns the thread when workspace matches", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const found = await threadsService.findOwned({ threadId: t.id, workspaceId: wsId });
    expect(found?.id).toBe(t.id);
  });

  it("findOwned returns null for cross-workspace lookups", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const found = await threadsService.findOwned({ threadId: t.id, workspaceId: otherWsId });
    expect(found).toBeNull();
  });

  it("patch updates title; null clears it", async () => {
    const t = await threadsService.create({ workspaceId: wsId, title: "first" });
    const renamed = await threadsService.patch({ threadId: t.id, workspaceId: wsId, title: "second" });
    expect(renamed?.title).toBe("second");
    const cleared = await threadsService.patch({ threadId: t.id, workspaceId: wsId, title: null });
    expect(cleared?.title).toBeNull();
  });

  it("patch returns null for cross-workspace ids", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const result = await threadsService.patch({ threadId: t.id, workspaceId: otherWsId, title: "evil" });
    expect(result).toBeNull();
  });

  it("archive sets archivedAt; second call is a no-op (still archived)", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const first = await threadsService.archive({ threadId: t.id, workspaceId: wsId });
    expect(first?.archivedAt).toBeInstanceOf(Date);
    const second = await threadsService.archive({ threadId: t.id, workspaceId: wsId });
    expect(second?.archivedAt).toBeInstanceOf(Date);
    // archivedAt should not change between calls
    expect(second?.archivedAt?.getTime()).toBe(first?.archivedAt?.getTime());
  });

  it("archive returns null for cross-workspace ids", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const result = await threadsService.archive({ threadId: t.id, workspaceId: otherWsId });
    expect(result).toBeNull();
  });
});
