import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { getCategoryBreakdown } from "../src/chat/tools/get-category-breakdown.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getCategoryBreakdown tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let foodId: string;
  let coffeeId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cb-${Date.now()}`, email: `cb-${Date.now()}@t.co`, name: "CB" } });
    const ws = await prisma.workspace.create({ data: { name: "cb-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };

    const food = await prisma.category.create({ data: { workspaceId: wsId, name: "Food", color: "#ff0000", icon: "🍔" } });
    foodId = food.id;
    const coffee = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee", parentId: food.id } });
    coffeeId = coffee.id;
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });

    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    const txData: Array<{ workspaceId: string; accountId: string; plaidTransactionId: string; amount: string; merchantRaw: string; occurredAt: Date; rawData: object; allocCategoryId?: string }> = [
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "1", amount: "10.00", merchantRaw: "Sb", allocCategoryId: coffee.id, occurredAt: thisMonth, rawData: {} },
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "2", amount: "20.00", merchantRaw: "Sub", allocCategoryId: food.id, occurredAt: thisMonth, rawData: {} },
      // uncategorized
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "3", amount: "5.00", merchantRaw: "X", occurredAt: thisMonth, rawData: {} },
      // negative (refund) — must be excluded from spending aggregate
      { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "4", amount: "-50.00", merchantRaw: "Refund", allocCategoryId: food.id, occurredAt: thisMonth, rawData: {} },
    ];
    for (const d of txData) {
      const { allocCategoryId, ...txCreateData } = d;
      const tx = await prisma.transaction.create({ data: txCreateData });
      await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
      await prisma.transactionAllocation.create({
        data: { transactionId: tx.id, categoryId: allocCategoryId ?? null, amount: d.amount, source: null },
      });
    }
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns totals with parent metadata", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    expect(res.currency).toBe("CAD");
    expect(res.total).toBe("35.00");
    const coffee = res.categories.find((c) => c.categoryId === coffeeId);
    expect(coffee?.parentCategoryName).toBe("Food");
    expect(coffee?.parentCategoryId).toBe(foodId);
    expect(coffee?.total).toBe("10.00");
  });

  it("excludes negative amounts from spending", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.total).toBe("20.00");
  });

  it("includes uncategorized bucket by default", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    const uncat = res.categories.find((c) => c.categoryId === null);
    expect(uncat?.categoryName).toBe("Uncategorized");
    expect(uncat?.total).toBe("5.00");
  });

  it("excludes uncategorized when include_uncategorized=false", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01", include_uncategorized: false });
    expect(res.categories.find((c) => c.categoryId === null)).toBeUndefined();
  });

  it("total and share reflect only visible buckets when include_uncategorized=false", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01", include_uncategorized: false });
    // Categorized spend is 30 (coffee 10 + food 20); uncat (5) is excluded from total and shares.
    expect(res.total).toBe("30.00");
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.share).toBeCloseTo(20 / 30, 5);
  });

  it("share sums computed before limit", async () => {
    const res = await getCategoryBreakdown.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    // shares relative to 35 (total before limit)
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.share).toBeCloseTo(20 / 35, 5);
  });
});
