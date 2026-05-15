import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { compareSpendingPeriods } from "../src/chat/tools/compare-spending-periods.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("compareSpendingPeriods tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let foodId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cmp-${Date.now()}`, email: `cmp-${Date.now()}@t.co`, name: "CMP" } });
    const ws = await prisma.workspace.create({ data: { name: "cmp-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const food = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    foodId = food.id;
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });

    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 10);
    await prisma.transaction.createMany({
      data: [
        // this month — food 30 (20 + 10)
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "tm-1", amount: "20.00", currency: "CAD", merchantRaw: "Sub", merchantNormalized: "sub", categoryId: food.id, occurredAt: thisMonth, rawData: {} },
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "tm-2", amount: "10.00", currency: "CAD", merchantRaw: "Sub", merchantNormalized: "sub", categoryId: food.id, occurredAt: thisMonth, rawData: {} },
        // last month — food 50
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "lm-1", amount: "50.00", currency: "CAD", merchantRaw: "Sub", merchantNormalized: "sub", categoryId: food.id, occurredAt: lastMonth, rawData: {} },
        // non-CAD this month
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "us-1", amount: "10.00", currency: "USD", merchantRaw: "X", occurredAt: thisMonth, rawData: {} },
      ],
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("throws invalid_period_pair for week vs month mismatch", async () => {
    await expect(
      compareSpendingPeriods.run(ctx, { current_period: "this_week", comparison_period: "last_month", group_by: "category" }),
    ).rejects.toThrow("invalid_period_pair");
  });

  it("computes category-level deltas for this_month vs last_month", async () => {
    const res = await compareSpendingPeriods.run(ctx, {
      current_period: "this_month",
      comparison_period: "last_month",
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
      current_period: "this_month",
      comparison_period: "last_month",
      group_by: "category",
    });
    expect(res.percentChange).toBeNull();
  });

  it("counts non-CAD exclusions per period", async () => {
    const res = await compareSpendingPeriods.run(ctx, {
      current_period: "this_month",
      comparison_period: "last_month",
      group_by: "category",
    });
    expect(res.currentExcludedNonCadCount).toBe(1);
    expect(res.comparisonExcludedNonCadCount).toBe(0);
  });

  it("group_by=merchant uses normalized merchant key", async () => {
    const res = await compareSpendingPeriods.run(ctx, {
      current_period: "this_month",
      comparison_period: "last_month",
      group_by: "merchant",
    });
    const sub = res.changes.find((c) => c.key === "sub");
    expect(sub?.label).toBe("Sub");
    expect(sub?.currentTotal).toBe("30.00");
    expect(sub?.comparisonTotal).toBe("50.00");
  });
});
