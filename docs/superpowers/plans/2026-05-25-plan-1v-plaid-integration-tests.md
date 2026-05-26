# Plan 1V — Plaid integration push tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 11 tests + 1 production fix covering Plaid integration push paths. 3 tasks, 3 commits.

**Architecture:**
- T1: extend `cron.daily-refresh.test.ts` with push-integration describe (3 tests, partial vi.mock of anomaly + transaction-added).
- T2: fix `webhook-item.ts:34-36` per-recipient fail-stop (mirrors Plan 1U) + extend `plaid.webhook.item.test.ts` (5 tests, partial vi.mock of send.js + new fan-out coverage).
- T3: NEW `cron.scheduled-spend-match.test.ts` (3 tests, partial vi.mock of schedules/match.js).

**Tech Stack:** Vitest 2.x, prisma, partial vi.mock pattern.

---

## File Structure

- **Modify (test)**: `apps/api/tests/cron.daily-refresh.test.ts` (T1).
- **Modify (prod)**: `apps/api/src/plaid/webhook-item.ts` (T2 fix).
- **Modify (test)**: `apps/api/tests/plaid.webhook.item.test.ts` (T2 — existing tests + new fan-out + per-recipient containment).
- **Create (test)**: `apps/api/tests/cron.scheduled-spend-match.test.ts` (T3).

No `@fina/shared` changes.

---

## Task 1: `cron.daily-refresh.test.ts` extension (3 tests, 1 commit)

**Files:**
- Modify: `apps/api/tests/cron.daily-refresh.test.ts`

- [x] **Step 1: Read precedent + production**

Read `apps/api/src/cron/jobs/daily-refresh.ts` (full file, ~140 LOC). Note especially:
- L9-10: imports `checkLargeChargeAndPush` from `../../push/anomaly.js` + `notifyTransactionAdded` from `../../push/transaction-added.js`.
- L95-130: per-item outer `try/catch`. Inside: for-loop over `result.newTxIds`, for each calls `prisma.transaction.findUnique` (L99-108), then sequential awaits at L108-113 (`checkLargeChargeAndPush`) and L116-121 (`notifyTransactionAdded`). NO inner try/catch between them — fail-stop within tx.

Read existing `apps/api/tests/cron.daily-refresh.test.ts` lines 1-90 to understand the existing 5 `vi.mock`s + the `beforeEach` mock-reset pattern.

**Guardrail:** Do NOT modify production code in T1.

- [x] **Step 2: Add two new module-level `vi.mock` calls**

After the existing 5 `vi.mock` calls (around line 17), append:
```ts
vi.mock("../src/push/anomaly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/anomaly.js")>();
  return { ...actual, checkLargeChargeAndPush: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/transaction-added.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/transaction-added.js")>();
  return { ...actual, notifyTransactionAdded: vi.fn().mockResolvedValue(undefined) };
});
```

Add namespace imports near top:
```ts
import * as anomalyMod from "../src/push/anomaly.js";
import * as addedMod from "../src/push/transaction-added.js";
```

- [x] **Step 3: Add mock-reset entries to `beforeEach`**

The existing `beforeEach` (around L70-80) explicitly resets each mock. Add:
```ts
vi.mocked(anomalyMod.checkLargeChargeAndPush).mockReset();
vi.mocked(anomalyMod.checkLargeChargeAndPush).mockResolvedValue(undefined);
vi.mocked(addedMod.notifyTransactionAdded).mockReset();
vi.mocked(addedMod.notifyTransactionAdded).mockResolvedValue(undefined);
```

- [x] **Step 4: Add helper for seeding a Transaction + Allocation**

Add near other helpers (around L60 or top of describe block):
```ts
import { Prisma } from "@prisma/client";

async function seedTxWithCategory(opts: {
  workspaceId: string;
  txId: string;
  amount: number;
  merchant: string;
  categoryName: string;
}): Promise<void> {
  const cat = await prisma.category.create({
    data: { workspaceId: opts.workspaceId, name: opts.categoryName },
  });
  let bankAccount = await prisma.bankAccount.findFirst({
    where: { workspaceId: opts.workspaceId },
  });
  if (!bankAccount) {
    bankAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: opts.workspaceId,
        name: "Test Acct", type: "depository", currency: "CAD", status: "active",
      },
    });
  }
  await prisma.transaction.create({
    data: {
      id: opts.txId,
      workspaceId: opts.workspaceId,
      accountId: bankAccount.id,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: opts.merchant,
      merchantNormalized: opts.merchant.toLowerCase(),
      occurredAt: new Date(),
      pending: false,
      source: "plaid",
      rawData: {},
    },
  });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: opts.txId,
      categoryId: cat.id,
      amount: new Prisma.Decimal(opts.amount),
      source: "manual",
    },
  });
}
```

