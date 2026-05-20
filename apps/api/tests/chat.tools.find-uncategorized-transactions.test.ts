import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findUncategorizedTransactions } from "../src/chat/tools/find-uncategorized-transactions.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("findUncategorizedTransactions tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;
  let catId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `fu-${Date.now()}`, email: `fu-${Date.now()}@t.co`, name: "FU" } });
    const ws = await prisma.workspace.create({ data: { name: "fu-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    catId = cat.id;
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    acctId = acct.id;

    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);

    type TxSeed = {
      plaidTransactionId: string;
      amount: string;
      merchantRaw: string;
      occurredAt: Date;
      rawData: object;
      removedAt?: Date;
      allocCategoryId?: string | null;
      allocSource?: "ai" | "manual" | "mapping" | null;
    };
    const txSeeds: TxSeed[] = [
      // uncategorized — allocation has null categoryId and null source
      { plaidTransactionId: "u1", amount: "5.00", merchantRaw: "A", occurredAt: thisMonth, rawData: {}, allocCategoryId: null, allocSource: null },
      // ai-categorized — allocation has source=ai
      { plaidTransactionId: "a1", amount: "6.00", merchantRaw: "B", occurredAt: thisMonth, rawData: {}, allocCategoryId: catId, allocSource: "ai" },
      // manual — allocation has source=manual
      { plaidTransactionId: "m1", amount: "7.00", merchantRaw: "C", occurredAt: thisMonth, rawData: {}, allocCategoryId: catId, allocSource: "manual" },
      // soft-deleted uncategorized — excluded by removedAt filter
      { plaidTransactionId: "d1", amount: "8.00", merchantRaw: "D", occurredAt: thisMonth, rawData: {}, removedAt: new Date(), allocCategoryId: null, allocSource: null },
    ];
    for (const s of txSeeds) {
      const tx = await prisma.transaction.create({
        data: {
          workspaceId: wsId,
          accountId: acctId,
          plaidTransactionId: s.plaidTransactionId,
          amount: s.amount,
          merchantRaw: s.merchantRaw,
          occurredAt: s.occurredAt,
          rawData: s.rawData,
          ...(s.removedAt ? { removedAt: s.removedAt } : {}),
        },
      });
      await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
      await prisma.transactionAllocation.create({
        data: {
          transactionId: tx.id,
          categoryId: s.allocCategoryId ?? null,
          amount: s.amount,
          source: s.allocSource ?? null,
        },
      });
    }
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("missing_category returns only categoryId=null rows", async () => {
    const res = await findUncategorizedTransactions.run(ctx, { period: "this_month", review_mode: "missing_category" });
    expect(res.transactions.map((t) => t.merchantRaw)).toEqual(["A"]);
  });

  it("not_manual returns ai-categorized and uncategorized but not manual", async () => {
    const res = await findUncategorizedTransactions.run(ctx, { period: "this_month", review_mode: "not_manual" });
    const merchants = res.transactions.map((t) => t.merchantRaw).sort();
    expect(merchants).toEqual(["A", "B"]);
  });

  it("excludes soft-deleted transactions", async () => {
    const res = await findUncategorizedTransactions.run(ctx, { period: "this_month", review_mode: "missing_category" });
    expect(res.transactions.map((t) => t.merchantRaw)).not.toContain("D");
  });

  it("defaults to missing_category and this_month with limit 20", async () => {
    const res = await findUncategorizedTransactions.run(ctx, {});
    expect(res.period).toBe("this_month");
    expect(res.reviewMode).toBe("missing_category");
  });

  it("respects custom limit", async () => {
    const res = await findUncategorizedTransactions.run(ctx, { limit: 1 });
    expect(res.transactions.length).toBeLessThanOrEqual(1);
  });
});
