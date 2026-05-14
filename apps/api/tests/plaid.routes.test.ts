import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

// vi.mock(path, factory) is hoisted above all imports — pass the factory
// through vi.hoisted() so it's loaded in the same hoisted scope.
const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

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

async function connectAItem(app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never, owner: { cookie: string }, wsId: string, suffix = ""): Promise<string> {
  plaidMock.itemPublicTokenExchange.push({
    data: { access_token: `access${suffix}`, item_id: `item${suffix}`, request_id: "req" },
  });
  plaidMock.accountsGet.push({
    data: {
      accounts: [
        { account_id: `acct${suffix}`, name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
      ],
      item: { item_id: `item${suffix}`, institution_id: "ins_1" },
      request_id: "req",
    },
  });
  plaidMock.transactionsSync.push({ data: { added: [], modified: [], removed: [], next_cursor: "c0", has_more: false } });
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/plaid/exchange`,
    headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ publicToken: `p${suffix}`, institutionId: "ins_1", institutionName: `Test Bank${suffix}` }),
  });
  return res.json().plaidItemId as string;
}

// File-level lifecycle: every test in this file shares the same fresh DB +
// mock state. We disconnect Prisma exactly once after the whole file.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

describe("GET /workspaces/:id/plaid-items", () => {
  it("members can list — returns institutionName, status, accountCount", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await connectAItem(app, owner, wsId);

    // Add a viewer member.
    const viewer = await signUpAndGetCookie(app, { email: "v@x.com", name: "V" });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/plaid-items`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().plaidItems;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      institutionName: "Test Bank",
      status: "active",
      accountCount: 1,
    });
    expect(typeof list[0].id).toBe("string");
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "x@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/plaid-items`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wm@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/plaid-items`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid/link-token", () => {
  it("passes webhook URL to linkTokenCreate when PLAID_WEBHOOK_URL is set", async () => {
    const envWithUrl = { ...env, PLAID_WEBHOOK_URL: "https://example.com/plaid/webhook" };
    const app = await buildApp(envWithUrl);
    const u = await signUpAndGetCookie(app, { email: "wh-link@x.com", name: "WH" });
    const wsId = await getOwnerWorkspaceId(u.userId);

    plaidMock.linkTokenCreate.push({ data: { link_token: "link-tok", expiration: "2099-01-01" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    // Task 2.1 added linkTokenCreateCalls capture to plaid-mock.ts.
    expect(plaidMock.linkTokenCreateCalls[0][0]).toMatchObject({
      webhook: "https://example.com/plaid/webhook",
    });
    await app.close();
  });

  it("omits webhook field when PLAID_WEBHOOK_URL is not set", async () => {
    const app = await buildApp(env); // env without PLAID_WEBHOOK_URL
    const u = await signUpAndGetCookie(app, { email: "wh-omit@x.com", name: "WO" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenCreate.push({ data: { link_token: "t", expiration: "2099-01-01" } });

    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });

    expect(plaidMock.linkTokenCreateCalls[0][0]).not.toHaveProperty("webhook");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid-items/:itemId/sync", () => {
  it("owner Pro user — happy path returns counts", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "t99", account_id: "acct", amount: 1, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "X", name: "X", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    // Sync awaits categorize — provide a mock Gemini response so the route unblocks.
    geminiMock.generateContent.push({ results: [] });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 1, modified: 0, removed: 0 });
    await app.close();
  });

  it("403 for viewer member (Pro-mutating routes are owner-only)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    const viewer = await signUpAndGetCookie(app, { email: "v2@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "wms@x.com", name: "O" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsA);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });

  it("402 upgrade_required when the owner's trial has expired (free tier)", async () => {
    // Sync IS Pro-gated (unlike disconnect — see DELETE describe). A user
    // whose trial expired can read existing transactions but can't pull
    // new ones until they upgrade.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "fr@x.com", name: "F" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("manual sync awaits categorize — response reflects categoryId set", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ms-cat@x.com", name: "MS" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    const syncPlaidTxId = "tx_msync";
    plaidMock.transactionsSync.push({
      data: {
        added: [{ transaction_id: syncPlaidTxId, account_id: "acct", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Loblaws", name: "Loblaws", iso_currency_code: "CAD" }],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });

    let geminiResolve!: (r: { results: Array<{ tx_id: string; category: string }> }) => void;
    geminiMock.generateContent.push(
      new Promise<{ results: Array<{ tx_id: string; category: string }> }>((r) => { geminiResolve = r; }),
    );

    const resPromise = app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    // Poll until the tx is created in DB (sync completed but categorize is still blocked).
    let localTxId: string | null = null;
    for (let i = 0; i < 50; i++) {
      const found = await prisma.transaction.findFirst({
        where: { workspaceId: wsId, plaidTransactionId: syncPlaidTxId },
        select: { id: true },
      });
      if (found) { localTxId = found.id; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!localTxId) throw new Error("tx never appeared — sync may have failed");
    geminiResolve({ results: [{ tx_id: localTxId, category: "Groceries" }] });

    const res = await resPromise;
    expect(res.statusCode).toBe(200);
    expect(geminiMock.generateContent.length).toBe(0);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: localTxId } });
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    expect(after.categoryId).toBe(groceriesCat.id);
    expect(after.categorizationSource).toBe("ai");
    await app.close();
  });
});

describe("DELETE /workspaces/:id/plaid-items/:itemId", () => {
  it("strict — Plaid /item/remove called first; then accounts archived + plaid_item deleted; transactions kept", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    // Add a transaction so we can verify it survives.
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tkeep", account_id: "acct", amount: 1, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "X", name: "X", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "cN", has_more: false,
      },
    });
    // Sync awaits categorize — provide a mock Gemini response so the route unblocks.
    geminiMock.generateContent.push({ results: [] });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);

    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    // Account survives but is archived; plaidItemId becomes NULL via SetNull.
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(acct.archivedAt).not.toBeNull();
    expect(acct.plaidItemId).toBeNull();
    // Transaction survives.
    const tx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(tx.plaidTransactionId).toBe("tkeep");
    expect(tx.plaidItemId).toBeNull();
    await app.close();
  });

  it("Plaid failure → 502 plaid_unavailable AND local row preserved for retry", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.itemRemove.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("plaid_unavailable");
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).not.toBeNull();
    await app.close();
  });

  it("ITEM_NOT_FOUND from Plaid is treated as already-removed; local cleanup proceeds", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    await app.close();
  });

  it("403 for viewer trying to disconnect (owner-only)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    const viewer = await signUpAndGetCookie(app, { email: "v4@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "wmd@x.com", name: "O" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsA);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsB}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    // Plaid /item/remove must NOT be called when the request is rejected.
    expect(plaidMock.itemRemove.length).toBe(0);
    await app.close();
  });

  it("free-tier owner CAN disconnect — deliberate exception to the Pro gate", async () => {
    // Disconnect is owner-only but NOT Pro-gated, so a user whose trial has
    // expired isn't trapped — they can still revoke Plaid's access.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "fd@x.com", name: "F" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    await app.close();
  });

  it("409 sync_in_progress — disconnect while another tx holds the row lock", async () => {
    // Hold the row lock from outside the route handler in a second connection
    // (Prisma uses one connection per $transaction). The disconnect's
    // `SELECT ... FOR UPDATE NOWAIT` then fails with 55P03 → SyncLockHeld →
    // 409 sync_in_progress.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lk@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    // Coordinate via promises (see the parallel sync.test.ts test for why
    // setTimeout-based coordination is too racy on CI).
    let signalAcquired: () => void = () => {};
    const acquired = new Promise<void>((r) => (signalAcquired = r));
    let releaseHolder: () => void = () => {};
    const released = new Promise<void>((r) => (releaseHolder = r));
    const holderTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "plaid_items" WHERE id = ${plaidItemId} FOR UPDATE`;
      signalAcquired();
      await released;
    });
    try {
      await acquired;

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
        headers: { cookie: owner.cookie, "x-workspace-id": wsId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("sync_in_progress");
      // Plaid /item/remove must NOT have been called — the lock blocked us
      // before the Plaid HTTP call. This ordering depends on readAccessToken
      // (decrypt) being called OUTSIDE the lock transaction in removeItemStrict;
      // lockPlaidItem() fires before plaidClient.itemRemove(). If that order
      // ever changes, update this assertion accordingly.
      expect(plaidMock.itemRemove.length).toBe(1); // pushed but not consumed
      // Local row is still intact; the user can retry.
      expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).not.toBeNull();
    } finally {
      // Always release — see the matching note on the sync.test.ts test.
      releaseHolder();
      await holderTx;
    }
    await app.close();
  });
});

// /accounts and /transactions are READ routes — no tier gate (a Free viewer
// in a Pro owner's workspace can still browse what's already there). So
// there's no 402 case to test, only auth + workspace scoping (403 / 404 /
// workspace_mismatch). The existing per-file beforeEach/afterAll from the
// top of the file applies to every describe below.

describe("GET /workspaces/:id/accounts", () => {
  it("members can list accounts including archivedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "oacc@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await connectAItem(app, owner, wsId);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/accounts`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().accounts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Checking", type: "depository", mask: "0001" });
    expect(list[0].archivedAt).toBeNull();
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "xacc@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/accounts`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmacc@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/accounts`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("GET /workspaces/:id/transactions", () => {

  async function setupItemAndTxs(app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never, n: number) {
    const owner = await signUpAndGetCookie(app, { email: `otx-${Math.random().toString(36).slice(2,6)}@x.com`, name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    plaidMock.itemPublicTokenExchange.push({ data: { access_token: "a", item_id: "i", request_id: "r" } });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "ac", name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
        ],
        item: { item_id: "i", institution_id: "ins_1" },
        request_id: "r",
      },
    });
    const txs = Array.from({ length: n }, (_, idx) => ({
      transaction_id: `t${idx}`,
      account_id: "ac",
      amount: idx + 0.5,
      date: `2026-05-${String((idx % 28) + 1).padStart(2, "0")}`,
      authorized_date: null,
      authorized_datetime: null,
      datetime: null,
      pending: false,
      pending_transaction_id: null,
      merchant_name: `M${idx}`,
      name: `M${idx}`,
      iso_currency_code: "CAD",
    }));
    plaidMock.transactionsSync.push({ data: { added: txs, modified: [], removed: [], next_cursor: "c", has_more: false } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    return { owner, wsId, plaidItemId: res.json().plaidItemId as string };
  }

  it("default page = 50 sorted occurredAt DESC", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 60);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
    // Newest first.
    const dates = body.transactions.map((t: { occurredAt: string }) => t.occurredAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    await app.close();
  });

  it("cursor pagination — second page returns the rest", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 60);
    const first = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    const cur = first.json().nextCursor as string;
    const second = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?cursor=${encodeURIComponent(cur)}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.transactions.length).toBe(10);
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it("excludes removed transactions by default", async () => {
    const app = await buildApp(env);
    const { owner, wsId, plaidItemId } = await setupItemAndTxs(app, 3);
    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [{ transaction_id: "t1" }], next_cursor: "c2", has_more: false },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.json().transactions).toHaveLength(2);
    const include = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?includeRemoved=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(include.json().transactions).toHaveLength(3);
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "xtx@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/transactions`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmtx@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/transactions`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });

  it("from/to date range — only returns transactions within the window", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 5);
    // setupItemAndTxs maps idx → date "2026-05-{(idx%28)+1}", so t0=May 1, t1=May 2, ..., t4=May 5.
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?from=2026-05-02T00:00:00.000Z&to=2026-05-03T23:59:59.999Z`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const txs = res.json().transactions as { occurredAt: string }[];
    expect(txs.length).toBeGreaterThan(0);
    for (const t of txs) {
      const d = new Date(t.occurredAt).getTime();
      expect(d).toBeGreaterThanOrEqual(new Date("2026-05-02").getTime());
      expect(d).toBeLessThanOrEqual(new Date("2026-05-04").getTime());
    }
    await app.close();
  });

  it("invalid date in ?from returns 400 invalid_query", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 1);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?from=not-a-date`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_query");
    await app.close();
  });

  it("?uncategorizedOnly=true filters to NULL categoryId only", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 3);
    const cat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const tx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { categoryId: cat.id, categorizationSource: "manual" },
    });
    const all = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(all.json().transactions.length).toBe(3);
    const uncat = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(uncat.json().transactions.length).toBe(2);
    expect(uncat.json().transactions.every((t: { categoryId: string | null }) => t.categoryId === null)).toBe(true);
    await app.close();
  });
});

