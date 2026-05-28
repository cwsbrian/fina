import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { compareSpendingPeriods } from "../src/chat/tools/compare-spending-periods.js";
import type { ToolContext } from "../src/chat/tools/types.js";

const FIXED_NOW = new Date("2026-05-15T12:00:00Z");

describe("compareSpendingPeriods tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let foodId: string;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cmp-${Math.floor(Math.random() * 1e12)}`, email: `cmp-${Math.floor(Math.random() * 1e12)}@t.co`, name: "CMP" } });
    const ws = await prisma.workspace.create({ data: { name: "cmp-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const food = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    foodId = food.id;
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });

    const thisMonth = new Date("2026-05-05T12:00:00Z");
    const lastMonth = new Date("2026-04-10T12:00:00Z");
    const txData = [
      // this month — food 30 (20 + 10)
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "tm-1", amount: "20.00", merchantRaw: "Sub", merchantNormalized: "sub", allocCategoryId: food.id, occurredAt: thisMonth, rawData: {} },
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "tm-2", amount: "10.00", merchantRaw: "Sub", merchantNormalized: "sub", allocCategoryId: food.id, occurredAt: thisMonth, rawData: {} },
      // last month — food 50
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "lm-1", amount: "50.00", merchantRaw: "Sub", merchantNormalized: "sub", allocCategoryId: food.id, occurredAt: lastMonth, rawData: {} },
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

  it("rejects until <= since (invalid_date_range) with context in message", async () => {
    await expect(
      compareSpendingPeriods.run(ctx, {
        current_since: "2026-05-15",
        current_until: "2026-05-15",
        comparison_since: "2026-04-01",
        comparison_until: "2026-05-01",
        group_by: "category",
      }),
    ).rejects.toThrow(/invalid_date_range.*2026-05-15.*2026-05-15/);
  });

  it("rejects impossible calendar date (e.g. 2026-02-30) with which-arg context", async () => {
    await expect(
      compareSpendingPeriods.run(ctx, {
        current_since: "2026-02-01",
        current_until: "2026-02-30",
        comparison_since: "2026-01-01",
        comparison_until: "2026-02-01",
        group_by: "category",
      }),
    ).rejects.toThrow(/invalid_date_format.*until.*2026-02-30/);
  });

  it("computes category-level deltas for this_month vs last_month", async () => {
    const res = await compareSpendingPeriods.run(ctx, {
      current_since: "2026-05-01",
      current_until: "2026-06-01",
      comparison_since: "2026-04-01",
      comparison_until: "2026-05-01",
      group_by: "category",
    });
    expect(res.currentTotal).toBe("30.00");
    expect(res.comparisonTotal).toBe("50.00");
    expect(res.delta).toBe("-20.00");
    expect(res.percentChange).toBeCloseTo(-20 / 50, 5);
    const food = res.changes.find((c) => c.key === foodId);
    expect(food?.label).toBe("Food");
    expect(food?.delta).toBe("-20.00");
  });

  it("returns null percentChange when comparison total is zero", async () => {
    await prisma.transaction.deleteMany({ where: { workspaceId: wsId, plaidTransactionId: "lm-1" } });
    const res = await compareSpendingPeriods.run(ctx, {
      current_since: "2026-05-01",
      current_until: "2026-06-01",
      comparison_since: "2026-04-01",
      comparison_until: "2026-05-01",
      group_by: "category",
    });
    expect(res.percentChange).toBeNull();
  });

  it("group_by=merchant uses normalized merchant key", async () => {
    const res = await compareSpendingPeriods.run(ctx, {
      current_since: "2026-05-01",
      current_until: "2026-06-01",
      comparison_since: "2026-04-01",
      comparison_until: "2026-05-01",
      group_by: "merchant",
    });
    const sub = res.changes.find((c) => c.key === "sub");
    expect(sub?.label).toBe("Sub");
    expect(sub?.currentTotal).toBe("30.00");
    expect(sub?.comparisonTotal).toBe("50.00");
  });
});