- [x] **Step 5: Add new describe block**

At the end of the file (after the existing 2 describe blocks), append:

```ts
describe("runDailyRefresh — push integration", () => {
  it("syncTransactions returns newTxIds → checkLargeChargeAndPush + notifyTransactionAdded called once each", async () => {
    const { wsId, itemId } = await seedActiveItem();
    const txId = `tx-${Date.now()}-1`;
    await seedTxWithCategory({ workspaceId: wsId, txId, amount: 50.5, merchant: "Coffee", categoryName: "Food" });
    vi.mocked(syncTransactions).mockResolvedValue({ added: 1, modified: 0, removed: 0, newTxIds: [txId] });

    await runDailyRefresh(testEnv());

    const anomalyCalls = vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls;
    expect(anomalyCalls).toHaveLength(1);
    expect(anomalyCalls[0]).toEqual([
      testEnv(),
      expect.objectContaining({ transactionId: txId, workspaceId: wsId, amount: 50.5, merchant: "coffee" }),
    ]);

    const notifyCalls = vi.mocked(addedMod.notifyTransactionAdded).mock.calls;
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual([
      testEnv(),
      expect.objectContaining({ workspaceId: wsId, merchant: "coffee", amount: 50.5, categoryName: "Food" }),
    ]);
    // No excludeUserId — Plaid-synced txs have no actor.
    expect(notifyCalls[0]?.[1]).not.toHaveProperty("excludeUserId");
  });

  it("syncTransactions returns no newTxIds → neither push helper called", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(testEnv());

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);
  });

  it("checkLargeChargeAndPush throws → notifyTransactionAdded NOT called (fail-stop within tx; pinned for future fix)", async () => {
    const { wsId, itemId } = await seedActiveItem();
    const txId = `tx-${Date.now()}-fail`;
    await seedTxWithCategory({ workspaceId: wsId, txId, amount: 50, merchant: "Z", categoryName: "X" });
    vi.mocked(syncTransactions).mockResolvedValue({ added: 1, modified: 0, removed: 0, newTxIds: [txId] });
    vi.mocked(anomalyMod.checkLargeChargeAndPush).mockRejectedValueOnce(new Error("boom"));

    // Outer per-item try/catch swallows.
    await expect(runDailyRefresh(testEnv())).resolves.toBeUndefined();

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(1);
    // Pinned: notify NOT called because anomaly throw aborted the for-loop iteration.
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);
  });
});
```

**Note**: `seedActiveItem` is an existing helper in the file — use as-is. If it doesn't return `{wsId, itemId}` in the expected shape, adjust the destructuring or add the missing return.

- [x] **Step 6: Run + typecheck + commit**

```bash
pnpm --filter @fina/api exec vitest run tests/cron.daily-refresh.test.ts
# Expected: all tests pass (existing N + 3 new)
pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "cron.daily-refresh" | head -5
# Expected: 0 errors
git add apps/api/tests/cron.daily-refresh.test.ts
git commit -m "test(api): daily-refresh push integration — 3 tests covering Plaid-sync→anomaly+notify

Closes Plan 1V T1. Pins fail-stop-within-tx semantics at L108-121 (see §7
follow-up for fix). Mocks anomaly + transaction-added via partial vi.mock.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: webhook-item.ts production fix + 5 push-integration tests (1 commit)

**Files:**
- Modify: `apps/api/src/plaid/webhook-item.ts` (per-recipient try/catch)
- Modify: `apps/api/tests/plaid.webhook.item.test.ts` (add module-level vi.mock + 5 new tests + 3-arg env cleanup for existing tests)

- [x] **Step 1: Read precedent + production**

Read `apps/api/src/plaid/webhook-item.ts` end-to-end. Note:
- L26: `role: { in: ["owner", "editor"] }` filter.
- L34-36: unguarded `for (...) { await sendBankReconnectPush(...) }` — TARGET of the fix.
- L58+: `dispatchItemEvent(item, body, env)` 3-arg signature.

Read existing `apps/api/tests/plaid.webhook.item.test.ts`. Note:
- 7 existing `it()` blocks at lines 28, 39, 47, 56, 64, 71, 78.
- Existing tests call `dispatchItemEvent(item, body)` (2-arg, missing env).

- [x] **Step 2: Apply production fix to `webhook-item.ts`**

Replace L34-36:
```ts
    for (const m of item.workspace.memberships) {
      await sendBankReconnectPush(env, m.userId, item.institutionName);
    }
