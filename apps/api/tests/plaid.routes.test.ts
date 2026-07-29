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
import { storeAccessToken } from "../src/plaid/items.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

async function makeProUser(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: null, trialConsumed: true },
  });
  await prisma.subscription.create({
    data: {
      userId,
      tier: "pro",
      source: "stripe",
      sourceSubscriptionId: `sub_pro_${userId}`,
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
}

async function makeMaxUser(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: null, trialConsumed: true },
  });
  await prisma.subscription.create({
    data: {
      userId,
      tier: "max",
      source: "stripe",
      sourceSubscriptionId: `sub_max_${userId}`,
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
}

async function seedPlaidItem(opts: {
  workspaceId: string;
  connectedBy?: string | null;
  itemId: string;
  status?: "active" | "disconnected";
}): Promise<void> {
  await prisma.plaidItem.create({
    data: {
      workspaceId: opts.workspaceId,
      connectedBy: opts.connectedBy,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from(new Array(12).fill(2)),
      itemId: opts.itemId,
      institutionId: "ins_1",
      institutionName: "Bank",
      status: opts.status ?? "active",
    },
  });
}

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
    expect(res.json()).toMatchObject({
      reconnectRequired: false,
      reconnectAccountCount: 0,
    });
    await app.close();
  });

  it("surfaces a billing-removed bank as reconnect-required", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, {
      email: "reconnect-required@x.com",
      name: "Reconnect",
    });
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: null, trialConsumed: true },
    });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidInstitutionId: "ins_old",
        plaidAccountId: "acct_old_reconnect",
        name: "Old checking",
        type: "depository",
        archivedAt: new Date(),
        plaidReconnectRequired: true,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/plaid-items`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plaidItems: [],
      reconnectRequired: true,
      reconnectAccountCount: 1,
      canConnectBank: false,
    });
    await app.close();
  });

  it("clears reconnect-required after the same institution is linked again", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, {
      email: "reconnect-cleared@x.com",
      name: "Reconnect",
    });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const oldAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidInstitutionId: "ins_1",
        plaidAccountId: "acct_old_cleared",
        name: "Old checking",
        type: "depository",
        archivedAt: new Date(),
        plaidReconnectRequired: true,
      },
    });

    await connectAItem(app, owner, wsId, "_reconnected");

    await expect(
      prisma.bankAccount.findUniqueOrThrow({ where: { id: oldAccount.id } }),
    ).resolves.toMatchObject({ plaidReconnectRequired: false });
    await app.close();
  });

  it("plaid-items list returns connectedBy owner display fields", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, {
      email: "plaid-owner@x.com",
      name: "Plaid Owner",
    });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await seedPlaidItem({
      workspaceId: wsId,
      connectedBy: owner.userId,
      itemId: "item_owner_fields",
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/plaid-items`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().plaidItems).toEqual([
      expect.objectContaining({
        connectedByUserId: owner.userId,
        connectedByName: "Plaid Owner",
      }),
    ]);
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

  it("requests four months of transaction history", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "lt-days@x.com", name: "LD" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenCreate.push({ data: { link_token: "lt-days", expiration: "2099-01-01" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    expect(plaidMock.linkTokenCreateCalls[0][0]).toMatchObject({
      transactions: { days_requested: 120 },
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

  it("counts user-owned items across workspaces", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lt-cross@x.com", name: "LC" });
    await makeProUser(owner.userId);
    const wsA = await getOwnerWorkspaceId(owner.userId);
    for (let i = 0; i < 5; i++) {
      await seedPlaidItem({
        workspaceId: wsA,
        connectedBy: owner.userId,
        itemId: `item_lite_ws_a_${i}`,
      });
    }
    const wsB = await prisma.workspace.create({
      data: {
        name: "Second",
        memberships: { create: { userId: owner.userId, role: "owner" } },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB.id}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsB.id },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "plaid_item_limit_reached" });
    expect(plaidMock.linkTokenCreate.length).toBe(0);
    await app.close();
  });

  it("ignores another member's item in the same workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lt-owner@x.com", name: "LO" });
    await makeProUser(owner.userId);
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const other = await signUpAndGetCookie(app, { email: "lt-other@x.com", name: "LM" });
    await prisma.membership.create({
      data: { userId: other.userId, workspaceId: wsId, role: "viewer" },
    });
    await seedPlaidItem({ workspaceId: wsId, connectedBy: other.userId, itemId: "item_other_member" });
    plaidMock.linkTokenCreate.push({ data: { link_token: "lt_user_ok", expiration: "2099-01-01" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().linkToken).toBe("lt_user_ok");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid-items/:itemId/sync", () => {
  it("owner with Plaid entitlement — happy path returns counts", async () => {
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
    // Sync awaits categorize — provide a mock LLM response so the route unblocks.
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

  it("pro owner can manually sync their active owned item", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "pro-sync@x.com", name: "PS" });
    await makeProUser(owner.userId);
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId, "_pro_sync");

    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 0, modified: 0, removed: 0 });
    await app.close();
  });

  it("owner cannot sync another user's connected item", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "shared-owner@x.com", name: "SO" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const other = await signUpAndGetCookie(app, { email: "shared-other@x.com", name: "SM" });
    await prisma.membership.create({ data: { userId: other.userId, workspaceId: wsId, role: "viewer" } });
    const otherPlaidItemId = await storeAccessToken(env, prisma, {
      workspaceId: wsId,
      connectedBy: other.userId,
      itemId: "item_other_member_sync",
      institutionId: "ins_1",
      institutionName: "Other Bank",
      accessToken: "access_other_member_sync",
    });

    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${otherPlaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
    expect(plaidMock.transactionsSync).toHaveLength(1);
    await app.close();
  });

  it("403 for viewer member (Plaid-mutating routes are owner-only)", async () => {
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
    // Sync requires a Plaid entitlement (unlike disconnect — see DELETE
    // describe). A user whose trial expired can read existing transactions
    // but can't pull new ones until they upgrade.
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

    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: localTxId } });
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    expect(afterAlloc?.categoryId).toBe(groceriesCat.id);
    expect(afterAlloc?.source).toBe("ai");
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
    // Sync awaits categorize — provide a mock LLM response so the route unblocks.
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
    // Plaid-linked account survives but is archived; plaidItemId becomes
    // NULL via SetNull. Workspace bootstrap also seeds default manual
    // accounts, so filter by plaidAccountId (only set on Plaid rows) to
    // pick the right one.
    const acct = await prisma.bankAccount.findFirstOrThrow({
      where: { workspaceId: wsId, plaidAccountId: { not: null } },
    });
    expect(acct.archivedAt).not.toBeNull();
    expect(acct.plaidItemId).toBeNull();
    // Transaction survives.
    const tx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(tx.plaidTransactionId).toBe("tkeep");
    expect(tx.plaidItemId).toBeNull();
    await app.close();
  });

  it("deleteTransactions=true deletes transactions from that Plaid item", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "delete-tx@x.com", name: "D" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const deleteItemId = await connectAItem(app, owner, wsId, "_delete");
    const keepItemId = await connectAItem(app, owner, wsId, "_keep");

    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tdelete", account_id: "acct_delete", amount: 1, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Delete Me", name: "Delete Me", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c-delete", has_more: false,
      },
    });
    geminiMock.generateContent.push({ results: [] });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${deleteItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tkeep", account_id: "acct_keep", amount: 2, date: "2026-05-11", authorized_date: null, authorized_datetime: null, pending: false, pending_transaction_id: null, datetime: null, merchant_name: "Keep Me", name: "Keep Me", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c-keep", has_more: false,
      },
    });
    geminiMock.generateContent.push({ results: [] });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${keepItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    plaidMock.itemRemove.push({ data: { request_id: "req" } });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${deleteItemId}?deleteTransactions=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.transaction.findFirst({ where: { plaidTransactionId: "tdelete" } })).toBeNull();
    expect(await prisma.transaction.findFirst({ where: { plaidTransactionId: "tkeep" } })).not.toBeNull();
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
    // Workspace seed adds 5 default manual accounts (Cash/Debit/Checking/
    // Savings/Credit). Find the Plaid-linked one by mask.
    const list = res.json().accounts;
    const plaid = list.find((a: { mask: string }) => a.mask === "0001");
    expect(plaid).toMatchObject({ name: "Checking", type: "depository", mask: "0001" });
    expect(plaid.archivedAt).toBeNull();
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
    // Update the allocation (source of truth for ?uncategorizedOnly filter after Task 8)
    await prisma.transactionAllocation.updateMany({
      where: { transactionId: tx.id },
      data: { categoryId: cat.id, source: "manual" },
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
    expect(uncat.json().transactions.every((t: { allocations: Array<{ categoryId: string | null }> }) =>
      t.allocations.every((a) => a.categoryId === null),
    )).toBe(true);
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
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    expect(plaidMock.accountsGet.length).toBe(0);
    expect(plaidMock.itemRemove.length).toBe(0);
    await app.close();
  });

  it("Pro user below limit → POST /link-token → 200", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // No items connected — 0/20, well below limit.

    plaidMock.linkTokenCreate.push({ data: { link_token: "lt_ok", expiration: "2099-01-01" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("Pro user at limit (5 items) → POST /link-token → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "oldlimit@x.com", name: "OldLimit" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    for (let i = 0; i < 5; i++) {
      await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: `item_old_limit_${i}` });
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

  it("Max user at limit (20 items) → POST /exchange → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit@x.com", name: "AtLimit" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await makeMaxUser(owner.userId);
    // Seed 20 active items directly (bypassing exchange) to hit the limit.
    for (let i = 0; i < 20; i++) {
      await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: `item_limit_${i}` });
    }
    plaidMock.itemPublicTokenExchange.push({
      data: { access_token: "access_limit_6", item_id: "item_limit_6", request_id: "req" },
    });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "acct_limit_6", name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
        ],
        item: { item_id: "item_limit_6", institution_id: "ins_1" },
        request_id: "req",
      },
    });
    plaidMock.itemRemove.push({ data: { request_id: "remove-limit" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p6", institutionId: "ins_1", institutionName: "Bank6" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    expect(await prisma.plaidItem.count({ where: { connectedBy: owner.userId, status: { not: "disconnected" } } })).toBe(20);
    await app.close();
  });

  it("Max user at limit (20 items) → POST /link-token → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit2@x.com", name: "AtLimit2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await makeMaxUser(owner.userId);
    for (let i = 0; i < 20; i++) {
      await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: `item_lt_${i}` });
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
    // 3 active + 2 disconnected = 3 effective, below limit of 20.
    for (let i = 0; i < 3; i++) {
      await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: `item_active_${i}` });
    }
    for (let i = 0; i < 2; i++) {
      await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: `item_disc_${i}`, status: "disconnected" });
    }

    // Exchange should succeed (only 3 active, limit is 5).
    await connectAItem(app, owner, wsId, "_new");

    const count = await prisma.plaidItem.count({ where: { workspaceId: wsId, status: "active" } });
    expect(count).toBe(4); // 3 seeded + 1 just connected
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid/exchange — currency_mismatch", () => {
  it("400 currency_mismatch when Plaid returns USD account for CAD workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cm-usd@x.com", name: "CM" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    // Workspace currency defaults to CAD; Plaid returns a USD account.
    plaidMock.itemPublicTokenExchange.push({
      data: { access_token: "access_cm_usd", item_id: "item_cm_usd", request_id: "req" },
    });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "acct_cm_usd", name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "USD" } },
        ],
        item: { item_id: "item_cm_usd", institution_id: "ins_1" },
        request_id: "req",
      },
    });
    // itemRemove is called for cleanup — queue a success response.
    plaidMock.itemRemove.push({ data: { request_id: "req_remove" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p_cm_usd", institutionId: "ins_1", institutionName: "USD Bank" }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "currency_mismatch",
      workspaceCurrency: "CAD",
      bankCurrency: "USD",
    });
    // No plaid_items or bank_accounts should have been created.
    expect(await prisma.plaidItem.count({ where: { workspaceId: wsId } })).toBe(0);
    // Only the seeded manual accounts should remain — no Plaid-linked row.
    expect(
      await prisma.bankAccount.count({
        where: { workspaceId: wsId, plaidAccountId: { not: null } },
      }),
    ).toBe(0);
    // itemRemove response was consumed (queue is now empty).
    expect(plaidMock.itemRemove.length).toBe(0);
    await app.close();
  });

  it("400 currency_mismatch when Plaid returns null iso_currency_code", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cm-null@x.com", name: "CMN" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    // Workspace currency defaults to CAD; Plaid returns null iso_currency_code.
    plaidMock.itemPublicTokenExchange.push({
      data: { access_token: "access_cm_null", item_id: "item_cm_null", request_id: "req" },
    });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "acct_cm_null", name: "Checking", official_name: null, mask: "0002", type: "depository", subtype: "checking", balances: { current: 50, available: 50, limit: null, iso_currency_code: null } },
        ],
        item: { item_id: "item_cm_null", institution_id: "ins_1" },
        request_id: "req",
      },
    });
    // itemRemove is called for cleanup.
    plaidMock.itemRemove.push({ data: { request_id: "req_remove_null" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p_cm_null", institutionId: "ins_1", institutionName: "Null Currency Bank" }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "currency_mismatch",
      workspaceCurrency: "CAD",
      bankCurrency: "unknown",
    });
    // No plaid_items or bank_accounts created.
    expect(await prisma.plaidItem.count({ where: { workspaceId: wsId } })).toBe(0);
    // Only the seeded manual accounts should remain — no Plaid-linked row.
    expect(
      await prisma.bankAccount.count({
        where: { workspaceId: wsId, plaidAccountId: { not: null } },
      }),
    ).toBe(0);
    // itemRemove response was consumed.
    expect(plaidMock.itemRemove.length).toBe(0);
    await app.close();
  });
});
