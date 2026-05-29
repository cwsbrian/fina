import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { listGoals } from "../src/chat/tools/list-goals.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listGoals chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `lg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LG", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lg-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns no block when there are no goals", async () => {
    const r = await listGoals.run(ctx, {});
    expect(r.block).toBeUndefined();
    expect(r.goals).toHaveLength(0);
  });

  it("returns a goals_list with rows, bar_pct, and D-day label", async () => {
    await prisma.goal.create({
      data: {
        workspaceId: wsId,
        title: "Japan trip",
        targetAmount: new Prisma.Decimal(2000),
        savedAmount: new Prisma.Decimal(0),
        dueDate: new Date("2026-06-26T12:00:00.000Z"), // 42 days out
        icon: "airplane-outline",
        color: "#3366cc",
      },
    });
    const r = await listGoals.run(ctx, {});
    if (r.block?.type !== "goals_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(1);
    const row = r.block.rows[0]!;
    expect(row.title).toBe("Japan trip");
    expect(row.target).toBe("2000.00");
    expect(row.saved).toBe("0.00"); // computed; no allocations -> 0
    expect(row.due_label).toBe("D-42");
    expect(typeof row.bar_pct).toBe("number");
  });

  it("caps rows at MAX_ROWS and reports the overflow in the footer", async () => {
    for (let i = 0; i < 7; i++) {
      await prisma.goal.create({
        data: {
          workspaceId: wsId,
          title: `Goal ${i}`,
          targetAmount: new Prisma.Decimal(100),
          savedAmount: new Prisma.Decimal(0),
          dueDate: new Date(`2026-08-${10 + i}T12:00:00.000Z`),
        },
      });
    }
    const r = await listGoals.run(ctx, {});
    if (r.block?.type !== "goals_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(6);
    expect(r.block.footer).toContain("+1 more");
  });

  it("excludes archived goals", async () => {
    await prisma.goal.create({
      data: {
        workspaceId: wsId, title: "Old", targetAmount: new Prisma.Decimal(100),
        savedAmount: new Prisma.Decimal(0), dueDate: new Date("2026-07-01T12:00:00.000Z"),
        archivedAt: new Date("2026-05-01T12:00:00.000Z"),
      },
    });
    const r = await listGoals.run(ctx, {});
    expect(r.block).toBeUndefined();
  });
});
