import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { removeTransactionService, RemoveTxError } from "../src/transactions/remove.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setupEditor(email: string): Promise<{ wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { wsId, userId: u.userId };
}

async function seedManual(wsId: string, userId: string): Promise<string> {
  const r = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
  );
  return r.transaction.id;
}

async function seedPlaid(wsId: string, opts: { pending: boolean; removed?: boolean }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: `plaid_${Math.random()}`,
      amount: "20.00", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending,
      source: "plaid", rawData: {},
      removedAt: opts.removed ? new Date() : null,
    },
  });
  return tx.id;
}

describe("removeTransactionService", () => {
  it("happy manual: removed=true, removedAt set", async () => {
    const { wsId, userId } = await setupEditor("r1@t.co");
    const txId = await seedManual(wsId, userId);
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: true });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.removedAt).not.toBeNull();
  });

  it("happy plaid posted: removed=true, removedAt set", async () => {
    const { wsId } = await setupEditor("r2@t.co");
    const txId = await seedPlaid(wsId, { pending: false });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: true });
  });

  it("rejects plaid pending (fresh) with cannot_delete_pending", async () => {
    const { wsId } = await setupEditor("r3@t.co");
    const txId = await seedPlaid(wsId, { pending: true });
    await expect(
      removeTransactionService({ workspaceId: wsId }, txId),
    ).rejects.toMatchObject({ code: "cannot_delete_pending" });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.removedAt).toBeNull();
  });

  it("rejects plaid pending (already removed) with cannot_delete_pending — gate runs BEFORE idempotency", async () => {
    const { wsId } = await setupEditor("r4@t.co");
    const txId = await seedPlaid(wsId, { pending: true, removed: true });
    await expect(
      removeTransactionService({ workspaceId: wsId }, txId),
    ).rejects.toMatchObject({ code: "cannot_delete_pending" });
  });

  it("idempotent already-removed (manual): removed=false, alreadyRemoved=true", async () => {
    const { wsId, userId } = await setupEditor("r5@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("idempotent already-removed (plaid posted)", async () => {
    const { wsId } = await setupEditor("r6@t.co");
    const txId = await seedPlaid(wsId, { pending: false, removed: true });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("rejects wrong workspace with not_found", async () => {
    const { wsId, userId } = await setupEditor("r7@t.co");
    const txId = await seedManual(wsId, userId);
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await expect(
      removeTransactionService({ workspaceId: other.id }, txId),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects nonexistent tx with not_found", async () => {
    const { wsId } = await setupEditor("r8@t.co");
    await expect(
      removeTransactionService({ workspaceId: wsId }, "no-such"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("soft-delete on split tx preserves all allocations (no cascade)", async () => {
    const { wsId, userId } = await setupEditor("rd-split@t.co");
    const txId = await seedManual(wsId, userId); // creates tx + 1 alloc
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-rd" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-rd" } });
    // Replace the auto-backfilled allocation with a 2-way split
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: txId } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: txId, categoryId: c1.id, amount: "6", source: "manual" },
        { transactionId: txId, categoryId: c2.id, amount: "4", source: "manual" },
      ],
    });

    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: true });

    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(2); // allocations PRESERVED — soft-delete does NOT cascade
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(tx.removedAt).not.toBeNull();
  });

  it("clears matchedTxId on scheduled_spends that referenced the removed tx", async () => {
    const { wsId, userId } = await setupEditor("rm-sched@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-rm-sched" } });
    const r = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 50, occurredAt: "2026-05-25" },
    );
    const sched = await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "100", scheduledDate: new Date("2026-05-25T00:00:00Z"),
        matchedTxId: r.transaction.id,
      },
    });
    await removeTransactionService({ workspaceId: wsId }, r.transaction.id);
    const after = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.matchedTxId).toBeNull();
  });
});
