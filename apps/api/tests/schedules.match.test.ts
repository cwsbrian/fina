import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { matchScheduledSpends } from "../src/schedules/match.js";
import { addScheduledSpendService } from "../src/schedules/service.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ wsId: string; userId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { wsId, userId: u.userId, categoryId: cat.id };
}

async function seedTx(wsId: string, opts: {
  categoryId: string | null;
  amount: string;
  occurredAt: Date;
  removedAt?: Date;
}): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
      amount: opts.amount, merchantRaw: "Seed", merchantNormalized: "seed",
      occurredAt: opts.occurredAt,
      pending: false, source: "manual", rawData: {},
      removedAt: opts.removedAt ?? null,
    },
  });
  // Wipe auto-backfill allocation then set the one we want.
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: tx.id,
      categoryId: opts.categoryId,
      amount: opts.amount,
      source: opts.categoryId ? "manual" : null,
    },
  });
  return tx.id;
}

describe("matchScheduledSpends", () => {
  it("no schedules → no-op", async () => {
    const { wsId } = await setup("mt-noop@t.co");
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25"));
    expect(r).toEqual({ matched: 0, unresolved: 0 });
  });

  it("schedule today + matching tx → matchedTxId set", async () => {
    const { wsId, categoryId } = await setup("mt-1@t.co");
    const occ = new Date("2026-05-25T12:00:00Z");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: occ });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    expect(r.matched).toBe(1);
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBe(txId);
  });

  it("schedule today + tx different category → no match", async () => {
    const { wsId, categoryId } = await setup("mt-cat@t.co");
    const otherCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Other-mt-cat" } });
    await seedTx(wsId, { categoryId: otherCat.id, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + tx different day → no match", async () => {
    const { wsId, categoryId } = await setup("mt-day@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-24T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + matching tx soft-removed → no match", async () => {
    const { wsId, categoryId } = await setup("mt-rm@t.co");
    await seedTx(wsId, {
      categoryId, amount: "50",
      occurredAt: new Date("2026-05-25T12:00:00Z"),
      removedAt: new Date(),
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + negative-amount tx → no match (refund excluded)", async () => {
    const { wsId, categoryId } = await setup("mt-refund@t.co");
    await seedTx(wsId, { categoryId, amount: "-50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule in the future → skipped", async () => {
    const { wsId, categoryId } = await setup("mt-future@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-30T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-30",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();  // future schedule skipped
  });

  it("schedule already matched → cron leaves alone", async () => {
    const { wsId, categoryId } = await setup("mt-idem@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: txId } });
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    expect(r.matched).toBe(0);  // already matched, not re-counted
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBe(txId);  // unchanged
  });

  it("dismissed schedule → cron leaves alone", async () => {
    const { wsId, categoryId } = await setup("mt-dis@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { dismissedAt: new Date() } });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("two schedules same day+cat, one tx → first (by createdAt) matches; second stays unresolved", async () => {
    const { wsId, categoryId } = await setup("mt-1to1@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    // wait a millisecond to ensure createdAt ordering
    await new Promise((r) => setTimeout(r, 10));
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowA = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect(rowA.matchedTxId).toBe(txId);
    expect(rowB.matchedTxId).toBeNull();
  });

  it("two schedules same day+cat, two tx → each consumes a distinct tx", async () => {
    const { wsId, categoryId } = await setup("mt-2to2@t.co");
    const tx1 = await seedTx(wsId, { categoryId, amount: "30", occurredAt: new Date("2026-05-25T10:00:00Z") });
    const tx2 = await seedTx(wsId, { categoryId, amount: "70", occurredAt: new Date("2026-05-25T14:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowA = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect([rowA.matchedTxId, rowB.matchedTxId].sort()).toEqual([tx1, tx2].sort());
  });

  it("split tx (Health $60 + Grocery $40) covers one schedule in EACH category", async () => {
    const { wsId } = await setup("mt-split@t.co");
    const healthCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Health-split" } });
    const groceryCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Grocery-split" } });

    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "100", merchantRaw: "Costco", merchantNormalized: "costco",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: healthCat.id, amount: "60", source: "manual" },
        { transactionId: tx.id, categoryId: groceryCat.id, amount: "40", source: "manual" },
      ],
    });

    const h = await addScheduledSpendService({
      workspaceId: wsId, categoryId: healthCat.id, amount: 200, scheduledDate: "2026-05-25",
    });
    const g = await addScheduledSpendService({
      workspaceId: wsId, categoryId: groceryCat.id, amount: 50, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowH = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: h.schedule.id } });
    const rowG = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: g.schedule.id } });
    expect(rowH.matchedTxId).toBe(tx.id);
    expect(rowG.matchedTxId).toBe(tx.id);
  });

  it("re-match after soft-removal — schedule whose matched tx is removed re-matches to a different available tx", async () => {
    const { wsId, categoryId } = await setup("mt-rematch@t.co");
    const t1 = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    // Run 1: match schedule A to tx T1.
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    let row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    expect(row.matchedTxId).toBe(t1);

    // Soft-remove T1 via the public service path so the cleanup hook fires.
    const { removeTransactionService } = await import("../src/transactions/remove.js");
    await removeTransactionService({ workspaceId: wsId }, t1);

    // Seed a second covering tx T2 in the same day + category.
    const t2 = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T14:00:00Z") });

    // Run 2: A's matchedTxId was nulled by clearScheduleMatch; cron should re-match to T2.
    await matchScheduledSpends(wsId, new Date("2026-05-25T20:00:00Z"));
    row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    expect(row.matchedTxId).toBe(t2);
  });

  it("cross-run dedupe — second run does not match tx already claimed by prior run", async () => {
    const { wsId, categoryId } = await setup("mt-crossrun@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));  // matches A
    // Add a second schedule AFTER run 1 — and verify cron run 2 does NOT also match it to the same tx.
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T19:00:00Z"));
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect(rowB.matchedTxId).toBeNull();  // tx already claimed by A in run 1
  });
});
