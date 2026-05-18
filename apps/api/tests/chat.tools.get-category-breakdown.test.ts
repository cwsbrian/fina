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
    await prisma.transaction.createMany({
      data: [
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "1", amount: "10.00", merchantRaw: "Sb", categoryId: coffee.id, occurredAt: thisMonth, rawData: {} },
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "2", amount: "20.00", merchantRaw: "Sub", categoryId: food.id, occurredAt: thisMonth, rawData: {} },
        // uncategorized
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "3", amount: "5.00", merchantRaw: "X", occurredAt: thisMonth, rawData: {} },
        // negative (refund) — must be excluded from spending aggregate
        { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "4", amount: "-50.00", merchantRaw: "Refund", categoryId: food.id, occurredAt: thisMonth, rawData: {} },
      ],
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns totals with parent metadata", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month" });
    expect(res.currency).toBe("CAD");
    expect(res.total).toBe("35.00");
    const coffee = res.categories.find((c) => c.categoryId === coffeeId);
    expect(coffee?.parentCategoryName).toBe("Food");
    expect(coffee?.parentCategoryId).toBe(foodId);
    expect(coffee?.total).toBe("10.00");
  });

  it("excludes negative amounts from spending", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month" });
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.total).toBe("20.00");
  });

  it("includes uncategorized bucket by default", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month" });
    const uncat = res.categories.find((c) => c.categoryId === null);
    expect(uncat?.categoryName).toBe("Uncategorized");
    expect(uncat?.total).toBe("5.00");
  });

  it("excludes uncategorized when include_uncategorized=false", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month", include_uncategorized: false });
    expect(res.categories.find((c) => c.categoryId === null)).toBeUndefined();
  });

  it("total and share reflect only visible buckets when include_uncategorized=false", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month", include_uncategorized: false });
    // Categorized spend is 30 (coffee 10 + food 20); uncat (5) is excluded from total and shares.
    expect(res.total).toBe("30.00");
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.share).toBeCloseTo(20 / 30, 5);
  });

  it("share sums computed before limit", async () => {
    const res = await getCategoryBreakdown.run(ctx, { period: "this_month" });
    // shares relative to 35 (total before limit)
    const food = res.categories.find((c) => c.categoryId === foodId);
    expect(food?.share).toBeCloseTo(20 / 35, 5);
  });
});
