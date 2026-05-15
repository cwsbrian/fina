import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { applyManualCategorize } from "../src/categorize/manual-categorize.js";

describe("applyManualCategorize", () => {
  let wsId: string;
  let categoryId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `mc-${Date.now()}`, email: `mc-${Date.now()}@t.co`, name: "MC" } });
    const ws = await prisma.workspace.create({ data: { name: "ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    categoryId = cat.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(merchantRaw: string, merchantNormalized?: string | null): Promise<string> {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Checking", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: `t-${Math.random()}`,
        amount: "5.00", merchantRaw, merchantNormalized: merchantNormalized ?? null,
        occurredAt: new Date(), rawData: {},
      },
    });
    return tx.id;
  }

  it("sets target tx categoryId + source manual, upserts mapping, backfills siblings", async () => {
    const a = await seedTx("STARBUCKS #123", "starbucks");
    const b = await seedTx("STARBUCKS #456", "starbucks");
    const c = await seedTx("STARBUCKS #789", "starbucks");

    const res = await applyManualCategorize({ workspaceId: wsId, txId: a, categoryName: "Coffee" });

    expect(res.tx.id).toBe(a);
    expect(res.tx.categoryId).toBe(categoryId);
    expect(res.tx.categorizationSource).toBe("manual");
    expect(res.backfilledCount).toBe(2);

    const mapping = await prisma.merchantMapping.findUniqueOrThrow({
      where: { workspaceId_merchantNormalized: { workspaceId: wsId, merchantNormalized: "starbucks" } },
    });
    expect(mapping.source).toBe("manual");
    expect(mapping.confidence.toString()).toBe("1");

    const bRow = await prisma.transaction.findUniqueOrThrow({ where: { id: b } });
    expect(bRow.categoryId).toBe(categoryId);
    expect(bRow.categorizationSource).toBe("mapping");
    const cRow = await prisma.transaction.findUniqueOrThrow({ where: { id: c } });
    expect(cRow.categorizationSource).toBe("mapping");
  });

  it("preserves prior manual decisions on back-fill", async () => {
    const a = await seedTx("STARBUCKS #1", "starbucks");
    const b = await seedTx("STARBUCKS #2", "starbucks");
    const other = await prisma.category.create({ data: { workspaceId: wsId, name: "Other" } });
    await prisma.transaction.update({
      where: { id: b },
      data: { categoryId: other.id, categorizationSource: "manual" },
    });

    await applyManualCategorize({ workspaceId: wsId, txId: a, categoryName: "Coffee" });

    const bRow = await prisma.transaction.findUniqueOrThrow({ where: { id: b } });
    expect(bRow.categoryId).toBe(other.id);
    expect(bRow.categorizationSource).toBe("manual");
  });

  it("rejects cross-workspace txId", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({
      data: { workspaceId: otherWs.id, name: "x", type: "depository" },
    });
    const foreign = await prisma.transaction.create({
      data: {
        workspaceId: otherWs.id, accountId: otherAcct.id, plaidTransactionId: "tf",
        amount: "1.00", merchantRaw: "x", occurredAt: new Date(), rawData: {},
      },
    });
    await expect(
      applyManualCategorize({ workspaceId: wsId, txId: foreign.id, categoryName: "Coffee" }),
    ).rejects.toThrow(/tx_not_found/);
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects archived category", async () => {
    const a = await seedTx("STARBUCKS #1", "starbucks");
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      applyManualCategorize({ workspaceId: wsId, txId: a, categoryName: "Coffee" }),
    ).rejects.toThrow(/category_not_found/);
  });

  it("case-insensitive category match", async () => {
    const a = await seedTx("STARBUCKS", "starbucks");
    const res = await applyManualCategorize({ workspaceId: wsId, txId: a, categoryName: "coffee" });
    expect(res.tx.categoryId).toBe(categoryId);
  });
});
