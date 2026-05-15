import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { getSpendingSummary } from "../src/chat/tools/get-spending-summary.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getSpendingSummary tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catCoffeeId: string;
  let catFoodId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `gs-${Date.now()}`, email: `gs-${Date.now()}@t.co`, name: "GS" } });
    const ws = await prisma.workspace.create({ data: { name: "gs-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catCoffeeId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    catFoodId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    await prisma.transaction.createMany({
      data: [
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "1", amount: "5.00", merchantRaw: "Starbucks", merchantNormalized: "starbucks", categoryId: catCoffeeId, occurredAt: thisMonth, rawData: {} },
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "2", amount: "4.00", merchantRaw: "Starbucks", merchantNormalized: "starbucks", categoryId: catCoffeeId, occurredAt: thisMonth, rawData: {} },
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "3", amount: "12.00", merchantRaw: "Subway", merchantNormalized: "subway", categoryId: catFoodId, occurredAt: thisMonth, rawData: {} },
      ],
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("group_by=category totals are correct", async () => {
    const res = await getSpendingSummary.run(ctx, { period: "this_month", group_by: "category" });
    const coffee = res.groups.find((g) => g.key === catCoffeeId);
    const food = res.groups.find((g) => g.key === catFoodId);
    expect(coffee?.total).toBe("9.00");
    expect(food?.total).toBe("12.00");
  });

  it("group_by=merchant uses merchantNormalized", async () => {
    const res = await getSpendingSummary.run(ctx, { period: "this_month", group_by: "merchant" });
    const sb = res.groups.find((g) => g.key === "starbucks");
    expect(sb?.total).toBe("9.00");
  });

  it("defaults to group_by=category when omitted", async () => {
    const res = await getSpendingSummary.run(ctx, { period: "this_month" });
    expect(res.groupBy).toBe("category");
  });

  it("isolates by workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const oa = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: other.id, accountId: oa.id, plaidTransactionId: "x", amount: "999.00", merchantRaw: "x", occurredAt: new Date(), rawData: {} } });
    const res = await getSpendingSummary.run(ctx, { period: "this_month" });
    const totals = res.groups.reduce((s, g) => s + parseFloat(g.total), 0);
    expect(totals).toBeLessThan(999);
    await prisma.workspace.delete({ where: { id: other.id } });
  });
});
