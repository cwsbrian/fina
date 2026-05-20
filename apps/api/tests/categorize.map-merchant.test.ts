import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { mapMerchantToCategoryService } from "../src/categorize/map-merchant.js";

describe("mapMerchantToCategoryService", () => {
  let workspaceId: string;
  let categoryId: string;
  let otherCategoryId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `mm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "MM", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "mm-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    otherCategoryId = (await prisma.category.create({ data: { workspaceId, name: "Food" } })).id;
    acctId = (await prisma.bankAccount.create({ data: { workspaceId, name: "x", type: "depository" } })).id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  async function seedTx(opts: {
    merchantRaw: string;
    merchantNormalized: string | null;
    categoryId: string | null;
    categorizationSource?: "manual" | "mapping" | "ai" | null;
  }): Promise<string> {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `tx-${Math.random()}`,
        amount: "10.00",
        merchantRaw: opts.merchantRaw,
        merchantNormalized: opts.merchantNormalized,
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    // Seed a single allocation to simulate Migration A backfill.
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId: opts.categoryId,
        amount: "10.00",
        source: opts.categorizationSource ?? null,
      },
    });
    return tx.id;
  }

  it("creates a new mapping when none exists; backfilledCount=0 if no txs", async () => {
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.mapping.merchantNormalized).toBe("starbucks");
    expect(r.mapping.categoryId).toBe(categoryId);
    expect(r.backfilledCount).toBe(0);
    const mapping = await prisma.merchantMapping.findUnique({
      where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized: "starbucks" } },
    });
    expect(mapping?.source).toBe("manual");
    expect(mapping?.confidence.toString()).toBe("1");
  });

  it("upserts an existing mapping (changes categoryId, keeps source=manual + confidence=1.00)", async () => {
    await prisma.merchantMapping.create({
      data: { workspaceId, merchantNormalized: "starbucks", categoryId: otherCategoryId, source: "ai", confidence: 0.6 },
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.mapping.categoryId).toBe(categoryId);
    const mapping = await prisma.merchantMapping.findUnique({
      where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized: "starbucks" } },
    });
    expect(mapping?.categoryId).toBe(categoryId);
    expect(mapping?.source).toBe("manual");
    expect(mapping?.confidence.toString()).toBe("1");
  });

  it("backfills null-category siblings with matching merchantNormalized", async () => {
    const txId = await seedTx({ merchantRaw: "Starbucks", merchantNormalized: "starbucks", categoryId: null });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.backfilledCount).toBe(1);
    // Allocation state assertion.
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(categoryId);
    expect(allocs[0]!.source).toBe("mapping");
  });

  it("backfills siblings whose merchantNormalized IS NULL when merchantRaw normalizes to target", async () => {
    const txId = await seedTx({
      merchantRaw: "STARBUCKS #1234 TORONTO ON",
      merchantNormalized: null,
      categoryId: null,
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "starbucks" },
    );
    expect(r.backfilledCount).toBe(1);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(tx?.merchantNormalized).toBe("starbucks");
    // Allocation state assertion.
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(categoryId);
    expect(allocs[0]!.source).toBe("mapping");
  });

  it("does NOT touch already-categorized siblings", async () => {
    const txId = await seedTx({
      merchantRaw: "Starbucks",
      merchantNormalized: "starbucks",
      categoryId: otherCategoryId,
      categorizationSource: "manual",
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.backfilledCount).toBe(0);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.categoryId).toBe(otherCategoryId);
    expect(alloc?.source).toBe("manual");
  });

  it("cross-workspace isolation — mapping in WS A does not backfill WS B", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-mm-ws" } });
    const otherAcct = await prisma.bankAccount.create({
      data: { workspaceId: otherWs.id, name: "x", type: "depository" },
    });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: otherWs.id,
        accountId: otherAcct.id,
        plaidTransactionId: "other-tx",
        amount: "10.00",
        merchantRaw: "Starbucks",
        merchantNormalized: "starbucks",
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    // Seed allocation for the other-workspace tx.
    await prisma.transactionAllocation.create({
      data: { transactionId: otherTx.id, categoryId: null, amount: "10.00", source: null },
    });
    await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    const otherAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: otherTx.id } });
    expect(otherAlloc?.categoryId).toBeNull();
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects whitespace-only input → invalid_merchant", async () => {
    await expect(
      mapMerchantToCategoryService({ workspaceId }, { categoryId, merchant: "   " }),
    ).rejects.toThrow("invalid_merchant");
  });

  it("rejects cross-workspace categoryId → category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-cat-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "X" } });
    await expect(
      mapMerchantToCategoryService(
        { workspaceId },
        { categoryId: otherCat.id, merchant: "Starbucks" },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects archived category → category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      mapMerchantToCategoryService({ workspaceId }, { categoryId, merchant: "Starbucks" }),
    ).rejects.toThrow("category_not_found");
  });

  it("back-fill SKIPS split tx (N=2 allocations) and only updates the N=1 eligible sibling", async () => {
    // tx A: N=1 null-cat allocation (eligible for back-fill).
    const txAId = await seedTx({ merchantRaw: "Starbucks", merchantNormalized: "starbucks", categoryId: null });
    // tx B: N=2 allocations (split tx, should be skipped entirely).
    const txB = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `tx-split-${Math.random()}`,
        amount: "20.00",
        merchantRaw: "Starbucks",
        merchantNormalized: "starbucks",
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    // Create 2 null-cat allocations for tx B so it passes the `every: { categoryId: null }` filter.
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: txB.id, categoryId: null, amount: "12.00", source: null },
        { transactionId: txB.id, categoryId: null, amount: "8.00", source: null },
      ],
    });

    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );

    // Only tx A should have been back-filled.
    expect(r.backfilledCount).toBe(1);

    // tx A: allocation updated.
    const allocsA = await prisma.transactionAllocation.findMany({ where: { transactionId: txAId } });
    expect(allocsA).toHaveLength(1);
    expect(allocsA[0]!.categoryId).toBe(categoryId);
    expect(allocsA[0]!.source).toBe("mapping");

    // tx B: allocations unchanged (still null, still 2).
    const allocsB = await prisma.transactionAllocation.findMany({
      where: { transactionId: txB.id },
      orderBy: { amount: "desc" },
    });
    expect(allocsB).toHaveLength(2);
    for (const a of allocsB) {
      expect(a.categoryId).toBeNull();
      expect(a.source).toBeNull();
    }
  });
});
