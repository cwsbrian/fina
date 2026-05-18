import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import {
  createManualTransactionService,
  CreateManualTxError,
} from "../src/transactions/create-manual.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
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

async function setupEditor(email: string): Promise<{
  cookie: string; wsId: string; userId: string;
}> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("createManualTransactionService", () => {
  it("auto-creates a Cash manual account on first call", async () => {
    const { wsId, userId } = await setupEditor("mt1@t.co");
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Starbucks", amount: 6.75, occurredAt: "2026-05-17" },
    );
    expect(result.transaction.source).toBe("manual");
    expect(result.transaction.merchantNormalized).toBe("starbucks");
    expect(result.transaction.currency).toBe("CAD");
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe("Cash");
    expect(accounts[0]!.type).toBe("depository");
    expect(accounts[0]!.currency).toBe("CAD");
  });

  it("reuses the existing manual account on second call", async () => {
    const { wsId, userId } = await setupEditor("mt2@t.co");
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" },
    );
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" },
    );
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
    expect(txs).toHaveLength(2);
    expect(new Set(txs.map((t) => t.accountId))).toEqual(new Set([accounts[0]!.id]));
  });

  it("accepts explicit accountId when plaidItemId IS NULL", async () => {
    const { wsId, userId } = await setupEditor("mt3@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Wallet", type: "depository", currency: "CAD" },
    });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
    );
    expect(result.transaction.accountId).toBe(acct.id);
  });

  it("rejects accountId from another workspace", async () => {
    const a = await setupEditor("mta@t.co");
    const b = await setupEditor("mtb@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: b.wsId, name: "Other", type: "depository", currency: "CAD" },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: a.wsId, userId: a.userId },
        { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
      ),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rejects accountId that has plaidItemId set", async () => {
    const { wsId, userId } = await setupEditor("mtp@t.co");
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        itemId: `pi-${Date.now()}`,
        accessTokenCiphertext: Buffer.from([0]),
        accessTokenIv: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        institutionId: "ins-1",
        institutionName: "RBC",
      },
    });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, plaidItemId: item.id, plaidAccountId: "pa-1", name: "Plaid Chequing", type: "depository", currency: "CAD" },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
      ),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rejects amount <= 0", async () => {
    const { wsId, userId } = await setupEditor("mtam@t.co");
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 0, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: -1, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 1_000_000_000, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects bad occurredAt strings", async () => {
    const { wsId, userId } = await setupEditor("mtdt@t.co");
    for (const bad of ["2026-13-01", "2026-05-32", "not-a-date", "", "2026-5-1"]) {
      await expect(
        createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 1, occurredAt: bad }),
      ).rejects.toMatchObject({ code: "invalid_date" });
    }
  });

  it("defaults occurredAt to today (UTC noon) when omitted", async () => {
    const { wsId, userId } = await setupEditor("mtdef@t.co");
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1 },
    );
    const occurred = new Date(result.transaction.occurredAt);
    expect(occurred.getUTCHours()).toBe(12);
    const diffMs = Math.abs(occurred.getTime() - Date.now());
    expect(diffMs).toBeLessThan(48 * 60 * 60 * 1000);
  });

  it("rejects archived category", async () => {
    const { wsId, userId } = await setupEditor("mtcat@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Archived", archivedAt: new Date() },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17", categoryId: cat.id },
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects note > 1000 chars", async () => {
    const { wsId, userId } = await setupEditor("mtnt@t.co");
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17", note: "x".repeat(1001) },
      ),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });

  it("Transaction.currency inherits Workspace.currency", async () => {
    const { wsId, userId } = await setupEditor("mtcur@t.co");
    await prisma.workspace.update({ where: { id: wsId }, data: { currency: "USD" } });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17" },
    );
    expect(result.transaction.currency).toBe("USD");
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(acct.currency).toBe("USD");
  });

  it("does NOT reuse a ghost ex-Plaid account (plaidItemId=null + plaidAccountId set + archived)", async () => {
    const { wsId, userId } = await setupEditor("mtghost@t.co");
    await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidItemId: null,
        plaidAccountId: `pa-ghost-${Date.now()}`,
        name: "Old Plaid Chequing",
        type: "depository",
        currency: "CAD",
        archivedAt: new Date(),
      },
    });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17" },
    );
    const cashAccts = await prisma.bankAccount.findMany({
      where: { workspaceId: wsId, plaidAccountId: null, archivedAt: null },
    });
    expect(cashAccts).toHaveLength(1);
    expect(cashAccts[0]!.name).toBe("Cash");
    expect(result.transaction.accountId).toBe(cashAccts[0]!.id);
  });

  it("race: two concurrent first-time calls produce exactly one Cash account", async () => {
    const { wsId, userId } = await setupEditor("mtrace@t.co");
    const [r1, r2] = await Promise.all([
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" }),
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" }),
    ]);
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    expect(r1.transaction.accountId).toBe(accounts[0]!.id);
    expect(r2.transaction.accountId).toBe(accounts[0]!.id);
  });
});

async function makeFree(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true },
  });
}

describe("POST /workspaces/:id/transactions/manual", () => {
  it("201 happy path for Free-tier user (no Pro gate)", async () => {
    const { cookie, wsId, userId } = await setupEditor("mtroute@t.co");
    await makeFree(userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { merchantRaw: "Tim Hortons", amount: 4.5, occurredAt: "2026-05-17" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { transaction: { source: string; merchantNormalized: string } };
    expect(body.transaction.source).toBe("manual");
    expect(body.transaction.merchantNormalized).toBe("tim hortons");
  });

  it("400 workspace_mismatch when X-Workspace-Id differs from path", async () => {
    const a = await setupEditor("mtwm1@t.co");
    const b = await setupEditor("mtwm2@t.co");
    await prisma.membership.create({
      data: { userId: a.userId, workspaceId: b.wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.wsId}/transactions/manual`,
      headers: { cookie: a.cookie, "x-workspace-id": b.wsId, "content-type": "application/json" },
      payload: { merchantRaw: "X", amount: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "workspace_mismatch" });
  });

  it("400 invalid_body when required fields missing", async () => {
    const { cookie, wsId } = await setupEditor("mtbad@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { amount: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("403 insufficient_role for viewer", async () => {
    const owner = await setupEditor("mtown@t.co");
    const viewer = await setupEditor("mtvw@t.co");
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: owner.wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.wsId}/transactions/manual`,
      headers: { cookie: viewer.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: { merchantRaw: "X", amount: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient_role" });
  });
});
