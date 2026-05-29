import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { sweepExpiredIntents } from "../src/intents/sweep.js";

describe("sweepExpiredIntents", () => {
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `sw-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "SW" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "sw-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("deletes expired unconsumed intents and keeps active/consumed ones", async () => {
    const base = { workspaceId: wsId, userId, kind: "tool_call", payload: {} as never };
    const expired = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() - 60_000) },
    });
    const active = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const consumed = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() - 60_000), consumedAt: new Date() },
    });

    const n = await sweepExpiredIntents();
    expect(n).toBe(1);
    expect(await prisma.actionIntent.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.actionIntent.findUnique({ where: { id: active.id } })).not.toBeNull();
    expect(await prisma.actionIntent.findUnique({ where: { id: consumed.id } })).not.toBeNull();
  });
});
