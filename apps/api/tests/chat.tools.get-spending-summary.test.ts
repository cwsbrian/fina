import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { getSpendingSummary } from "../src/chat/tools/get-spending-summary.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getSpendingSummary tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catCoffeeId: string;
  let catFoodId: string;

  beforeEach(async () => {
    const stamp = `gs-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GS" } });
    const ws = await prisma.workspace.create({ data: { name: "gs-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catCoffeeId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    catFoodId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    const thisMonth = new Date("2026-05-05T12:00:00Z"); // noon UTC May 5 = 8am ET May 5
    const txData = [
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "1", amount: "5.00", merchantRaw: "Starbucks", merchantNormalized: "starbucks", allocCategoryId: catCoffeeId, occurredAt: thisMonth, rawData: {} },
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "2", amount: "4.00", merchantRaw: "Starbucks", merchantNormalized: "starbucks", allocCategoryId: catCoffeeId, occurredAt: thisMonth, rawData: {} },
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "3", amount: "12.00", merchantRaw: "Subway", merchantNormalized: "subway", allocCategoryId: catFoodId, occurredAt: thisMonth, rawData: {} },
    ];
    for (const d of txData) {
      const { allocCategoryId, ...txCreateData } = d;
      const tx = await prisma.transaction.create({ data: txCreateData });
      await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
      await prisma.transactionAllocation.create({
        data: { transactionId: tx.id, categoryId: allocCategoryId, amount: d.amount, source: null },
      });
    }
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("group_by=category totals are correct", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      const res = await getSpendingSummary.run(ctx, { period: "this_month", group_by: "category" });
      const coffee = res.groups.find((g) => g.key === catCoffeeId);
      const food = res.groups.find((g) => g.key === catFoodId);
      expect(coffee?.total).toBe("9.00");
      expect(food?.total).toBe("12.00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("group_by=merchant uses merchantNormalized", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      const res = await getSpendingSummary.run(ctx, { period: "this_month", group_by: "merchant" });
      const sb = res.groups.find((g) => g.key === "starbucks");
      expect(sb?.total).toBe("9.00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to group_by=category when omitted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      const res = await getSpendingSummary.run(ctx, { period: "this_month" });
      expect(res.groupBy).toBe("category");
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates by workspace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      const other = await prisma.workspace.create({ data: { name: "other" } });
      const oa = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
      await prisma.transaction.create({ data: { workspaceId: other.id, accountId: oa.id, plaidTransactionId: "x", amount: "999.00", merchantRaw: "x", occurredAt: new Date(), rawData: {} } });
      const res = await getSpendingSummary.run(ctx, { period: "this_month" });
      const totals = res.groups.reduce((s, g) => s + parseFloat(g.total), 0);
      expect(totals).toBeLessThan(999);
      await prisma.workspace.delete({ where: { id: other.id } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("category mode excludes negative-amount allocations (refunds)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "refund-acct", type: "depository" } });
      // Add a refund allocation with negative amount under catCoffeeId
      const refundTx = await prisma.transaction.create({
        data: {
          workspaceId: wsId, accountId: acct.id,
          plaidTransactionId: "refund-1",
          amount: "-3.00", merchantRaw: "Starbucks Refund", merchantNormalized: "starbucks",
          occurredAt: new Date("2026-05-06T12:00:00Z"),
          pending: false, source: "plaid", rawData: {},
        },
      });
      await prisma.transactionAllocation.deleteMany({ where: { transactionId: refundTx.id } });
      await prisma.transactionAllocation.create({
        data: { transactionId: refundTx.id, categoryId: catCoffeeId, amount: "-3.00", source: null },
      });

      const res = await getSpendingSummary.run(ctx, { period: "this_month", group_by: "category" });
      // Coffee total should still be 9.00 (5+4), not 6.00 (9-3)
      const coffee = res.groups.find((g) => g.key === catCoffeeId);
      expect(coffee?.total).toBe("9.00");
    } finally {
      vi.useRealTimers();
    }
  });
});
