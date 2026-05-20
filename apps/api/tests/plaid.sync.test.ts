import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

// vi.mock(path, factory) is hoisted above all imports — referencing the
// factory through a regular `import` triggers a TDZ error. Use vi.hoisted()
// to load the helper in the same hoisted scope so the factory has a stable
// binding before vi.mock fires. Without this, either the real `plaid` SDK
// loads (silent: tests fail with "missing scripted response") or the test
// file itself crashes with "Cannot access '__vi_import_0__' before init".
const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { encrypt } from "../src/crypto/aes-gcm.js";


import { syncTransactions } from "../src/plaid/sync.js";

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

async function makeItemWithAccount(
  workspaceId: string,
  plaidAccountId = "acct_test",
): Promise<{ itemId: string; accountId: string; plaidItemId: string; plaidAccountId: string }> {
  const { ciphertext, iv } = encrypt(env, "access-test-token", workspaceId);
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId,
      itemId: `plaid_item_${Math.random().toString(36).slice(2, 10)}`,
      institutionId: "ins_1",
      institutionName: "Test Bank",
      accessTokenCiphertext: ciphertext,
      accessTokenIv: iv,
    },
  });
  const acct = await prisma.bankAccount.create({
    data: {
      workspaceId,
      plaidItemId: item.id,
      plaidAccountId, // deterministic so test mocks can reference it
      name: "Checking",
      type: "depository",
    },
  });
  return { plaidItemId: item.id, itemId: item.itemId, accountId: acct.id, plaidAccountId };
}

function tx(opts: {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
  merchant?: string;
  authorized_date?: string;
}) {
  return {
    transaction_id: opts.transaction_id,
    account_id: opts.account_id,
    amount: opts.amount,
    date: opts.date,
    authorized_date: opts.authorized_date ?? null,
    authorized_datetime: null,
    datetime: null,
    pending: opts.pending ?? false,
    pending_transaction_id: opts.pending_transaction_id ?? null,
    merchant_name: opts.merchant ?? null,
    name: opts.merchant ?? "Unknown",
    iso_currency_code: "CAD",
  };
}