```
With:
```ts
    // Per-recipient try/catch: a transient error on one member must NOT
    // drop the tail of the fan-out (per Plan 1U / 1V).
    for (const m of item.workspace.memberships) {
      try {
        await sendBankReconnectPush(env, m.userId, item.institutionName);
      } catch (err) {
        logError(
          { plaidItemId, recipientUserId: m.userId, err },
          "bank-reconnect push to recipient failed",
        );
      }
    }
```

- [x] **Step 3: Add module-level vi.mock + namespace import in test file**

After existing imports at the top, add:
```ts
import * as sendMod from "../src/push/send.js";

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return { ...actual, sendBankReconnectPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }) };
});
```

- [x] **Step 4: Add `afterEach` and `clearAllMocks`**

If the file doesn't already have `afterEach(vi.clearAllMocks)`, add it (per Plan 1M pattern for partial vi.mock).

- [x] **Step 5: Clean up existing tests to use 3-arg env**

For each of the 7 existing `dispatchItemEvent(item, body)` calls, update to `dispatchItemEvent(item, body, env)` where `env = testEnv()`. Add `const env = testEnv();` at file scope (after imports) if not present.

This is a precondition for Step 6's new tests to share consistent setup.

- [x] **Step 6: Add 5 new push-integration tests in a new describe block**

Append after the existing describe:

```ts
describe("dispatchItemEvent — push integration", () => {
  it("ITEM_LOGIN_REQUIRED → owner+editor push fan-out (viewer excluded)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds[0]!;
    const editorId = userIds[1]!;
    const item = await seedItem(wsId);

    await dispatchItemEvent(item, {
      webhook_code: "ERROR",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    }, env);

    const calls = vi.mocked(sendMod.sendBankReconnectPush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([ownerId, editorId].sort());

    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("PENDING_EXPIRATION → owner+editor push fan-out + status='relink_required'", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItem(wsId);

    await dispatchItemEvent(item, { webhook_code: "PENDING_EXPIRATION" }, env);

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(2);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("relink_required");
  });

  it("ERROR with non-LOGIN_REQUIRED → status='error' but NO push", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItem(wsId);

    await dispatchItemEvent(item, {
      webhook_code: "ERROR",
      error: { error_code: "ITEM_NOT_FOUND" },
    }, env);

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("ITEM_NOT_FOUND");
  });

  it("USER_PERMISSION_REVOKED → status='disconnected', NO push", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItem(wsId);

    await dispatchItemEvent(item, { webhook_code: "USER_PERMISSION_REVOKED" }, env);

    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(fresh.status).toBe("disconnected");
  });

  it("first push throws → caught + 2nd member STILL attempted (per-recipient containment)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const item = await seedItem(wsId);
    vi.mocked(sendMod.sendBankReconnectPush).mockRejectedValueOnce(new Error("boom"));

    await expect(
      dispatchItemEvent(item, {
        webhook_code: "ERROR",
        error: { error_code: "ITEM_LOGIN_REQUIRED" },
      }, env)
    ).resolves.toBeUndefined();

    // Per-recipient containment — both attempted.
    expect(vi.mocked(sendMod.sendBankReconnectPush)).toHaveBeenCalledTimes(2);
  });
});
```

**Helper `seedItem(wsId)`** — add near existing `seedActiveItem` style helper OR inline if not present:
```ts
import { Prisma } from "@prisma/client";

