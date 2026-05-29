import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { compareSpendingVsBudget } from "../src/chat/tools/compare-spending-vs-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("compareSpendingVsBudget chat tool (BudgetPlan)", () => {
  let ctx: ToolContext;
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `cvb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "CVB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "cvb-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("builds items + recap from the BudgetPlan, per capped category", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "200.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "200.00" } });

    const r = await compareSpendingVsBudget.run(ctx, {});
    expect(r.block.type).toBe("recap");
    const item = r.items.find((i) => i.categoryName === "Dining")!;
    expect(item.amount).toBe("500.00");
    expect(item.spent).toBe("200.00");
    expect(item.remaining).toBe("300.00");
  });

  it("headline Used % counts ALL spend (capped + uncapped), not just capped rows", async () => {
    // $500 cap on Dining out of a $9,000 total budget; $200 spent in
    // Dining (capped) + $8,000 spent in an UNCAPPED category. Home/getBudget
    // report 8200/9000 = 91% used. The recap headline must match — the old
    // bug summed only capped rows (200/500 = 40%, or 200/9000 = 2%) and
    // hid the uncapped spend.
    const misc = (await prisma.category.create({ data: { workspaceId: wsId, name: "Misc" } })).id;
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    const tx1 = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "200.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx1.id, categoryId: dining, amount: "200.00" } });
    const tx2 = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "8000.00", merchantRaw: "Rent", occurredAt: new Date("2026-05-09T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx2.id, categoryId: misc, amount: "8000.00" } });

    const r = await compareSpendingVsBudget.run(ctx, {});
    if (r.block.type !== "recap") throw new Error("wrong block");
    expect(r.block.headline?.amount).toBe("91%"); // 8200 / 9000
    expect(r.block.headline?.delta?.value).toBe("800.00"); // 9000 - 8200
    // Only the capped category is a row; the uncapped spend isn't listed
    // but is still reflected in the headline total.
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.categoryName).toBe("Dining");
  });

  it("no plan → empty items + recap", async () => {
    const r = await compareSpendingVsBudget.run(ctx, {});
    expect(r.items).toHaveLength(0);
    expect(r.block.type).toBe("recap");
  });
});
