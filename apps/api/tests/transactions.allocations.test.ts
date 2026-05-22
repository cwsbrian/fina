import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { withWorkspaceLock } from "../src/locks/workspace.js";
import {
  applyAllocations,
  AllocationError,
} from "../src/transactions/allocations.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { wsId, userId: u.userId };
}

async function seedTx(wsId: string, amount: string): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
      amount, merchantRaw: "Test", merchantNormalized: "test",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false, source: "manual", rawData: {},
    },
  });
  // Wipe the auto-backfilled allocation so the helper writes are clean
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  return tx.id;
}

describe("applyAllocations", () => {
  it("rejects empty array → empty_allocations", async () => {
    const { wsId } = await setup("aa1@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", []),
      ),
    ).rejects.toMatchObject({ code: "empty_allocations" });
  });

  it("rejects sum < tx.amount → sum_mismatch", async () => {
    const { wsId } = await setup("aa2@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 5 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "sum_mismatch" });
  });

  it("rejects sum > tx.amount → sum_mismatch", async () => {
    const { wsId } = await setup("aa3@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 5 },
          { categoryId: null, amount: 6 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "sum_mismatch" });
  });

  it("rejects 0.005 fractional cent → invalid_allocation_amount", async () => {
    const { wsId } = await setup("aa4@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 9.995 },
          { categoryId: null, amount: 0.005 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_allocation_amount" });
  });

  it("rejects nonexistent categoryId → category_not_found", async () => {
    const { wsId } = await setup("aa5@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: "no-such-cat", amount: 10 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects archived categoryId → category_not_found", async () => {
    const { wsId } = await setup("aa6@t.co");
    const txId = await seedTx(wsId, "10");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch-aa6", archivedAt: new Date() },
    });
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: cat.id, amount: 10 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects categoryId from a DIFFERENT workspace → category_not_found", async () => {
    const { wsId } = await setup("aa-xws@t.co");
    const txId = await seedTx(wsId, "10");
    // Create a category in a SEPARATE workspace
    const otherWs = await prisma.workspace.create({ data: { name: "other-ws-aa-xws" } });
    const otherCat = await prisma.category.create({
      data: { workspaceId: otherWs.id, name: "OtherCat-aa-xws" },
    });
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: otherCat.id, amount: 10 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("happy: 1 null-cat allocation (uncategorized)", async () => {
    const { wsId } = await setup("aa7@t.co");
    const txId = await seedTx(wsId, "10");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), null, [
        { categoryId: null, amount: 10 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBeNull();
    expect(allocs[0]!.amount.toString()).toBe("10");
    expect(allocs[0]!.source).toBeNull();
  });

  it("happy: 1 categorized allocation", async () => {
    const { wsId } = await setup("aa8@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food-aa8" } });
    const txId = await seedTx(wsId, "10");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: cat.id, amount: 10 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(cat.id);
    expect(allocs[0]!.source).toBe("manual");
  });

  it("happy: 3 allocations summing to amount", async () => {
    const { wsId } = await setup("aa9@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "Groc-aa9" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "Elec-aa9" } });
    const c3 = await prisma.category.create({ data: { workspaceId: wsId, name: "Home-aa9" } });
    const txId = await seedTx(wsId, "200");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("200"), "manual", [
        { categoryId: c1.id, amount: 120 },
        { categoryId: c2.id, amount: 50 },
        { categoryId: c3.id, amount: 30 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(3);
    expect(allocs.map((a) => a.amount.toString()).sort()).toEqual(["120", "30", "50"]);
  });

  it("replaces existing allocations (delete + create) atomically", async () => {
    const { wsId } = await setup("aa10@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "A-aa10" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "B-aa10" } });
    const txId = await seedTx(wsId, "10");
    // Initial allocation
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: c1.id, amount: 10 },
      ]),
    );
    // Replace with two
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: c1.id, amount: 4 },
        { categoryId: c2.id, amount: 6 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(2);
  });

  it("rejects negative allocation even when sum matches tx amount → invalid_allocation_amount", async () => {
    const { wsId } = await setup("aa-neg@t.co");
    const txId = await seedTx(wsId, "10");
    // sum: 15 + (-5) = 10 — sum matches tx amount, but negative amount is rejected
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 15 },
          { categoryId: null, amount: -5 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_allocation_amount" });
  });

  it("accepts exactly MAX_AMOUNT (999_999_999.99) as a single allocation", async () => {
    const { wsId } = await setup("aa-max@t.co");
    const txId = await seedTx(wsId, "999999999.99");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("999999999.99"), null, [
        { categoryId: null, amount: 999999999.99 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.amount.toString()).toBe("999999999.99");
  });

  it("clears needsReclassification flag", async () => {
    const { wsId } = await setup("aa11@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "X-aa11" } });
    const txId = await seedTx(wsId, "10");
    await prisma.transaction.update({ where: { id: txId }, data: { needsReclassification: true } });
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: cat.id, amount: 10 },
      ]),
    );
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.needsReclassification).toBe(false);
  });
});