let itemCounter = 0;
async function seedItem(wsId: string) {
  itemCounter++;
  return await prisma.plaidItem.create({
    data: {
      id: `pi-${Date.now()}-${itemCounter}`,
      workspaceId: wsId,
      itemId: `plaid-item-${Date.now()}-${itemCounter}`,
      accessTokenCiphertext: Buffer.from("ciphertext-placeholder"),
      accessTokenIv: Buffer.from("iv-placeholder"),
      institutionId: "ins_test",
      institutionName: "Test Bank",
      status: "active",
    },
  });
}
```

Use `setupWorkspaceWithRoles` from `./helpers/factories.js` (Plan 1U).

- [x] **Step 7: Run + typecheck + commit**

```bash
pnpm --filter @fina/api exec vitest run tests/plaid.webhook.item.test.ts
# Expected: 7 existing + 5 new = 12 tests pass
pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "plaid.webhook.item" | head -5
pnpm --filter @fina/api exec tsc -p tsconfig.app.json --noEmit 2>&1 | grep "webhook-item" | head -5
# Both: 0 errors
git add apps/api/src/plaid/webhook-item.ts apps/api/tests/plaid.webhook.item.test.ts
git commit -m "fix(plaid)+test: webhook-item per-recipient try/catch + bank-reconnect fan-out tests (5 tests)

Closes Plan 1V T2 + completes Plan 1U pattern (4 of 4 fan-out helpers now
have per-recipient try/catch). Existing 7 tests cleaned up to 3-arg env
signature.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `cron.scheduled-spend-match.test.ts` (NEW, 3 tests, 1 commit)

**Files:**
- Create: `apps/api/tests/cron.scheduled-spend-match.test.ts`

- [ ] **Step 1: Read production**

Read `apps/api/src/cron/jobs/scheduled-spend-match.ts` (full file, 33 LOC). Note:
- L13: signature `(_env: Env): Promise<void>` (env unused).
- L14: `today = new Date()` shared across all workspace calls.
- L17-27: for-loop with per-workspace try/catch (containment correct).
- L28-31: aggregate log.

Read `apps/api/src/schedules/match.ts:matchScheduledSpends` signature: `(workspaceId, today) → Promise<{matched, unresolved}>`.

- [ ] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as matchMod from "../src/schedules/match.js";
import { runScheduledSpendMatch } from "../src/cron/jobs/scheduled-spend-match.js";

const env = testEnv();

vi.mock("../src/schedules/match.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/schedules/match.js")>();
  return {
    ...actual,
    matchScheduledSpends: vi.fn().mockResolvedValue({ matched: 0, unresolved: 0 }),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

let counter = 0;
async function createWorkspace(): Promise<string> {
  counter++;
  const ws = await prisma.workspace.create({
    data: { id: `ssm-w-${Date.now()}-${counter}`, name: `SSM WS ${counter}`, currency: "CAD" },
  });
  return ws.id;
}

describe("runScheduledSpendMatch", () => {
  it("no workspaces → matchScheduledSpends not called", async () => {
    await runScheduledSpendMatch(env);
    expect(vi.mocked(matchMod.matchScheduledSpends)).toHaveBeenCalledTimes(0);
  });

  it("1 workspace → called once with (wsId, today: Date)", async () => {
    const wsId = await createWorkspace();
    vi.mocked(matchMod.matchScheduledSpends).mockResolvedValue({ matched: 3, unresolved: 1 });

    await runScheduledSpendMatch(env);

    const calls = vi.mocked(matchMod.matchScheduledSpends).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(wsId);
    expect(calls[0]?.[1]).toBeInstanceOf(Date);
  });

  it("first workspace throws → second STILL called (per-workspace containment)", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    vi.mocked(matchMod.matchScheduledSpends)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ matched: 0, unresolved: 0 });

    await expect(runScheduledSpendMatch(env)).resolves.toBeUndefined();

    expect(vi.mocked(matchMod.matchScheduledSpends)).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 3: Run + typecheck + commit**

```bash
pnpm --filter @fina/api exec vitest run tests/cron.scheduled-spend-match.test.ts
# Expected: 3 tests pass
pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "scheduled-spend-match" | head -5
# Expected: 0 errors

git add apps/api/tests/cron.scheduled-spend-match.test.ts
git commit -m "test(api): cron/scheduled-spend-match — 3 tests covering workspace iteration + error containment

Closes Plan 1V T3. Verifies per-workspace try/catch contains errors; iteration
continues. Partial vi.mock of schedules/match.js.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
