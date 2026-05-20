import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { categorizeTransaction } from "../src/chat/tools/categorize-transaction.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("categorizeTransaction tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `ct-${Date.now()}`, email: `ct-${Date.now()}@t.co`, name: "CT" } });
    const ws = await prisma.workspace.create({ data: { name: "ct-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(): Promise<string> {
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    const tx = await prisma.transaction.create({ data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: `t-${Math.random()}`, amount: "5.00", merchantRaw: "STARBUCKS", merchantNormalized: "starbucks", occurredAt: new Date(), rawData: {} } });
    return tx.id;
  }

  it("sets categoryId and returns backfill count", async () => {
    const id = await seedTx();
    const res = await categorizeTransaction.run(ctx, { tx_id: id, category: "Coffee" });
    expect(res.tx.allocations[0]!.categoryId).toBe(catId);
    expect(res.tx.allocations[0]!.source).toBe("manual");
    expect(typeof res.backfilledCount).toBe("number");
    // Allocations shape
    expect(res.tx.allocations).toHaveLength(1);
    expect(res.tx.allocations[0]!.categoryId).toBe(catId);
    expect(res.tx.allocations[0]!.source).toBe("manual");
    expect(res.tx.needsReclassification).toBe(false);
  });

  it("rejects cross-workspace tx_id (throws)", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const oa = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    const foreign = await prisma.transaction.create({ data: { workspaceId: other.id, accountId: oa.id, plaidTransactionId: "x", amount: "1.00", merchantRaw: "x", occurredAt: new Date(), rawData: {} } });
    await expect(categorizeTransaction.run(ctx, { tx_id: foreign.id, category: "Coffee" })).rejects.toThrow();
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("rejects unknown category (throws)", async () => {
    const id = await seedTx();
    await expect(categorizeTransaction.run(ctx, { tx_id: id, category: "Nonexistent" })).rejects.toThrow();
  });

  it("zod requires both args (validation at schema layer)", () => {
    expect(categorizeTransaction.args.safeParse({ tx_id: "" }).success).toBe(false);
    expect(categorizeTransaction.args.safeParse({ category: "" }).success).toBe(false);
    expect(categorizeTransaction.args.safeParse({ tx_id: "x", category: "y" }).success).toBe(true);
  });

  it("result includes allocations for N=1 non-split tx after categorize", async () => {
    const id = await seedTx();
    const res = await categorizeTransaction.run(ctx, { tx_id: id, category: "Coffee" });
    expect(Array.isArray(res.tx.allocations)).toBe(true);
    expect(res.tx.allocations.length).toBeGreaterThanOrEqual(1);
    const firstAlloc = res.tx.allocations[0]!;
    expect(firstAlloc.categoryId).toBe(catId);
    expect(firstAlloc.source).toBe("manual");
  });

  it("categorizes a previously-split tx and collapses to single allocation", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Split-Test", type: "depository" },
    });
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ct" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ct" } });
    const target = await prisma.category.create({ data: { workspaceId: wsId, name: "Target-ct" } });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "10", merchantRaw: "Test", merchantNormalized: "test",
        occurredAt: new Date("2026-05-19T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    // Wipe auto-backfilled alloc, install 2-way split
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: c1.id, amount: "4", source: "manual" },
        { transactionId: tx.id, categoryId: c2.id, amount: "6", source: "manual" },
      ],
    });
    // Call the chat tool
    await categorizeTransaction.run(ctx, { tx_id: tx.id, category: "Target-ct" });
    const after = await prisma.transactionAllocation.findMany({ where: { transactionId: tx.id } });
    expect(after).toHaveLength(1); // collapsed
    expect(after[0]!.categoryId).toBe(target.id);
    expect(after[0]!.source).toBe("manual");
    expect(after[0]!.amount.toString()).toBe("10");
  });
});
