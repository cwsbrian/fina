import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listUnresolvedSchedules } from "../src/chat/tools/list-unresolved-schedules.js";
import { consumeIntentService } from "../src/intents/service.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listUnresolvedSchedules chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catId: string;

  beforeEach(async () => {
    const stamp = `lus-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LUS", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lus-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Rent" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns scheduled_list with a consumable dismiss_intent per row", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: catId, amount: "1500.00", scheduledDate: new Date("2026-05-01"), note: "May rent" },
    });
    const r = await listUnresolvedSchedules.run(ctx, {});
    if (r.block?.type !== "scheduled_list") throw new Error("wrong block");
    const row = r.block.rows[0]!;
    expect(row.status).toBe("unresolved");
    expect(typeof row.dismiss_intent).toBe("string");

    const out = await consumeIntentService(
      { workspaceId: wsId, userId: ctx.userId, role: "owner", env: {} as never },
      row.dismiss_intent!,
    );
    expect(out.result).toBeTruthy();
  });
});
