# Plan 1V-plaid-integration-tests Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1U (fail-stop fix + 7 wrappers payload). Closes Plan 1L-1U §7 follow-ups for Plaid integration paths.

## 1. Goal & scope

Close 3 remaining integration gaps in the push subsystem identified by Plan 1Q+1S R2 reviews:

1. **`daily-refresh.ts:108-120`** — Plaid-sync→anomaly + notifyTransactionAdded fire-and-forget. Plan 1M tested anomaly direct, Plan 1S tested HTTP route, but NOT the cron-sync path.
2. **`webhook-item.ts:35`** — ITEM_LOGIN_REQUIRED + PENDING_EXPIRATION webhooks → `sendBankReconnectPush` fan-out to owner+editor. Existing tests cover status updates but NOT the push side-effect.
3. **`scheduled-spend-match.ts`** — cron iterates workspaces calling `matchScheduledSpends`. Registered in `cron.scheduler.test.ts` but cron logic itself untested.

Add **11 tests** across 3 commits.

**Out of scope:**
- `matchScheduledSpends` internal algorithm — covered indirectly by `chat.tools.scheduled-spends.test.ts` (lists endpoint exercises same query).
- Plaid client SDK testing (`apps/api/src/plaid/client.ts`) — wraps Plaid SDK; mock-only is unproductive.
- Plaid webhook signature verification (`webhook-jwks.ts`) — separate plan.
- `daily-refresh.ts` Step 0 trial-expiry cleanup — already tested (existing tests).
- Per-tx error containment in daily-refresh — uses outer try/catch around each item; the per-recipient containment fixed in Plan 1U applies to the wrappers themselves.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. Pure test addition.

## 3. Production change

**없음.** No edits to source code.

## 4. Tasks

### T1 — `cron.daily-refresh.test.ts` extension (3 tests)

**Files:**
- Modify: `apps/api/tests/cron.daily-refresh.test.ts` (append new describe block + 3 partial vi.mocks)

The existing file mocks: `plaid`, `../src/plaid/sync.js`, `../src/categorize/service.js`, `../src/cron/tier-gate.js`, `../src/plaid/items.js`. Add:
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

Add new describe block "runDailyRefresh — push integration" with 3 tests:

| # | Setup | Expected |
|---|---|---|
| 1 | 1 PlaidItem + active workspace. `syncTransactions` resolves with `newTxIds: [txId]`. Seed the actual Transaction row + 1 TransactionAllocation. | After `runDailyRefresh(env)`: `vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls[0]` = `[env, {transactionId, workspaceId, amount, merchant}]`. Same for `notifyTransactionAdded` with `categoryName` from the allocation. |
| 2 | 1 PlaidItem. `syncTransactions` resolves with `newTxIds: []` (no new txs). | Neither push helper called. |
| 3 | 1 PlaidItem + 1 new tx (seeded). `anomalyMod.checkLargeChargeAndPush.mockRejectedValueOnce(new Error("boom"))`. | `runDailyRefresh` does NOT throw (outer per-item catch swallows). `notifyTransactionAdded` STILL called (the awaits are sequential — checkLargeChargeAndPush at L108, notify at L116; throw on L108 means L116 never runs UNLESS we wrap each separately). Actual production behavior per `daily-refresh.ts:108-120`: NO inner try/catch between the two calls, so the throw on anomaly halts the loop iteration. `notifyTransactionAdded` NOT called in this case. Test pins this fail-stop-within-tx semantics. |

**Note on test 3**: production iteration logic at lines 105-126 wraps the per-newTxId block in the outer per-item try/catch (lines 95-130). A throw on the anomaly call propagates UP and exits the for loop, falling into the outer catch at L130. So `notifyTransactionAdded` is NOT called. Test pins this and documents as a potential future improvement.

**Commit:** `test(api): daily-refresh push integration — 3 tests covering Plaid-sync→anomaly+notify`

### T2 — `plaid.webhook.item.test.ts` extension (4 tests)

**Files:**
- Modify: `apps/api/tests/plaid.webhook.item.test.ts`

Add at top:
```ts
vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return { ...actual, sendBankReconnectPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }) };
});
```

Then new describe block "dispatchItemEvent — push integration":

| # | Setup | Webhook code | Expected |
|---|---|---|---|
| 1 | PlaidItem in workspace with owner+editor+viewer. | `ERROR` with `error_code: "ITEM_LOGIN_REQUIRED"` | Status updated to `"error"` + errorCode `"ITEM_LOGIN_REQUIRED"`. `sendBankReconnectPush` called 2 times (owner + editor, NOT viewer). `calls.map(c => c[1]).sort()` = `[ownerId, editorId].sort()`. Each call's args = `(env, userId, institutionName)`. |
| 2 | Same setup. | `PENDING_EXPIRATION` | Status `"relink_required"`. `sendBankReconnectPush` called 2 times (owner + editor). |
| 3 | Same setup. | `ERROR` with `error_code: "ITEM_NOT_FOUND"` (any non-LOGIN_REQUIRED) | Status `"error"`. `sendBankReconnectPush` called 0 times — `notifyReconnectNeeded` skipped (production line 64). |
| 4 | Same setup. | `USER_PERMISSION_REVOKED` | Status `"disconnected"`. `sendBankReconnectPush` called 0 times. |

