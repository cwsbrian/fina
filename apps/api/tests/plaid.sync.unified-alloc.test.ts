import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { upsertAdded, upsertModified } from "../src/plaid/sync.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
  });
  return { wsId, userId: u.userId, acctId: acct.id };
}

async function seedPlaidTx(wsId: string, acctId: string, opts: {
  amount: string; pending?: boolean; allocations: Array<{ categoryId: string | null; amount: string; source: "manual" | "mapping" | "ai" | null }>;
}): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acctId,
      plaidTransactionId: `p_${Math.random()}`,
      amount: opts.amount,
      merchantRaw: "Costco", merchantNormalized: "costco",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending ?? false,
      source: "plaid", rawData: {},
    },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: opts.allocations.map((a) => ({
      transactionId: tx.id,
      categoryId: a.categoryId,
      amount: a.amount,
      source: a.source,
    })),
  });
  return tx.id;
}

describe("Plaid sync — unified allocations edge cases", () => {
  it("upsertModified: N=1, amount changed → tx.amount + allocation.amount both update", async () => {
    const { wsId, acctId } = await setup("ps1@t.co");
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100", allocations: [{ categoryId: null, amount: "100", source: null }],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 150, date: "2026-05-19",
        pending: false,
        merchant_name: "Costco", name: "Costco",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.amount.toString()).toBe("150");
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]!.amount.toString()).toBe("150");
    expect(after.needsReclassification).toBe(false);
  });

  it("upsertModified: N=1, only postedAt changes → no allocation update", async () => {
    const { wsId, acctId } = await setup("ps2@t.co");
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "50", allocations: [{ categoryId: null, amount: "50", source: null }],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const beforeAllocId = (await prisma.transactionAllocation.findFirstOrThrow({
      where: { transactionId: txId }, select: { id: true, updatedAt: true },
    }));
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 50, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
        datetime: "2026-05-20T12:00:00Z",
      } as any, wsId),
    );
    const afterAllocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(afterAllocs).toHaveLength(1);
    expect(afterAllocs[0]!.id).toBe(beforeAllocId.id);
  });

  it("upsertModified: N=2, amount changed → allocations invalidated + needsReclassification true", async () => {
    const { wsId, acctId } = await setup("ps3@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps3" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps3" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "200",
      allocations: [
        { categoryId: c1.id, amount: "120", source: "manual" },
        { categoryId: c2.id, amount: "80", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 215, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.amount.toString()).toBe("215");
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]!.categoryId).toBeNull();
    expect(after.allocations[0]!.source).toBeNull();
    expect(after.allocations[0]!.amount.toString()).toBe("215");
    expect(after.needsReclassification).toBe(true);
  });

  it("upsertModified: N=2, merchant changed but amount same → allocations invalidated (per spec)", async () => {
    const { wsId, acctId } = await setup("ps4@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps4" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps4" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100",
      allocations: [
        { categoryId: c1.id, amount: "60", source: "manual" },
        { categoryId: c2.id, amount: "40", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 100, date: "2026-05-19",
        pending: false, merchant_name: "Costco Wholesale", name: "Costco Wholesale",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.merchantRaw).toBe("Costco Wholesale");
    expect(after.allocations).toHaveLength(1);
    expect(after.needsReclassification).toBe(true);
  });

  it("upsertModified: N=2, only postedAt changed → allocations preserved", async () => {
    const { wsId, acctId } = await setup("ps5@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps5" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps5" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100",
      allocations: [
        { categoryId: c1.id, amount: "60", source: "manual" },
        { categoryId: c2.id, amount: "40", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 100, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
        datetime: "2026-05-22T12:00:00Z",
      } as any, wsId),
    );
    const after = await prisma.transactionAllocation.findMany({
      where: { transactionId: txId }, orderBy: { amount: "desc" },
    });
    expect(after).toHaveLength(2);
    expect(after[0]!.categoryId).toBe(c1.id);
    expect(after[1]!.categoryId).toBe(c2.id);
  });

  it.todo("upsertAdded fresh insert creates 1 null-cat allocation (covered by existing sync tests once they assert allocation presence)");

  it("upsertAdded existing-path replay with mutated amount updates allocation (N=1)", async () => {
    const { wsId } = await setup("ps-replay@t.co");
    const plaidAccountId = `acct-replay-${Date.now()}`;
    // Create a PlaidItem (required FK for BankAccount.plaidItemId).
    const plaidItem = await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        accessTokenCiphertext: Buffer.alloc(32),
        accessTokenIv: Buffer.alloc(12),
        itemId: `item-${Date.now()}`,
        institutionId: "ins_test",
        institutionName: "Test Bank",
      },
    });
    // Create a bankAccount that accountIdForPlaidAccount can find.
    const acct = await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        name: "Replay Checking",
        type: "depository",
        plaidItemId: plaidItem.id,
        plaidAccountId,
      },
    });
    const txId = await seedPlaidTx(wsId, acct.id, {
      amount: "10", allocations: [{ categoryId: null, amount: "10", source: null }],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    // Simulate replay with different amount — call upsertAdded directly.
    await prisma.$transaction(async (db) =>
      upsertAdded(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: plaidAccountId,
        amount: 15,
        date: "2026-05-19",
        pending: false,
        merchant_name: "Costco",
        name: "Costco",
      } as any, plaidItem.id, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.amount.toString()).toBe("15");
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]!.amount.toString()).toBe("15");
  });
});
