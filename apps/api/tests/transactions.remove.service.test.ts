import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { removeTransactionService, RemoveTxError } from "../src/transactions/remove.js";
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
});
