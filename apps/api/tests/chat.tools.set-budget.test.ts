import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudget } from "../src/chat/tools/set-budget.js";
import { getOrSnapshotMonthBudget } from "../src/budget-plans/service.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("setBudget chat tool (BudgetPlan)", () => {
  let ctx: ToolContext;
  let wsId: string;
  let dining: string;
  let shopping: string;

  beforeEach(async () => {
    const stamp = `sb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "SB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "sb-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    shopping = (await prisma.category.create({ data: { workspaceId: wsId, name: "Shopping" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("creates a plan from nothing with total = the allocation", async () => {
    await setBudget.run(ctx, { category_name: "Dining", amount: 500 });
    const plan = await getOrSnapshotMonthBudget(wsId, 2026, 5);
    expect(plan).not.toBeNull();
    expect(plan!.totalAmount).toBe("500.00");
    expect(plan!.categoryAllocations).toEqual([{ categoryId: dining, amount: 500 }]);
  });

  it("preserves a larger existing total when adding a category", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    await setBudget.run(ctx, { category_name: "Shopping", amount: 540 });
    const plan = await getOrSnapshotMonthBudget(wsId, 2026, 5);
    expect(plan!.totalAmount).toBe("9000.00"); // preserved, not 1040
    const byId = Object.fromEntries(plan!.categoryAllocations.map((a) => [a.categoryId, a.amount]));
    expect(byId[dining]).toBe(500);
    expect(byId[shopping]).toBe(540);
  });

  it("grows the total when allocations exceed the existing cap", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "600.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    await setBudget.run(ctx, { category_name: "Shopping", amount: 400 });
    const plan = await getOrSnapshotMonthBudget(wsId, 2026, 5);
    expect(plan!.totalAmount).toBe("900.00"); // sum 900 > old cap 600
  });

  it("replaces an existing category's allocation (no duplicate)", async () => {
    await setBudget.run(ctx, { category_name: "Dining", amount: 500 });
    await setBudget.run(ctx, { category_name: "Dining", amount: 650 });
    const plan = await getOrSnapshotMonthBudget(wsId, 2026, 5);
    expect(plan!.categoryAllocations).toEqual([{ categoryId: dining, amount: 650 }]);
    expect(plan!.totalAmount).toBe("650.00");
  });
});
