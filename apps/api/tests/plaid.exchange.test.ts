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
import { testEnv } from "./helpers/test-env.js";


const env = testEnv();

async function makeLiteUser(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: null, trialConsumed: true },
  });
  await prisma.subscription.create({
    data: {
      userId,
      tier: "lite",
      source: "stripe",
      sourceSubscriptionId: `sub_lite_${userId}`,
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
}

async function seedPlaidItem(opts: {
  workspaceId: string;
  connectedBy: string;
  itemId: string;
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
      status: "active",
    },
  });
}

// File-level lifecycle: every test in this file needs the same fresh
// DB + mock state, and we only want to disconnect Prisma once at the end.
// Defining these inside each describe duplicates work and risks one block's
// afterAll closing the connection while the other block is mid-test.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

describe("POST /workspaces/:id/plaid/link-token", () => {
  it("happy path — owner Pro user gets a linkToken", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenCreate.push({ data: { link_token: "link_test", expiration: "2026-05-12T00:00:00Z" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linkToken: "link_test", expiration: "2026-05-12T00:00:00Z" });
    await app.close();
  });

  it("402 upgrade_required for free-tier user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("403 when caller is not owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: member.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    // Caller is owner of workspace A but submits B in the URL while their
    // active-workspace cookie / X-Workspace-Id header is A. The route guards
    // this regardless of role to prevent header-spoof CSRF-shaped attacks.
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ww@x.com", name: "WW" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid/exchange", () => {
  function pushExchangeAndAccounts(itemId = "item_test", accessToken = "access_test", accountId = "acct_1") {
    plaidMock.itemPublicTokenExchange.push({
      data: { access_token: accessToken, item_id: itemId, request_id: "req" },
    });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: accountId, name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
        ],
        item: { item_id: itemId, institution_id: "ins_1" },
        request_id: "req",
      },
    });
  }

  it("happy — item + account + transactions created; syncOk: true", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts();
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tx_1", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Coffee", name: "Coffee", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "public_test", institutionId: "ins_1", institutionName: "Test Bank" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(true);
    expect(body.accountCount).toBe(1);
    expect(body.transactionCount).toBe(1);
    expect(typeof body.plaidItemId).toBe("string");

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.itemId).toBe("item_test");
    expect(item.institutionName).toBe("Test Bank");
    expect(await prisma.bankAccount.count({ where: { plaidItemId: item.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { plaidItemId: item.id } })).toBe(1);
    await app.close();
  });

  it("422 already_connected — second exchange of the same item_id", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_dup");
    plaidMock.transactionsSync.push({ data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false } });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p1", institutionId: "ins_1", institutionName: "TB" }),
    });

    pushExchangeAndAccounts("item_dup"); // same item_id
    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p2", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("already_connected");
    await app.close();
  });

  it("410 plaid_link_expired — INVALID_PUBLIC_TOKEN from Plaid", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    plaidMock.itemPublicTokenExchange.push(plaidApiError({ error_code: "INVALID_PUBLIC_TOKEN" }));
    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "stale", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("plaid_link_expired");
    await app.close();
  });

  it("partial failure — initial sync errors but item is durable; 200 with syncOk: false", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_partial");
    plaidMock.transactionsSync.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));

    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(false);
    expect(body.transactionCount).toBe(0);
    expect(body.accountCount).toBe(1);

    // Item is durable + status reflects the failure.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("INSTITUTION_DOWN");
    await app.close();
  });

  it("402 upgrade_required for free-tier user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free2@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const wsId = await getOwnerWorkspaceId(u.userId);
    pushExchangeAndAccounts("item_free_cleanup", "access_free_cleanup", "acct_free_cleanup");
    plaidMock.itemRemove.push({ data: { request_id: "remove-free-cleanup" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    expect(plaidMock.accountsGet.length).toBe(0);
    expect(plaidMock.itemRemove.length).toBe(0);
    expect(await prisma.plaidItem.findUnique({ where: { itemId: "item_free_cleanup" } })).toBeNull();
    await app.close();
  });

  it("403 when caller is not owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const editor = await signUpAndGetCookie(app, { email: "ed@x.com", name: "ED" });
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: editor.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(403);
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmx@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid/exchange`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });

  it("rechecks user-wide limit after link token was issued", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lite-recheck@x.com", name: "LR" });
    await makeLiteUser(owner.userId);
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: "item_existing_lite" });
    pushExchangeAndAccounts("item_after_link", "access_after_link", "acct_after_link");
    plaidMock.itemRemove.push({ data: { request_id: "remove-after-link" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p-after-link", institutionId: "ins_1", institutionName: "TB" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    expect(plaidMock.accountsGet.length).toBe(0);
    expect(plaidMock.itemRemove.length).toBe(0);
    expect(await prisma.plaidItem.count({ where: { connectedBy: owner.userId, status: { not: "disconnected" } } })).toBe(1);
    expect(await prisma.plaidItem.findUnique({ where: { itemId: "item_after_link" } })).toBeNull();
    await app.close();
  });

  it("concurrent exchanges for same Lite user create at most one item", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lite-race@x.com", name: "Race" });
    await makeLiteUser(owner.userId);
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_race_1", "access_race_1", "acct_race_1");
    pushExchangeAndAccounts("item_race_2", "access_race_2", "acct_race_2");
    plaidMock.itemRemove.push({ data: { request_id: "remove-race-loser" } });
    plaidMock.transactionsSync.push({ data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false } });

    const request = (publicToken: string) => app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken, institutionId: "ins_1", institutionName: "TB" }),
    });
    const responses = await Promise.all([request("p-race-1"), request("p-race-2")]);
    const statuses = responses.map((r) => r.statusCode).sort();

    expect(statuses).toEqual([200, 402]);
    expect(responses.find((r) => r.statusCode === 402)?.json().error).toBe("plaid_item_limit_reached");
    expect(await prisma.plaidItem.count({ where: { connectedBy: owner.userId, status: { not: "disconnected" } } })).toBe(1);
    await app.close();
  });

  it("stores pending cleanup row when final limit cleanup fails", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lite-cleanup@x.com", name: "LC" });
    await makeLiteUser(owner.userId);
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await seedPlaidItem({ workspaceId: wsId, connectedBy: owner.userId, itemId: "item_cleanup_existing" });
    pushExchangeAndAccounts("item_cleanup_pending", "access_cleanup_pending", "acct_cleanup_pending");
    plaidMock.itemRemove.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p-cleanup", institutionId: "ins_1", institutionName: "Cleanup Bank" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    const cleanup = await prisma.plaidItem.findUniqueOrThrow({
      where: { itemId: "item_cleanup_pending" },
    });
    expect(cleanup).toMatchObject({
      workspaceId: wsId,
      connectedBy: owner.userId,
      status: "disconnected",
      errorCode: "billing_cleanup_pending",
      institutionId: "ins_1",
      institutionName: "Cleanup Bank",
    });
    expect(cleanup.accessTokenCiphertext.length).toBeGreaterThan(0);
    expect(cleanup.accessTokenIv.length).toBeGreaterThan(0);
    expect(await prisma.plaidItem.count({ where: { connectedBy: owner.userId, status: { not: "disconnected" } } })).toBe(1);
    await app.close();
  });

  it("removes Plaid item when account creation hits duplicate plaidAccountId", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "acct-conflict@x.com", name: "AC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await prisma.bankAccount.create({
      data: {
        workspaceId: wsId,
        plaidAccountId: "acct_conflict",
        name: "Existing Plaid Account",
        type: "depository",
        currency: "CAD",
      },
    });
    pushExchangeAndAccounts("item_account_conflict", "access_account_conflict", "acct_conflict");
    plaidMock.itemRemove.push({ data: { request_id: "remove-account-conflict" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p-account-conflict", institutionId: "ins_1", institutionName: "Conflict Bank" }),
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("already_connected");
    expect(plaidMock.itemRemove.length).toBe(0);
    expect(await prisma.plaidItem.findUnique({ where: { itemId: "item_account_conflict" } })).toBeNull();
    expect(await prisma.bankAccount.count({ where: { plaidAccountId: "acct_conflict" } })).toBe(1);
    await app.close();
  });

  it("detached categorize after exchange — tx get categoryId + source='ai' within poll window", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ex-cat@x.com", name: "EC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_cat");
    plaidMock.transactionsSync.push({
      data: {
        added: [{ transaction_id: "tx_cat", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Loblaws", name: "Loblaws", iso_currency_code: "CAD" }],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    let geminiResolveExch!: (r: { results: Array<{ tx_id: string; category: string }> }) => void;
    geminiMock.generateContent.push(
      new Promise<{ results: Array<{ tx_id: string; category: string }> }>((r) => { geminiResolveExch = r; }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const localTx = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId: wsId, plaidTransactionId: "tx_cat" },
      select: { id: true },
    });
    geminiResolveExch({ results: [{ tx_id: localTx.id, category: "Groceries" }] });
    for (let i = 0; i < 50; i++) {
      const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: localTx.id } });
      if (alloc?.categoryId !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const finalAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: localTx.id } });
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    expect(finalAlloc?.categoryId).toBe(groceriesCat.id);
    expect(finalAlloc?.source).toBe("ai");
    await app.close();
  });

  it("detached categorize: Gemini failure does NOT break exchange response", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ex-cat-fail@x.com", name: "ECF" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_cat_fail");
    plaidMock.transactionsSync.push({
      data: {
        added: [{ transaction_id: "tx_fail", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Costco", name: "Costco", iso_currency_code: "CAD" }],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    geminiMock.generateContent.push(new Error("Gemini down"));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    await app.close();
  });

  it("soft timeout — initial sync exceeds deadline; 200 with syncOk: false", async () => {
    // Real timers + a 50ms deadline override (PLAID_SYNC_TIMEOUT_MS in env).
    // We tried fake timers + advanceTimersByTimeAsync first; it raced badly
    // with fastify.inject + Prisma's microtask scheduling and either hung or
    // resolved before the handler had registered its setTimeout. A real,
    // small timer is far simpler and adds ~50ms to the run.
    const fastTimeoutEnv = { ...env, PLAID_SYNC_TIMEOUT_MS: 50 };
    const app = await buildApp(fastTimeoutEnv);
    const owner = await signUpAndGetCookie(app, { email: "slow@x.com", name: "S" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_slow");
    // Hang transactionsSync forever so the timeout wins the race.
    plaidMock.transactionsSync.push(new Promise(() => {}));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(false);
    expect(body.transactionCount).toBe(0);
    // Item is still durable so the user can hit Refresh later.
    expect(typeof body.plaidItemId).toBe("string");
    // Spec §7: deadline-hit initial sync persists status="error" + sync_timeout
    // so the UI knows to prompt for retry.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("sync_timeout");
    await app.close();
  });
});