Reuse the existing test file's setup helpers (seed PlaidItem with workspace). Add owner/editor/viewer memberships via existing or new helper.

**Commit:** `test(api): plaid webhook ITEM → bank-reconnect push fan-out (4 tests)`

### T3 — `cron.scheduled-spend-match.test.ts` (new, 4 tests)

**Files:**
- Create: `apps/api/tests/cron.scheduled-spend-match.test.ts`

**Mock pattern**: partial vi.mock of `../src/schedules/match.js` to stub `matchScheduledSpends`. Real DB for workspace setup.

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as matchMod from "../src/schedules/match.js";

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
```

**4 test scenarios:**

| # | Setup | Mocked `matchScheduledSpends` | Expected |
|---|---|---|---|
| 1 | No workspaces | — | `matchScheduledSpends` called 0 times. `runScheduledSpendMatch(env)` resolves without error. |
| 2 | 1 workspace (no membership setup needed) | `mockResolvedValue({matched: 3, unresolved: 1})` | Called once. `calls[0]` = `[wsId, Date]` (today). |
| 3 | 2 workspaces. `mockRejectedValueOnce(new Error("boom")).mockResolvedValue({matched: 0, unresolved: 0})` (first workspace throws, second succeeds). | First throws, second resolves. | Called 2 times. Cron resolves without throwing (per-workspace try/catch swallows). |
| 4 | 2 workspaces, both resolve. Verify the `today` arg is the same Date instance across both calls. | `mockResolvedValue` | `calls[0][1]` deep-equals `calls[1][1]`. Single `today = new Date()` is shared per `scheduled-spend-match.ts:13`. |

**Commit:** `test(api): cron/scheduled-spend-match — 4 tests covering workspace iteration + error containment`

## 5. Risks

| Risk | Mitigation |
|---|---|
| T1 setup complexity — need a real PlaidItem + Transaction + Allocation seeded for syncTransactions's `newTxIds` to point at real data. | Helper creates the row directly via prisma; syncTransactions mock returns `{newTxIds: [txId]}`. |
| T1 test 3 pins fail-stop semantics within a single tx — could be a future fix (per-tx-side-effect containment). | Documented in spec §7 as follow-up. |
| T2 `notifyReconnectNeeded` outer try/catch swallows errors — test 1+2 must NOT mock push to throw. Default factory mock `{sent: 0, failed: 0}` resolves cleanly. | Spec is explicit. |
| T2 viewer exclusion via `role: { in: ["owner", "editor"] }` at production line 26. | Tests 1+2 explicitly assert viewerId NOT in `calls.map(c => c[1])`. |
| T3 `today = new Date()` — Date.now() during test. Don't need fake timers for assertions; test 4 just checks args[1] deep-equality across calls. | No vi.useFakeTimers needed. |
| T3 `withWorkspaceLock` in matchScheduledSpends — mocked, so lock not exercised. Acceptable. | Out of scope. |
| Cross-file mock leakage in singleFork — T1's mock of `anomaly.js` + `transaction-added.js` is file-scoped; T2's mock of `send.js` is file-scoped; T3's mock of `schedules/match.js` is file-scoped. | Vitest hoists vi.mock per-file. Safe. |
| T1 existing tests in cron.daily-refresh.test.ts — adding 2 new module-level `vi.mock` calls. Existing tests must still pass. | The new mocks default to `mockResolvedValue` so they're inert when not asserted. Existing tests don't call push paths. |
| Helper duplication — T2 may need a `setupWorkspaceWithRoles`-style helper similar to factories.ts. T2 stays inline OR imports factories.ts (Plan 1U). | Use factories.ts where available (per Plan 1U). |

## 6. Success criteria

- T1: 3 new tests pass. Existing daily-refresh tests still pass.
- T2: 4 new tests pass. Existing webhook-item tests still pass.
- T3: 4 new tests pass.
- Full `@fina/api` suite regression: 0 new fails.
- Typecheck baseline unchanged.
- 3 commits, test-only.

## 7. Follow-ups (별도 plans)

- **Per-tx side-effect containment in daily-refresh** — currently a throw on `checkLargeChargeAndPush` halts subsequent `notifyTransactionAdded` for the same tx (and any further txs in the for-loop fall through to outer catch). Consider per-side-effect try/catch like Plan 1U fixed in the wrappers. Test 3 pins current behavior.
- **`matchScheduledSpends` internal algorithm direct unit tests** — owner-tz handling, dedup logic, candidate ordering. Plan 1W candidate.
- **`webhook-jwks.ts` signature verification** — security-critical, separate plan.
- **`plaid/items.ts` / `plaid/client.ts`** direct unit tests — wrappers over Plaid SDK; mock-only is low value.
