import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listScheduledSpends } from "../src/chat/tools/list-scheduled-spends.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listScheduledSpends scheduled_list block", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catId: string;

  beforeEach(async () => {
    const stamp = `lss-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LSS", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lss-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Rent" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a scheduled_list block with no dismiss_intent", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: catId, amount: "1500.00", scheduledDate: new Date("2026-06-01"), note: "June rent" },
    });
    const r = await listScheduledSpends.run(ctx, {});
    expect(r.block?.type).toBe("scheduled_list");
    if (r.block?.type !== "scheduled_list") throw new Error("wrong block");
    expect(r.block.rows[0]!.name).toBe("June rent");
    expect(r.block.rows[0]!.dismiss_intent).toBeUndefined();
  });

  it("falls back to category name when note is null", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: catId, amount: "1500.00", scheduledDate: new Date("2026-06-01"), note: null },
    });
    const r = await listScheduledSpends.run(ctx, {});
    if (r.block?.type !== "scheduled_list") throw new Error("wrong block");
    expect(r.block.rows[0]!.name).toBe("Rent");
  });
});
