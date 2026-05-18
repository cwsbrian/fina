import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { withWorkspaceLock } from "../src/locks/workspace.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

describe("withWorkspaceLock", () => {
  it("runs callback inside a transaction with the lock acquired first", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws" } });
    const out = await withWorkspaceLock(ws.id, async (tx) => {
      const row = await tx.workspace.findUnique({
        where: { id: ws.id }, select: { id: true },
      });
      return row?.id;
    });
    expect(out).toBe(ws.id);
  });

  it("blocks a second concurrent call until the first releases", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws-2" } });
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((r) => { resolveFirst = r; });
    let secondStartedAt = 0;
    let secondFinishedAt = 0;

    const first = withWorkspaceLock(ws.id, async () => {
      await firstHold;
      return "first-done";
    });
    await new Promise((r) => setTimeout(r, 100));

    const second = withWorkspaceLock(ws.id, async () => {
      secondFinishedAt = Date.now();
      return "second-done";
    });
    secondStartedAt = Date.now();

    await new Promise((r) => setTimeout(r, 200));
    expect(secondFinishedAt).toBe(0);

    resolveFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("first-done");
    expect(b).toBe("second-done");
    expect(secondFinishedAt - secondStartedAt).toBeGreaterThan(100);
  });

  it("propagates callback errors and rolls back", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws-3" } });
    await expect(
      withWorkspaceLock(ws.id, async (tx) => {
        await tx.category.create({ data: { workspaceId: ws.id, name: "ShouldRollback" } });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    const count = await prisma.category.count({ where: { workspaceId: ws.id, name: "ShouldRollback" } });
    expect(count).toBe(0);
  });

  it("does not block writes against different workspaces", async () => {
    const a = await prisma.workspace.create({ data: { name: "ws-a" } });
    const b = await prisma.workspace.create({ data: { name: "ws-b" } });
    let resolveFirst!: () => void;
    const hold = new Promise<void>((r) => { resolveFirst = r; });

    const first = withWorkspaceLock(a.id, async () => { await hold; });
    await new Promise((r) => setTimeout(r, 100));
    const otherStart = Date.now();
    await withWorkspaceLock(b.id, async () => { /* immediate */ });
    const otherDur = Date.now() - otherStart;
    expect(otherDur).toBeLessThan(500);

    resolveFirst();
    await first;
  });
});
