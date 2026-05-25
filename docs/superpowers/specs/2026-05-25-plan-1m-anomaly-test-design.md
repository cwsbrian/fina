# Plan 1M-anomaly-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1L-goals-test-and-tier-gate (shipped `3e07b72`). Continues the test-coverage backfill for previously-uncovered push helpers.

## 1. Goal & scope

`apps/api/src/push/anomaly.ts` exports one function `checkLargeChargeAndPush(env, args)` — 102 lines, 8 distinct branches — and currently has **zero test coverage**. Called from `apps/api/src/routes/transactions.ts:327` (POST manual transaction, fire-and-forget) and `apps/api/src/cron/jobs/daily-refresh.ts:108` (post-Plaid sync, awaited).

This plan adds **direct function-call tests** (no HTTP layer) covering all 8 branches + push fan-out semantics + mock signature assertion.

**Test breakdown (8 tests):**

| # | Scenario | Expected |
|---|---|---|
| 1 | `amount < MIN_AMOUNT` ($30) | early return, no push |
| 2 | Transaction has 0 allocations (uncategorized) | early return, no push |
| 3 | Cold-start (no 90d history) + `amount < COLD_START_AMOUNT` ($150) | not unusual, no push |
| 4 | Cold-start + `amount ≥ $150` | unusual, 1 push to owner |
| 5 | With history, `amount < avg × 2.5` | not unusual, no push |
| 6 | With history, `amount ≥ avg × 2.5` BUT `amount < MIN × 2` ($60) | not unusual (extra guard against tiny-avg false positives), no push |
| 7 | With history, both conditions met | unusual, 1 push to owner + verify all 5 args forwarded |
| 8 | Fan-out: workspace with owner+editor+viewer, unusual tx | 2 pushes (skip viewer per `role: { in: ["owner", "editor"] }`) |

**Out of scope:**
- HTTP integration via POST /transactions/manual — covered by `transactions.create-manual.test.ts`.
- `daily-refresh` cron integration — separate plan.
- Other `sendXxxPush` wrappers (`sendBankReconnect`, `sendTrialExpiring`, `sendGoalMilestone`, `sendTransactionAdded`, `sendProductUpdate`, `sendWorkspaceInvite`) — separate plan.
- Error path (DB connection failure / Prisma exception) — mechanical try/catch + logError; not feasibly testable without contrived spy that violates `vi.spyOn(prisma, ...)` ban.

## 2. Shared library touchpoints

**없음.** `MIN_AMOUNT`, `MULTIPLIER`, `COLD_START_AMOUNT` 상수는 `apps/api/src/push/anomaly.ts` 모듈-내부 const. Mobile UI에서 사용 안 함. `@fina/shared` 변경 0. 새 LogContext 필드 0 (기존 `transactionId`, `err` 재사용).

## 3. Production change

**없음.** anomaly.ts production code 변경 X. 순수 test addition.

## 4. Test file — `apps/api/tests/push.anomaly.test.ts` (new)

Pattern follows `apps/api/tests/push.send.test.ts` + `goals.routes.test.ts` precedents:
- Partial `vi.mock` of `../src/push/send.js` so `sendLargeChargePush` becomes a `vi.fn().mockResolvedValue(undefined)`. Other exports preserved via `...actual`.
- `afterEach(() => vi.clearAllMocks())` — clears call history, preserves mock impl. NOT `restoreAllMocks` (would restore the real Expo SDK call path).
- Real Postgres :5433 + `truncateAll` in `beforeEach`. No `vi.spyOn(prisma, ...)`.
- Direct call to `checkLargeChargeAndPush(env, args)` — no HTTP.

### File header + helpers

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendLargeChargePush: vi.fn().mockResolvedValue(undefined),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

// Helpers — local; not exported.

let userCounter = 0;
let workspaceCounter = 0;

