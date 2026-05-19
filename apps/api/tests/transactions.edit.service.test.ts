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

describe("editTransactionService", () => {
  it("happy: updates all 5 fields, recomputes merchantNormalized, sets categorizationSource", async () => {
    const { wsId, userId } = await setupEditor("e1@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries-edit" } });

    const r = await editTransactionService(
      { workspaceId: wsId },
      txId,
      {
        amount: 12.34,
        merchantRaw: "  Walmart  ",
        occurredAt: "2026-05-18",
        categoryId: cat.id,
        note: "weekly haul",
      },
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

    await editTransactionService({ workspaceId: wsId }, txId, { amount: 99.99 });

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
    await editTransactionService({ workspaceId: wsId }, txId, { categoryId: cat.id });

    await editTransactionService({ workspaceId: wsId }, txId, { categoryId: null });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.categoryId).toBeNull();
    expect(row.categorizationSource).toBeNull();
  });

  it("clear note to null", async () => {
    const { wsId, userId } = await setupEditor("e4@t.co");
    const txId = await seedManual(wsId, userId);
    await editTransactionService({ workspaceId: wsId }, txId, { note: "x" });
    await editTransactionService({ workspaceId: wsId }, txId, { note: null });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.note).toBeNull();
  });

  it("empty input returns current tx without writing", async () => {
    const { wsId, userId } = await setupEditor("e5@t.co");
    const txId = await seedManual(wsId, userId);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const r = await editTransactionService({ workspaceId: wsId }, txId, {});
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
    await expect(
      editTransactionService({ workspaceId: wsId }, tx.id, { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("rejects already-removed tx with already_removed", async () => {
    const { wsId, userId } = await setupEditor("e7@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { amount: 1 }),
    ).rejects.toMatchObject({ code: "already_removed" });
  });

  it("rejects wrong workspace with not_found", async () => {
    const { wsId, userId } = await setupEditor("e8@t.co");
    const txId = await seedManual(wsId, userId);
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    await expect(
      editTransactionService({ workspaceId: otherWs.id }, txId, { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects nonexistent txId with not_found", async () => {
    const { wsId } = await setupEditor("e9@t.co");
    await expect(
      editTransactionService({ workspaceId: wsId }, "no-such-tx", { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects archived category with category_not_found", async () => {
    const { wsId, userId } = await setupEditor("e10@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Archived-e10", archivedAt: new Date() },
    });
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { categoryId: cat.id }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects invalid amount", async () => {
    const { wsId, userId } = await setupEditor("e11@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { amount: 0.005 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects invalid date", async () => {
    const { wsId, userId } = await setupEditor("e12@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { occurredAt: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("rejects invalid merchant (201 chars)", async () => {
    const { wsId, userId } = await setupEditor("e13@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { merchantRaw: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_merchant" });
  });

  it("rejects invalid note (1001 chars)", async () => {
    const { wsId, userId } = await setupEditor("e14@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { note: "x".repeat(1001) }),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });
});
