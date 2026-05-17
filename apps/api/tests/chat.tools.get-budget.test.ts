import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { getBudget } from "../src/chat/tools/get-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getBudget chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `gb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "GB", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "gb-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    coffeeCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns single budget when category_id provided", async () => {
    await prisma.budget.create({
      data: { workspaceId: wsId, categoryId: coffeeCatId, amount: "300.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
    });
    const r = await getBudget.run(ctx, { category_id: coffeeCatId });
    expect(r.budgets).toHaveLength(1);
    expect(r.budgets[0]!.categoryName).toBe("Coffee");
  });

  it("returns all budgets for period when no category", async () => {
    const foodId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } })).id;
    await prisma.budget.createMany({
      data: [
        { workspaceId: wsId, categoryId: coffeeCatId, amount: "100.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
        { workspaceId: wsId, categoryId: foodId, amount: "200.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
      ],
    });
    const r = await getBudget.run(ctx, {});
    expect(r.budgets).toHaveLength(2);
  });

  it("returns empty array when no budgets exist", async () => {
    const r = await getBudget.run(ctx, {});
    expect(r.budgets).toEqual([]);
  });
});
