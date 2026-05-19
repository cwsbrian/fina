import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { editTransactionService, EditTxError } from "../src/transactions/edit.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";

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

/** Derive flags from an input object using key-presence semantics (matches spec §4.1.1). */
function flagsFrom(input: Record<string, unknown>) {
  return {
    manualOnlyFieldProvided:
      "amount" in input || "merchantRaw" in input || "occurredAt" in input || "note" in input,
    categoryIdProvided: "categoryId" in input,
    allocationsProvided: "allocations" in input,
  };
}

describe("editTransactionService", () => {
  it("happy: updates all 5 fields, recomputes merchantNormalized, sets categorizationSource", async () => {
    const { wsId, userId } = await setupEditor("e1@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries-edit" } });

    const input = {
      amount: 12.34,
      merchantRaw: "  Walmart  ",
      occurredAt: "2026-05-18",
      categoryId: cat.id,
      note: "weekly haul",
    };
    const r = await editTransactionService(
      { workspaceId: wsId },
      txId,
      input,
      flagsFrom(input),
    );

    expect(r.transaction.amount).toBe("12.34");
    expect(r.transaction.merchantRaw).toBe("Walmart");
    expect(r.transaction.merchantNormalized).toBe("walmart");
    expect(r.transaction.occurredAt.slice(0, 10)).toBe("2026-05-18");
    expect(r.transaction.categoryId).toBe(cat.id);
    expect(r.transaction.note).toBe("weekly haul");

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.categorizationSource).toBe("manual");
  });

  it("partial update: only amount changes; other fields untouched", async () => {
    const { wsId, userId } = await setupEditor("e2@t.co");
    const txId = await seedManual(wsId, userId);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });

    const input = { amount: 99.99 };
    await editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input));

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.amount.toString()).toBe("99.99");
    expect(after.merchantRaw).toBe(before.merchantRaw);
    expect(after.occurredAt.toISOString()).toBe(before.occurredAt.toISOString());
    expect(after.note).toBe(before.note);
    expect(after.categoryId).toBe(before.categoryId);
  });

  it("clear categoryId to null sets categorizationSource to null", async () => {
    const { wsId, userId } = await setupEditor("e3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food-e3" } });
    const txId = await seedManual(wsId, userId);
    const setInput = { categoryId: cat.id };
    await editTransactionService({ workspaceId: wsId }, txId, setInput, flagsFrom(setInput));

    const clearInput = { categoryId: null };
    await editTransactionService({ workspaceId: wsId }, txId, clearInput, flagsFrom(clearInput));
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.categoryId).toBeNull();
    expect(row.categorizationSource).toBeNull();
  });

  it("clear note to null", async () => {
    const { wsId, userId } = await setupEditor("e4@t.co");
    const txId = await seedManual(wsId, userId);
    const setInput = { note: "x" };
    await editTransactionService({ workspaceId: wsId }, txId, setInput, flagsFrom(setInput));
    const clearInput = { note: null };
    await editTransactionService({ workspaceId: wsId }, txId, clearInput, flagsFrom(clearInput));
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.note).toBeNull();
  });

  it("empty input returns current tx without writing", async () => {
    const { wsId, userId } = await setupEditor("e5@t.co");
    const txId = await seedManual(wsId, userId);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const input = {};
    const r = await editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input));
    expect(r.transaction.id).toBe(txId);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    // updatedAt should NOT bump because no update was issued
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("rejects plaid tx with not_editable", async () => {
    const { wsId } = await setupEditor("e6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: "plaid_xyz",
        amount: "5.00", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
        occurredAt: new Date("2026-05-19T12:00:00Z"),
        pending: false, source: "plaid", rawData: {},
      },
    });
    const input = { amount: 1 };
    await expect(
      editTransactionService({ workspaceId: wsId }, tx.id, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("rejects already-removed tx with already_removed", async () => {
    const { wsId, userId } = await setupEditor("e7@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    const input = { amount: 1 };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "already_removed" });
  });

  it("rejects wrong workspace with not_found", async () => {
    const { wsId, userId } = await setupEditor("e8@t.co");
    const txId = await seedManual(wsId, userId);
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const input = { amount: 1 };
    await expect(
      editTransactionService({ workspaceId: otherWs.id }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects nonexistent txId with not_found", async () => {
    const { wsId } = await setupEditor("e9@t.co");
    const input = { amount: 1 };
    await expect(
      editTransactionService({ workspaceId: wsId }, "no-such-tx", input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects archived category with category_not_found", async () => {
    const { wsId, userId } = await setupEditor("e10@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Archived-e10", archivedAt: new Date() },
    });
    const input = { categoryId: cat.id };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects invalid amount", async () => {
    const { wsId, userId } = await setupEditor("e11@t.co");
    const txId = await seedManual(wsId, userId);
    const input = { amount: 0.005 };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects invalid date", async () => {
    const { wsId, userId } = await setupEditor("e12@t.co");
    const txId = await seedManual(wsId, userId);
    const input = { occurredAt: "2026-13-01" };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("rejects invalid merchant (201 chars)", async () => {
    const { wsId, userId } = await setupEditor("e13@t.co");
    const txId = await seedManual(wsId, userId);
    const input = { merchantRaw: "x".repeat(201) };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "invalid_merchant" });
  });

  it("rejects invalid note (1001 chars)", async () => {
    const { wsId, userId } = await setupEditor("e14@t.co");
    const txId = await seedManual(wsId, userId);
    const input = { note: "x".repeat(1001) };
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, input, flagsFrom(input)),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });

  // ── NEW TESTS (Task 5) ──────────────────────────────────────────────────────

  it("happy: PATCH with allocations array (split) → DB has multiple alloc rows", async () => {
    const { wsId, userId } = await setupEditor("ea-split@t.co");
    const txId = await seedManual(wsId, userId);
    // Seed tx amount = 10 from seedManual; split into 4+6.
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-split" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-split" } });
    const r = await editTransactionService(
      { workspaceId: wsId }, txId,
      { allocations: [{ categoryId: c1.id, amount: 4 }, { categoryId: c2.id, amount: 6 }] },
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    );
    expect(r.transaction.allocations).toHaveLength(2);
  });

  it("happy: PATCH with categoryId shortcut writes single allocation = tx.amount", async () => {
    const { wsId, userId } = await setupEditor("ea-shortcut@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-shortcut" } });
    const r = await editTransactionService(
      { workspaceId: wsId }, txId,
      { categoryId: cat.id },
      { categoryIdProvided: true, manualOnlyFieldProvided: false, allocationsProvided: false },
    );
    expect(r.transaction.allocations).toHaveLength(1);
    expect(r.transaction.allocations[0]!.categoryId).toBe(cat.id);
    expect(r.transaction.allocations[0]!.source).toBe("manual");
  });

  it("conflicting_body: both categoryId and allocations provided", async () => {
    const { wsId, userId } = await setupEditor("ea-conflict@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-conf" } });
    await expect(
      editTransactionService(
        { workspaceId: wsId }, txId,
        { categoryId: cat.id, allocations: [{ categoryId: cat.id, amount: 10 }] },
        { categoryIdProvided: true, allocationsProvided: true, manualOnlyFieldProvided: false },
      ),
    ).rejects.toMatchObject({ code: "conflicting_body" });
  });

  it("empty_allocations: PATCH allocations: []", async () => {
    const { wsId, userId } = await setupEditor("ea-empty@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService(
        { workspaceId: wsId }, txId,
        { allocations: [] },
        { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
      ),
    ).rejects.toMatchObject({ code: "empty_allocations" });
  });

  it("sum_mismatch: allocations don't sum to tx.amount", async () => {
    const { wsId, userId } = await setupEditor("ea-summismatch@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-sum" } });
    await expect(
      editTransactionService(
        { workspaceId: wsId }, txId,
        { allocations: [{ categoryId: cat.id, amount: 5 }] },  // tx.amount = 10
        { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
      ),
    ).rejects.toMatchObject({ code: "sum_mismatch" });
  });

  it("sum tracks new amount when PATCH also changes amount", async () => {
    const { wsId, userId } = await setupEditor("ea-newamount@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-newamt" } });
    const r = await editTransactionService(
      { workspaceId: wsId }, txId,
      { amount: 25, allocations: [{ categoryId: cat.id, amount: 25 }] },
      { allocationsProvided: true, manualOnlyFieldProvided: true, categoryIdProvided: false },
    );
    expect(r.transaction.amount).toBe("25");
    expect(r.transaction.allocations[0]!.amount).toBe("25");
  });

  it("cannot_split_pending: PATCH allocations on pending Plaid tx", async () => {
    const { wsId } = await setupEditor("ea-pending@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_pending",
        amount: "10", merchantRaw: "X", merchantNormalized: "x",
        occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
      },
    });
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-pending" } });
    await expect(
      editTransactionService(
        { workspaceId: wsId }, tx.id,
        { allocations: [{ categoryId: cat.id, amount: 10 }] },
        { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
      ),
    ).rejects.toMatchObject({ code: "cannot_split_pending" });
  });

  it("Plaid posted tx accepts allocations-only PATCH", async () => {
    const { wsId } = await setupEditor("ea-plaidposted@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted",
        amount: "10", merchantRaw: "X", merchantNormalized: "x",
        occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
      },
    });
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-posted" } });
    const r = await editTransactionService(
      { workspaceId: wsId }, tx.id,
      { allocations: [{ categoryId: cat.id, amount: 10 }] },
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    );
    expect(r.transaction.allocations).toHaveLength(1);
  });

  it("Plaid posted tx rejects amount edit (per-field rule)", async () => {
    const { wsId } = await setupEditor("ea-plaidamt@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted2",
        amount: "10", merchantRaw: "X", merchantNormalized: "x",
        occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
      },
    });
    await expect(
      editTransactionService(
        { workspaceId: wsId }, tx.id,
        { amount: 20 },
        { manualOnlyFieldProvided: true, allocationsProvided: false, categoryIdProvided: false },
      ),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("Plaid posted tx rejects note:null edit (per-field key-presence rule)", async () => {
    const { wsId } = await setupEditor("ea-plaidnote@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted3",
        amount: "10", merchantRaw: "X", merchantNormalized: "x",
        occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
      },
    });
    await expect(
      editTransactionService(
        { workspaceId: wsId }, tx.id,
        { note: null },
        { manualOnlyFieldProvided: true, allocationsProvided: false, categoryIdProvided: false },
      ),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("PATCH allocations clears needsReclassification flag", async () => {
    const { wsId, userId } = await setupEditor("ea-needsrc@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({
      where: { id: txId }, data: { needsReclassification: true },
    });
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-needsrc" } });
    await editTransactionService(
      { workspaceId: wsId }, txId,
      { allocations: [{ categoryId: cat.id, amount: 10 }] },
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    );
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.needsReclassification).toBe(false);
  });
});
