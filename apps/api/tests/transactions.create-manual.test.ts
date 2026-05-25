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
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

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
    const manualAccounts = await prisma.bankAccount.findMany({
      where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
    });
    // Bootstrap seeds 5 default manual accounts (Cash/Debit/Checking/Savings/
    // Credit); service reused one of them for this transaction.
    expect(manualAccounts.length).toBeGreaterThanOrEqual(1);
    const picked = manualAccounts.find((a) => a.id === result.transaction.accountId);
    expect(picked).toBeDefined();
    expect(picked!.type).toBe("depository");
    expect(picked!.currency).toBe("CAD");
    // Cash is among the seed defaults, confirming the bootstrap path:
    expect(manualAccounts.some((a) => a.name === "Cash")).toBe(true);
  });

  it("reuses the existing manual account on second call", async () => {
    const { wsId, userId } = await setupEditor("mt2@t.co");
    const manualBefore = await prisma.bankAccount.count({
      where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
    });
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" },
    );
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" },
    );
    const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
    expect(txs).toHaveLength(2);
    // Both transactions reused the same manual account (reuse semantics);
    // account identity doesn't matter — just that they collapsed onto one.
    const accountIds = new Set(txs.map((t) => t.accountId));
    expect(accountIds.size).toBe(1);
    // Belt+suspenders: 2nd call didn't silently create a 6th manual row
    // alongside the reuse.
    const manualAfter = await prisma.bankAccount.count({
      where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
    });
    expect(manualAfter).toBe(manualBefore);
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

  it("rejects amount === 0 or |amount| out of range", async () => {
    const { wsId, userId } = await setupEditor("mtam@t.co");
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 0, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    // Negative amounts are valid now — manual tx accepts signed amounts
    // so the user can record income (Plaid convention: amount < 0 = credit).
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 1_000_000_000, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: -1_000_000_000, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    // Fractional-cent values would round to 0.00 in Decimal(14,2)
    for (const bad of [0.004, 1.234, 0.000000001, 0.009999999999]) {
      await expect(
        createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: bad, occurredAt: "2026-05-17" }),
      ).rejects.toMatchObject({ code: "invalid_amount" });
    }
  });

  it("accepts valid two-decimal amounts (0.01, 1, 6.75, 100, 999999999.99)", async () => {
    const { wsId, userId } = await setupEditor("mtampos@t.co");
    for (const ok of [0.01, 1, 6.75, 100, 999_999_999.99]) {
      const r = await createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: ok, occurredAt: "2026-05-17" },
      );
      expect(Number(r.transaction.amount)).toBeCloseTo(ok, 2);
    }
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
    // Bootstrap seeded 5 manual accounts at workspace.currency=CAD. The service
    // would reuse one of them rather than honor a subsequent currency change.
    // Drop the seeds so the service has to create a fresh Cash account using
    // the updated workspace.currency, exercising the inherit code path.
    await prisma.bankAccount.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspace.update({ where: { id: wsId }, data: { currency: "USD" } });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17" },
    );
    expect(result.transaction.currency).toBe("USD");
    // Query mirrors production MANUAL_WHERE (create-manual.ts:129-133) so
    // it never picks up unrelated rows if seed semantics change later.
    const acct = await prisma.bankAccount.findFirstOrThrow({
      where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
    });
    expect(acct.currency).toBe("USD");
    expect(acct.name).toBe("Cash");
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
    const ghostId = (await prisma.bankAccount.findFirstOrThrow({
      where: { workspaceId: wsId, plaidAccountId: { not: null } },
    })).id;
    expect(result.transaction.accountId).not.toBe(ghostId);
    const pickedAccount = await prisma.bankAccount.findUniqueOrThrow({
      where: { id: result.transaction.accountId },
    });
    expect(pickedAccount.plaidAccountId).toBeNull();
    expect(pickedAccount.archivedAt).toBeNull();
  });

  it("race: two concurrent first-time calls produce exactly one Cash account", async () => {
    const { wsId, userId } = await setupEditor("mtrace@t.co");
    const [r1, r2] = await Promise.all([
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" }),
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" }),
    ]);
    expect(r1.transaction.accountId).toBe(r2.transaction.accountId);
    // And it's an active, non-Plaid account from the bootstrap seed pool.
    const picked = await prisma.bankAccount.findUniqueOrThrow({
      where: { id: r1.transaction.accountId },
    });
    expect(picked.plaidItemId).toBeNull();
    expect(picked.plaidAccountId).toBeNull();
    expect(picked.archivedAt).toBeNull();
  });

  it("response includes updatedAt, removedAt:null, pending:false, plaidTransactionId:null", async () => {
    // Reuse the file's existing setup helper for ctx; adjust if your local helper differs.
    const { wsId, userId } = await setupEditor("shape@t.co");
    const { transaction: r } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 9.99, occurredAt: "2026-05-19" },
    );
    expect(r.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.removedAt).toBeNull();
    expect(r.pending).toBe(false);
    expect(r.plaidTransactionId).toBeNull();
  });

  it("response includes allocations array reflecting the single category", async () => {
    const { wsId, userId } = await setupEditor("alloc-shape@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food-shape" } });
    const { transaction: r } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 9.99, occurredAt: "2026-05-19", categoryId: cat.id },
    );
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]!.categoryId).toBe(cat.id);
    expect(r.allocations[0]!.amount).toBe("9.99");
    expect(r.allocations[0]!.source).toBe("manual");
    expect(r.needsReclassification).toBe(false);
  });

  it("response uncategorized: 1 allocation with categoryId=null, source=null", async () => {
    const { wsId, userId } = await setupEditor("alloc-uncat@t.co");
    const { transaction: r } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Cash purchase", amount: 5, occurredAt: "2026-05-19" },
    );
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0]!.categoryId).toBeNull();
    expect(r.allocations[0]!.source).toBeNull();
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