async function createUserMinimal(): Promise<string> {
  userCounter++;
  const id = `u-anom-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: { id, email: `${id}@t.co`, name: `Anom User ${userCounter}` },
  });
  return id;
}

async function setupWorkspaceWithMembers(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{ wsId: string; members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }> }> {
  workspaceCounter++;
  const ws = await prisma.workspace.create({
    data: { id: `w-anom-${Date.now()}-${workspaceCounter}`, name: `Anom WS ${workspaceCounter}`, currency: "CAD" },
  });
  const members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }> = [];
  for (const role of roles) {
    const userId = await createUserMinimal();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    members.push({ userId, role });
  }
  return { wsId: ws.id, members };
}

async function seedCategory(wsId: string, name: string): Promise<string> {
  const cat = await prisma.category.create({
    data: { workspaceId: wsId, name },
  });
  return cat.id;
}

async function seedAccount(wsId: string): Promise<string> {
  const a = await prisma.bankAccount.create({
    data: {
      workspaceId: wsId,
      plaidItemId: null,
      plaidAccountId: null,
      name: "Test",
      type: "depository",
      currency: "CAD",
      status: "active",
    },
  });
  return a.id;
}

async function seedTransactionWithCategory(opts: {
  wsId: string;
  accountId: string;
  categoryId: string | null;
  amount: number;
  merchant?: string | null;
  occurredAt?: Date;
}): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: opts.wsId,
      accountId: opts.accountId,
      amount: new Prisma.Decimal(opts.amount),
      currency: "CAD",
      merchantRaw: opts.merchant ?? "Test Merchant",
      merchantNormalized: (opts.merchant ?? "test merchant").toLowerCase(),
      occurredAt: opts.occurredAt ?? new Date(),
      pending: false,
      source: "manual",
      rawData: {},  // Required Json field; empty for tests (no Plaid payload).
    },
  });
  if (opts.categoryId !== null) {
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId: opts.categoryId,
        amount: new Prisma.Decimal(opts.amount),
        source: "manual",
      },
    });
  }
  return tx.id;
}
```

### 8 test bodies

(Full code spelled out in plan §3.2-§3.9; here in spec only the assertion shape per test.)

**Test 1 (`amount < MIN_AMOUNT`)**:
```ts
import("../src/push/anomaly.js").then(({ checkLargeChargeAndPush }) => ...);
// Build minimal workspace + tx with amount=25.
await checkLargeChargeAndPush(env, { transactionId: txId, workspaceId: wsId, amount: 25, merchant: "Coffee" });
expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
```

**Test 2 (uncategorized — no allocation row)**:
- Seed transaction with `categoryId: null` → helper skips `transactionAllocation.create` → no allocation row in DB.
- anomaly.ts:36-46 `findUnique` returns `tx.allocations = []` → `allocations[0]` is `undefined` → `allocation?.categoryId` undefined → return early.
- Call with `amount: 200` (would be unusual if categorized).
- `expect(calls.length).toBe(0)`.
- Note: this covers the "no allocation row" shape. The alternate "row exists with categoryId = null" shape can't occur in production (TransactionAllocation.categoryId is non-null per schema), so 1 test covers the branch.

**Test 3 (cold-start < $150)**:
- Workspace + owner + 1 category. New tx amount=100, no prior allocations.
- `expect(calls.length).toBe(0)`.

**Test 4 (cold-start ≥ $150)**:
- Same setup. New tx amount=200.
- `expect(calls.length).toBe(1)`.

**Test 5 (history, < avg×2.5)**:
- Seed 90d history: 5 prior transactions at $50 each (avg $50). New tx amount=80.
- 80 < 50×2.5=125 → not unusual.
- `expect(calls.length).toBe(0)`.

**Test 6 (history, < MIN×2 extra guard)**:
- Seed history at $5 avg (5 prior transactions at $5 each). New tx amount=40.
- 40 ≥ 5×2.5=12.5 BUT 40 < 30×2=60 → not unusual.
- `expect(calls.length).toBe(0)`.

**Test 7 (history, both conditions + arg assertion)**:
- Seed history at $40 avg (5 prior at $40). New tx amount=200, merchant="Starbucks", category="Food".
- 200 ≥ 40×2.5=100 AND 200 ≥ 60 → unusual.
- `expect(calls.length).toBe(1)`.
- `expect(calls[0]).toEqual([env, ownerUserId, "Starbucks", "200.00", "Food"])`.

**Test 8 (fan-out: owner + editor + viewer)**:
- 3 members. Unusual tx (cold-start $200 for simplicity).
- `expect(calls.length).toBe(2)`.
- `calls.map(c => c[1]).sort()` matches `[ownerId, editorId].sort()` (viewer excluded).

### Total: 8 tests, ~250-300 LOC.

## 5. Risks

| Risk | Mitigation |
|---|---|
| `prisma.user.create` requires fields not in our minimal helper | Better-Auth schema: `{ id (cuid default), email, name (nullable), emailVerified (default false), image (nullable), createdAt/updatedAt (defaults) }`. Minimal `{ id, email, name }` passes — verified per precedent `chat.tools.get-cashflow-summary.test.ts:13`. |
| `prisma.transaction.create` requires `rawData: Json` field (no default) | Helper passes `rawData: {}` empty object. Verified per precedent `plaid.sync.unified-alloc.test.ts:38`. |
| `prisma.bankAccount.create` field shape | Real account creation goes through workspaces/bootstrap.ts seedDefaultAccounts. Our helper mimics. Verified required fields. |
| `prisma.transactionAllocation.create` requires Transaction FK + Category FK both valid | Verified via setup order. |
| Email uniqueness across tests in same suite | `Date.now()` + `userCounter` global ensures uniqueness. |
| `sendLargeChargePush` mock signature mismatch | Real signature: `(env, userId, merchant, amountStr, categoryName)` — 5 args. Mock assertion in test #7 verifies. |
| Multi-allocation transaction edge case (production `take: 1` order undefined) | Test creates exactly 1 allocation per transaction. Multi-alloc out of scope. |

## 6. Success criteria

- 8 new tests pass, 0 fail.
- Full API suite regression: 0 fail (or known baseline flakes only).
- Typecheck baseline unchanged.
- 1 commit (single test file).
- No production code changes.

## 7. Follow-ups (별도 plans)

- Other `sendXxxPush` wrappers in `push/send.ts` (7 untested: sendBankReconnect, sendTrialExpiring, sendGoalMilestone, sendTransactionAdded, sendProductUpdate, sendWorkspaceInvite, sendGoalMilestonePush etc.).
- `daily-refresh` cron tests that exercise the anomaly call path (verify Plaid sync → anomaly fan-out chain).
- HTTP integration: extend `transactions.create-manual.test.ts` to assert anomaly call from POST /transactions/manual.