// File-level lifecycle (Plan 2 convention) — keeps hooks consistent with the
// other plaid.* test files.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("syncTransactions", () => {
  it("happy path — single page applies added/modified/removed and advances cursor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId, accountId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [
          tx({ transaction_id: "t1", account_id: "acct_test", amount: 12.34, date: "2026-05-10" }),
        ],
        modified: [],
        removed: [],
        next_cursor: "cursor_v1",
        has_more: false,
      },
    });

    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r).toMatchObject({ added: 1, modified: 0, removed: 0 });

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.lastCursor).toBe("cursor_v1");
    expect(item.lastSyncAt).not.toBeNull();
    expect(item.status).toBe("active");

    const t = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(t.plaidTransactionId).toBe("t1");
    expect(t.amount.toString()).toBe("12.34");
    expect(t.accountId).toBe(accountId);
    await app.close();
  });

  it("multi-page — cursor advances per page; all 3 buckets accumulated across pages", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(
      { data: { added: [tx({ transaction_id: "p1", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c1", has_more: true } },
      { data: { added: [tx({ transaction_id: "p2", account_id: "acct_test", amount: 2, date: "2026-05-10" })], modified: [], removed: [], next_cursor: "c2", has_more: false } },
    );

    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r).toMatchObject({ added: 2, modified: 0, removed: 0 });
    expect((await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } })).lastCursor).toBe("c2");
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(2);
    await app.close();
  });

  it("pending → posted promotion via plaidTransactionId lookup, in same page", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Sync 1: a pending row arrives.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "pend1", account_id: "acct_test", amount: 9.99, date: "2026-05-10", pending: true })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    const beforeRow = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(beforeRow.pending).toBe(true);
    expect(beforeRow.plaidTransactionId).toBe("pend1");

    // Sync 2: the posted row points back at the pending one.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({
          transaction_id: "post1",
          account_id: "acct_test",
          amount: 9.99,
          date: "2026-05-11",
          pending: false,
          pending_transaction_id: "pend1", // promotion key — old pending's transaction_id
        })],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.added).toBe(1);

    // Same row id, but Plaid id + pending state changed.
    const afterRow = await prisma.transaction.findUniqueOrThrow({ where: { id: beforeRow.id } });
    expect(afterRow.plaidTransactionId).toBe("post1");
    expect(afterRow.pending).toBe(false);
    expect(afterRow.plaidPendingTransactionId).toBe("pend1");
    expect(afterRow.postedAt).not.toBeNull();
    expect(afterRow.removedAt).toBeNull();
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(1);
    await app.close();
  });

  it("removed-before-added across pages — promotion clears removedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Sync 1: pending row arrives.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "pend2", account_id: "acct_test", amount: 5, date: "2026-05-10", pending: true })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    const pendingRow = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });

    // Sync 2 spans TWO pages — page 1 removes the pending row (soft-delete),
    // page 2 (the posted `added`) needs to find the now-removed row by
    // plaidTransactionId == pending_transaction_id and clear removedAt.
    plaidMock.transactionsSync.push({
      data: {
        added: [],
        modified: [],
        removed: [{ transaction_id: "pend2" }],
        next_cursor: "mid", has_more: true,
      },
    });
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "post2", account_id: "acct_test", amount: 5, date: "2026-05-11", pending: false, pending_transaction_id: "pend2" })],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);

    const afterRow = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingRow.id } });
    expect(afterRow.removedAt).toBeNull(); // promotion cleared the page-1 soft-delete
    expect(afterRow.plaidTransactionId).toBe("post2");
    expect(afterRow.pending).toBe(false);
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(1);
    await app.close();
  });

  it("modified — updates row in place", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "m1", account_id: "acct_test", amount: 1.0, date: "2026-05-10", merchant: "Old" })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    plaidMock.transactionsSync.push({
      data: {
        added: [],
        modified: [tx({ transaction_id: "m1", account_id: "acct_test", amount: 1.5, date: "2026-05-10", merchant: "New" })],
        removed: [],
        next_cursor: "c2", has_more: false,
      },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.modified).toBe(1);
    const after = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(after.merchantRaw).toBe("New");
    expect(after.amount.toString()).toBe("1.5");
    await app.close();
  });

  it("removed — sets removedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "r1", account_id: "acct_test", amount: 1, date: "2026-05-10" })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [{ transaction_id: "r1" }], next_cursor: "c2", has_more: false },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.removed).toBe(1);
    const after = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(after.removedAt).not.toBeNull();
    await app.close();
  });

  it("ITEM_LOGIN_REQUIRED — status persists (separate tx) AND error is rethrown", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(
      plaidApiError({ error_code: "ITEM_LOGIN_REQUIRED", error_message: "log in" }),
    );

    await expect(syncTransactions(env, wsId, plaidItemId)).rejects.toMatchObject({
      statusCode: 409,
      code: "plaid_login_required",
    });
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.status).toBe("relink_required");
    expect(item.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    await app.close();
  });

  it("generic Plaid error — status = error + 502 plaid_unavailable", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));
    await expect(syncTransactions(env, wsId, plaidItemId)).rejects.toMatchObject({
      statusCode: 502,
      code: "plaid_unavailable",
    });
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("INSTITUTION_DOWN");
    await app.close();
  });

  it("mutation-during-pagination — error code triggers loop restart from originalCursor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Page 1 of attempt #1: applies 1 row, has_more = true. Row is committed
    // (per-page commit) but lastCursor is NOT updated yet — that only happens
    // at has_more=false.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "first", account_id: "acct_test", amount: 1, date: "2026-05-09" })],
        modified: [], removed: [], next_cursor: "c1", has_more: true,
      },
    });
    // Page 2 of attempt #1: Plaid raises the documented error mid-pagination.
    // Our loop catches by error code, resets cursor to originalCursor, restarts.
    plaidMock.transactionsSync.push(
      plaidApiError({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }),
    );
    // Attempt #2 page 1: re-fetches from originalCursor (=null since fresh
    // item). Returns the same "first" row — upsert is idempotent (partial
    // unique on plaidTransactionId). Plus 2 newer rows.
    plaidMock.transactionsSync.push({
      data: {
        added: [
          tx({ transaction_id: "first", account_id: "acct_test", amount: 1, date: "2026-05-09" }),
          tx({ transaction_id: "after1", account_id: "acct_test", amount: 1, date: "2026-05-10" }),
          tx({ transaction_id: "after2", account_id: "acct_test", amount: 2, date: "2026-05-10" }),
        ],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });

    const r = await syncTransactions(env, wsId, plaidItemId);
    // After restart, the second-attempt page returned 3 added (re-applying the
    // previously-seen "first" + 2 new). Accumulators were reset on restart so
    // the count reflects only the second attempt.
    expect(r).toMatchObject({ added: 3, modified: 0, removed: 0 });
    const all = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
    expect(all.map((t) => t.plaidTransactionId).sort()).toEqual(["after1", "after2", "first"]);
    // lastCursor only advances on the final successful page (has_more=false in
    // attempt #2). Verify the cursor is persisted now.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.lastCursor).toBe("c2");
    await app.close();
  });

  it("returns newTxIds for fresh inserts only — promotion excluded", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-prom@x.com", name: "P" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);
    plaidMock.transactionsSync.push({
      data: { added: [tx({ transaction_id: "pend_n1", account_id: "acct_test", amount: 5, date: "2026-05-10", pending: true })], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });
    const r1 = await syncTransactions(env, wsId, plaidItemId);
    expect("newTxIds" in r1).toBe(true);
    expect((r1 as { newTxIds: string[] }).newTxIds).toHaveLength(1);
    plaidMock.transactionsSync.push({
      data: { added: [tx({ transaction_id: "post_n1", account_id: "acct_test", amount: 5, date: "2026-05-11", pending: false, pending_transaction_id: "pend_n1" })], modified: [], removed: [], next_cursor: "c2", has_more: false },
    });
    const r2 = await syncTransactions(env, wsId, plaidItemId);
    expect((r2 as { newTxIds: string[] }).newTxIds).toHaveLength(0);
    await app.close();
  });

  it("returns newTxIds: multi-page run accumulates fresh inserts across pages", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-multi@x.com", name: "M" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);
    plaidMock.transactionsSync.push(
      { data: { added: [tx({ transaction_id: "p1a", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c1", has_more: true } },
      { data: { added: [tx({ transaction_id: "p2a", account_id: "acct_test", amount: 2, date: "2026-05-10" })], modified: [], removed: [], next_cursor: "c2", has_more: false } },
    );
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect((r as { newTxIds: string[] }).newTxIds).toHaveLength(2);
    await app.close();
  });

  it("syncTransactions does NOT call categorize (newTxIds is caller's responsibility)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-nocategorize@x.com", name: "NC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);
    plaidMock.transactionsSync.push({
      data: { added: [tx({ transaction_id: "nc1", account_id: "acct_test", amount: 3, date: "2026-05-10" })], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });
    // No Gemini push — if categorize were called, it would throw "no scripted response".
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect((r as { newTxIds: string[] }).newTxIds).toHaveLength(1);
    const t = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    const tAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: t.id } });
    expect(tAlloc?.categoryId).toBeNull();
    await app.close();
  });

  it("mutation-restart: newTxIds from committed page survives restart", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-restart@x.com", name: "R" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);
    plaidMock.transactionsSync.push({
      data: { added: [tx({ transaction_id: "mr_a", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c1", has_more: true },
    });
    plaidMock.transactionsSync.push(plaidApiError({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }));
    plaidMock.transactionsSync.push({
      data: { added: [tx({ transaction_id: "mr_a", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c2", has_more: false },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect((r as { newTxIds: string[] }).newTxIds).toHaveLength(1);
    await app.close();
  });

  it("row-lock contention — sync returns lock_held when another tx holds the row", async () => {
    // We can't reliably exercise contention with two `Promise.all`-launched
    // syncTransactions calls — the Plaid mock is FIFO and the JS event loop
    // tends to serialize them, so both look "successful" in turn. The real
    // production race is sync-vs-disconnect (or sync-vs-cron), so model that
    // by holding the row lock in an out-of-band transaction and verifying
    // syncTransactions hits SyncLockHeld → returns `{skipped:"lock_held"}`.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o10@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });

    // Coordinate via promises rather than setTimeout — the latter is racy
    // on slow CI hosts (50ms can pass before the holder tx actually got the
    // lock). `acquired` resolves the moment the SELECT returns; `released`
    // is set by the test body to let the holder commit and free the lock.
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

      const r = await syncTransactions(env, wsId, plaidItemId);
      expect(r).toMatchObject({ skipped: "lock_held", added: 0, modified: 0, removed: 0 });
      // syncTransactions calls Plaid BEFORE attempting the per-page row lock,
      // so the mock response IS consumed (then discarded when the per-page tx
      // aborts on SyncLockHeld). Verify by asserting nothing landed in the DB:
      // no transactions, and lastCursor on the plaid_item is unchanged.
      expect(plaidMock.transactionsSync.length).toBe(0); // popped by the call
      expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(0);
      const itemRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
      expect(itemRow.lastCursor).toBeNull();
    } finally {
      // Always release the holder, even on assertion failure — otherwise the
      // tx sits in Postgres holding the row lock until vitest's idle timeout
      // and the failure surfaces as a confusing hang instead of the actual
      // assertion error.
      releaseHolder();
      await holderTx;
    }
    await app.close();
  });
});

describe("markRemoved", () => {
  it("clears matchedTxId on ScheduledSpend referencing the removed tx", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "plaid-sched-rm@t.co" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-plaid-sched" } });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository", status: "active" },
    });
    const ptx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: "p_sched_rm",
        amount: "50", merchantRaw: "PX", merchantNormalized: "px",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "plaid", rawData: {},
      },
    });
    const sched = await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "100", scheduledDate: new Date("2026-05-25T00:00:00Z"),
        matchedTxId: ptx.id,
      },
    });

    await prisma.$transaction(async (tx) => {
      const { markRemoved } = await import("../src/plaid/sync.js");
      await markRemoved(tx, "p_sched_rm", wsId);
    });

    const after = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.matchedTxId).toBeNull();
    const txAfter = await prisma.transaction.findUniqueOrThrow({ where: { id: ptx.id } });
    expect(txAfter.removedAt).not.toBeNull();
    await app.close();
  });
});