describe("Plaid connection limits", () => {
  it("Free user (expired trial) → POST /link-token → 402 upgrade_required", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Expire the trial.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1_000), trialConsumed: true },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("Free user → POST /exchange → 402 upgrade_required", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "free2@x.com", name: "Free2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1_000), trialConsumed: true },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "Bank" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("Pro user below limit → POST /link-token → 200", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // No items connected — 0/5, well below limit.

    plaidMock.linkTokenCreate.push({ data: { link_token: "lt_ok", expiration: "2099-01-01" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("Pro user at limit (5 items) → POST /exchange → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit@x.com", name: "AtLimit" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Seed 5 active items directly (bypassing exchange) to hit the limit.
    for (let i = 0; i < 5; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_limit_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p6", institutionId: "ins_1", institutionName: "Bank6" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    await app.close();
  });

  it("Pro user at limit (5 items) → POST /link-token → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit2@x.com", name: "AtLimit2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    for (let i = 0; i < 5; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_lt_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    await app.close();
  });

  it("Disconnected items don't count toward limit → exchange allowed", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "disc@x.com", name: "Disc" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // 3 active + 2 disconnected = 3 effective, below limit of 5.
    for (let i = 0; i < 3; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_active_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }
    for (let i = 0; i < 2; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_disc_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "disconnected",
        },
      });
    }

    // Exchange should succeed (only 3 active, limit is 5).
    await connectAItem(app, owner, wsId, "_new");

    const count = await prisma.plaidItem.count({ where: { workspaceId: wsId, status: "active" } });
    expect(count).toBe(4); // 3 seeded + 1 just connected
    await app.close();
  });
});
