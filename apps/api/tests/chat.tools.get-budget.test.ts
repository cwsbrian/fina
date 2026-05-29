import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { getBudget } from "../src/chat/tools/get-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getBudget chat tool (BudgetPlan)", () => {
  let ctx: ToolContext;
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `gb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "gb-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining", color: "#cc33aa", icon: "🍽️" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns no block when there is no plan", async () => {
    const r = await getBudget.run(ctx, {});
    expect(r.block).toBeUndefined();
    expect(r.plan).toBeNull();
  });

  it("returns a budget_list with headline + capped rows", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "620.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "620.00" } });

    const r = await getBudget.run(ctx, {});
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.headline?.cap).toBe("9000.00");
    expect(r.block.headline?.spent).toBe("620.00");
    expect(r.block.headline?.left).toBe("8380.00");
    const row = r.block.rows[0]!;
    expect(row.amount).toBe("500.00");
    expect(row.spent).toBe("620.00");
    expect(row.over).toBe(true);
  });

  it("total-only plan → headline, no rows", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [] },
    });
    const r = await getBudget.run(ctx, {});
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.headline?.cap).toBe("9000.00");
    expect(r.block.rows).toHaveLength(0);
  });

  it("filters to a capped category", async () => {
    const groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }, { categoryId: groceries, amount: 300 }] },
    });
    const r = await getBudget.run(ctx, { category_name: "Dining" });
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(1);
    expect(r.block.rows[0]!.id).toBe(dining);
  });

  it("filtering to an uncapped category shows a 'no cap set' footer, no rows", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "50.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "50.00" } });
    const r = await getBudget.run(ctx, { category_name: "Dining" });
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(0);
    expect(r.block.footer).toContain("no cap set");
  });
});
