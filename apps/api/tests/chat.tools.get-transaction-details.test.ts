import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { getTransactionDetails } from "../src/chat/tools/get-transaction-details.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getTransactionDetails tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let txId: string;
  let softDeletedTxId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `gt-${Date.now()}`, email: `gt-${Date.now()}@t.co`, name: "GT" } });
    const ws = await prisma.workspace.create({ data: { name: "gt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };

    const parent = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    const child = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee", parentId: parent.id } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: `t-${Date.now()}`,
        amount: "5.00",
        merchantRaw: "Starbucks 1234",
        merchantNormalized: "starbucks",
        occurredAt: new Date("2026-05-01T12:00:00Z"),
        rawData: {},
      },
    });
    txId = tx.id;
    // Seed an allocation for txId (mirrors what Migration A backfills for existing data
    // and what the service layer does for new data created via service calls)
    await prisma.transactionAllocation.create({
      data: { transactionId: txId, categoryId: child.id, amount: "5.00", source: "manual" },
    });

    const tx2 = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: `t-${Date.now()}-d`,
        amount: "9.00",
        merchantRaw: "Gone",
        occurredAt: new Date("2026-05-02T12:00:00Z"),
        rawData: {},
        removedAt: new Date(),
      },
    });
    softDeletedTxId = tx2.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns full transaction with account and parent category", async () => {
    const res = await getTransactionDetails.run(ctx, { tx_id: txId });
    expect(res.transaction.merchantRaw).toBe("Starbucks 1234");
    expect(res.transaction.amount).toBe("5");
    expect(res.transaction.account.name).toBe("Chequing");
    expect(res.transaction.category?.name).toBe("Coffee");
    expect(res.transaction.category?.parentName).toBe("Food");
    // Allocations array must be present
    expect(Array.isArray(res.transaction.allocations)).toBe(true);
    expect(res.transaction.needsReclassification).toBe(false);
  });

  it("throws transaction_not_found for unknown id", async () => {
    await expect(getTransactionDetails.run(ctx, { tx_id: "does-not-exist" })).rejects.toThrow("transaction_not_found");
  });

  it("throws transaction_not_found for cross-workspace id", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const oa = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: other.id,
        accountId: oa.id,
        plaidTransactionId: `x-${Date.now()}`,
        amount: "1.00",
        merchantRaw: "x",
        occurredAt: new Date(),
        rawData: {},
      },
    });
    await expect(getTransactionDetails.run(ctx, { tx_id: otherTx.id })).rejects.toThrow("transaction_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("returns soft-deleted transaction with removedAt", async () => {
    const res = await getTransactionDetails.run(ctx, { tx_id: softDeletedTxId });
    expect(res.transaction.removedAt).not.toBeNull();
    expect(res.transaction.merchantRaw).toBe("Gone");
  });

  it("allocations array matches categorized tx (N=1)", async () => {
    // txId was seeded with categoryId=child.id and source="manual"
    // The backfill from Migration A creates one allocation matching that
    const res = await getTransactionDetails.run(ctx, { tx_id: txId });
    expect(res.transaction.allocations).toHaveLength(1);
    expect(res.transaction.allocations[0]!.amount).toBe("5");
  });

  it("split tx (N=2) returns both allocations in result", async () => {
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-gtd-split" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-gtd-split" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Split-acct", type: "depository" } });
    const splitTx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `split-${Date.now()}`,
        amount: "100.00", merchantRaw: "Big Store",
        occurredAt: new Date("2026-05-10T12:00:00Z"), rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: splitTx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: splitTx.id, categoryId: c1.id, amount: "60.00", source: "manual" },
        { transactionId: splitTx.id, categoryId: c2.id, amount: "40.00", source: "manual" },
      ],
    });
    const res = await getTransactionDetails.run(ctx, { tx_id: splitTx.id });
    expect(res.transaction.allocations).toHaveLength(2);
    const catIds = res.transaction.allocations.map((a) => a.categoryId);
    expect(catIds).toContain(c1.id);
    expect(catIds).toContain(c2.id);
  });
});

describe("getTransactionDetails transaction_detail block", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `gtd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GTD" } });
    const ws = await prisma.workspace.create({ data: { name: "gtd-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a transaction_detail block with allocation category chips", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
    });
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Groceries", color: "#33aa55", icon: "🛒" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, amount: "42.10",
        merchantRaw: "Loblaws", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false, rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: cat.id, amount: "42.10" },
    });
    const r = await getTransactionDetails.run(ctx, { tx_id: tx.id });
    expect(r.block?.type).toBe("transaction_detail");
    if (r.block?.type !== "transaction_detail") throw new Error("wrong block");
    expect(r.block.merchant).toBe("Loblaws");
    expect(r.block.category?.name).toBe("Groceries");
    expect(r.block.allocations?.[0]!.category.icon).toBe("🛒");
  });

  it("filters uncategorized allocations out of the block but keeps them for the LLM", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq2", type: "depository", currency: "CAD" },
    });
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Dining", color: "#aa3355", icon: "🍽️" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, amount: "70.00",
        merchantRaw: "Split Place", occurredAt: new Date("2026-05-11T12:00:00Z"),
        source: "manual", pending: false, rawData: {},
      },
    });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: cat.id, amount: "30.00", source: "manual" },
        { transactionId: tx.id, categoryId: null, amount: "40.00", source: "manual" },
      ],
    });
    const r = await getTransactionDetails.run(ctx, { tx_id: tx.id });
    if (r.block?.type !== "transaction_detail") throw new Error("wrong block");
    // Block hides the uncategorized allocation.
    expect(r.block.allocations).toHaveLength(1);
    expect(r.block.allocations?.[0]!.category.name).toBe("Dining");
    expect(r.block.allocations?.[0]!.amount).toBe("30.00");
    // LLM-facing data still has both.
    expect(r.transaction.allocations).toHaveLength(2);
  });
});

describe("getTransactionDetails by merchant_query", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `gtq-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GTQ" } });
    const ws = await prisma.workspace.create({ data: { name: "gtq-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    acctId = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" } as ToolContext;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function tx(merchant: string, date: string) {
    return prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acctId, amount: "78.50", merchantRaw: merchant, occurredAt: new Date(`${date}T12:00:00Z`), source: "manual", pending: false, rawData: {} },
    });
  }

  it("returns the detail card for a single merchant match", async () => {
    await tx("Touchstone Climbing", "2026-05-11");
    const r = await getTransactionDetails.run(ctx, { merchant_query: "Touchstone" });
    expect(r.ambiguous).toBeUndefined();
    expect(r.block?.type).toBe("transaction_detail");
    expect(r.transaction?.merchantRaw).toBe("Touchstone Climbing");
  });

  it("returns ambiguous (no block) when more than one matches", async () => {
    await tx("Touchstone Climbing", "2026-05-11");
    await tx("Touchstone Climbing", "2026-04-11");
    const r = await getTransactionDetails.run(ctx, { merchant_query: "Touchstone" });
    expect(r.ambiguous).toBe(true);
    expect(r.matchCount).toBeGreaterThanOrEqual(2);
    expect(r.block).toBeUndefined();
    expect(r.transaction).toBeUndefined();
  });

  it("narrows to one with a date range", async () => {
    await tx("Touchstone Climbing", "2026-05-11");
    await tx("Touchstone Climbing", "2026-04-11");
    const r = await getTransactionDetails.run(ctx, { merchant_query: "Touchstone", start_date: "2026-05-01", end_date: "2026-05-31" });
    expect(r.block?.type).toBe("transaction_detail");
    expect(r.transaction?.occurredAt.slice(0, 7)).toBe("2026-05");
  });
});
