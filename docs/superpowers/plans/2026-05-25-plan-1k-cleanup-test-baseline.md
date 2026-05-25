# Plan 1K-cleanup-test-baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore green baseline by fixing 6 stale-assumption test failures (5 in transactions.create-manual, 1 in recurring.routes) + add regression-defense test for the already-correct suggest-split Pro-gate.

**Architecture:** 3 task-commits, one per test file. T1 rewrites 5 manual-tx tests to assert behavioral contracts (reuse / ghost rejection / race collapse) instead of brittle name filtering. T2 deletes a wishful Pro-gate assertion that production never enforced. T3 creates a new `budget-plans.routes.test.ts` with a single Pro-gate regression test. No schema / migration / `@fina/shared` / production changes.

**Tech Stack:** Vitest singleFork (real Postgres on port 5433), Prisma 5.22.

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-25-plan-1k-cleanup-test-baseline-design.md` (HEAD `3d73946`). Authoritative.
- **Root causes:**
  - 5 manual-tx failures: commit `d67da12 feat(api+mobile): seed default accounts on bootstrap` added auto-seed of 5 default accounts (Cash/Debit/Checking/Savings/Credit) on workspace creation. Tests assumed clean slate.
  - 1 recurring failure: wishful assertion expecting Pro-gate that production never enforced. User decision: recurring is free for all tiers, delete the test.
  - 0 budget-plans coverage on the existing Pro-gate at `budget-plans.ts:175`.
- **Test infrastructure reused:**
  - `signUpAndGetCookie(app, { email })` returns `{ userId, email, cookie }`.
  - `getOwnerWorkspaceId(userId)` returns the user's owner workspace ID (created by bootstrap hook).
  - `truncateAll()` in beforeEach.
  - `testEnv()` for `buildApp(env)`.
- **No worktree required by plan size**, but per established workflow we'll use one for clean isolation.

## File map

| File | Action | Task |
|---|---|---|
| `apps/api/tests/transactions.create-manual.test.ts` | Modify — fix 5 tests | T1 |
| `apps/api/tests/recurring.routes.test.ts` | Modify — delete 1 test + add comment | T2 |
| `apps/api/tests/budget-plans.routes.test.ts` | Create — 1 Pro-gate test | T3 |

---

## Task 1: `transactions.create-manual.test.ts` — fix 5 stale assertions

**Goal:** Tests #1, #2, #3, #4, #5 fail because bootstrap now seeds 5 default accounts. Rewrite to verify behavioral contracts (reuse, ghost rejection, currency inheritance, race collapse) instead of seed-naming.

**Files:**
- Modify: `apps/api/tests/transactions.create-manual.test.ts`

- [ ] **Step 1.1: Confirm baseline failures**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts 2>&1 | tail -10
```

Expected: 5 fail / 16 pass / 21 total. Failing tests:
- "auto-creates a Cash manual account on first call"
- "reuses the existing manual account on second call"
- "Transaction.currency inherits Workspace.currency"
- "does NOT reuse a ghost ex-Plaid account..."
- "race: two concurrent first-time calls produce exactly one Cash account"

- [ ] **Step 1.2: Fix test #1 — "auto-creates a Cash manual account on first call"**

In `apps/api/tests/transactions.create-manual.test.ts`, locate the test body (around line 29-43). Replace the post-call assertions:

```ts
// BEFORE — broken (5 accounts, not 1):
//   const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
//   expect(accounts).toHaveLength(1);
//   expect(accounts[0]!.name).toBe("Cash");
//   expect(accounts[0]!.type).toBe("depository");
//   expect(accounts[0]!.currency).toBe("CAD");
//
// AFTER — assert behavioral contract:
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
```

Replace the original `const accounts = ...` through `expect(accounts[0]!.currency)...` block (~5 lines) with the AFTER block.

- [ ] **Step 1.3: Fix test #2 — "reuses the existing manual account on second call"**

Locate around line 45-60. Replace the post-call assertions:

```ts
// BEFORE — broken:
//   const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
//   expect(accounts).toHaveLength(1);
//   const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
//   expect(txs).toHaveLength(2);
//   expect(new Set(txs.map((t) => t.accountId))).toEqual(new Set([accounts[0]!.id]));
//
// AFTER — capture before-count BEFORE first service call.
// (Reorganize the test: count manualBefore right after setupEditor, run
// the 2 service calls, then count manualAfter and the txs.)
```

Full restructured test body:

```ts
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
```

Replace the entire `it("reuses the existing manual account on second call", ...)` block with this.

- [ ] **Step 1.4: Fix test #3 — "Transaction.currency inherits Workspace.currency"**

Locate around line 187-197. Replace the entire test body to deleteMany seeds + set workspace USD before service:

```ts
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
```

Replace the entire `it("Transaction.currency inherits Workspace.currency", ...)` block.

- [ ] **Step 1.5: Fix test #4 — "does NOT reuse a ghost ex-Plaid account..."**

Locate around line 199-222. Replace the post-call assertions:

```ts
// BEFORE — broken:
//   const cashAccts = await prisma.bankAccount.findMany({
//     where: { workspaceId: wsId, plaidAccountId: null, archivedAt: null },
//   });
//   expect(cashAccts).toHaveLength(1);
//   expect(cashAccts[0]!.name).toBe("Cash");
//   expect(result.transaction.accountId).toBe(cashAccts[0]!.id);
//
// AFTER — assert ghost was NOT picked, and the picked row is active+non-Plaid:
const ghostId = (await prisma.bankAccount.findFirstOrThrow({
  where: { workspaceId: wsId, plaidAccountId: { not: null } },
})).id;
expect(result.transaction.accountId).not.toBe(ghostId);
const pickedAccount = await prisma.bankAccount.findUniqueOrThrow({
  where: { id: result.transaction.accountId },
});
expect(pickedAccount.plaidAccountId).toBeNull();
expect(pickedAccount.archivedAt).toBeNull();
```

Replace from `const cashAccts = ...` through `expect(result.transaction.accountId).toBe(cashAccts[0]!.id);` (the block) with the AFTER snippet.

- [ ] **Step 1.6: Fix test #5 — "race: two concurrent first-time calls produce exactly one Cash account"**

Locate around line 224-235. Replace the post-call assertions:

```ts
// BEFORE — broken:
//   const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
//   expect(accounts).toHaveLength(1);
//   expect(r1.transaction.accountId).toBe(accounts[0]!.id);
//   expect(r2.transaction.accountId).toBe(accounts[0]!.id);
//
// AFTER — race semantics: both calls collapsed onto same account:
expect(r1.transaction.accountId).toBe(r2.transaction.accountId);
// And it's an active, non-Plaid account from the bootstrap seed pool.
const picked = await prisma.bankAccount.findUniqueOrThrow({
  where: { id: r1.transaction.accountId },
});
expect(picked.plaidItemId).toBeNull();
expect(picked.plaidAccountId).toBeNull();
expect(picked.archivedAt).toBeNull();
```

Replace from `const accounts = ...` through `expect(r2.transaction.accountId).toBe(accounts[0]!.id);` with the AFTER snippet.

- [ ] **Step 1.7: Run the 5 fixed tests + verify all 21 green**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts 2>&1 | tail -8
```

Expected: 21/21 pass.

- [ ] **Step 1.8: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same as pre-fix baseline (~10 pre-existing errors; should NOT increase).

- [ ] **Step 1.9: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/transactions.create-manual.test.ts && git commit -m "fix(test): manual-tx assertions adapt to default-account seed

Plan 1K-cleanup-test-baseline. Commit d67da12 added bootstrap-seeded
default accounts (5 manual rows: Cash/Debit/Checking/Savings/Credit)
but 5 tests in transactions.create-manual still asserted a clean-
slate manual account count of 1.

Rewrote the 5 broken assertions as behavioral contracts:
- #1 (auto-creates Cash on first call): service picked an active
  manual row; Cash is among the seeded set
- #2 (reuses on second call): both txs collapse to one accountId;
  before/after manual-account counts match (no silent duplicate)
- #3 (currency inherits Workspace.currency): deleteMany seeds +
  set workspace USD → service creates fresh Cash with USD,
  exercising the inherit code path
- #4 (ghost ex-Plaid not reused): assert picked account is not the
  ghost id; picked is active + non-Plaid
- #5 (race two concurrent first-time): both calls collapse to one
  accountId, that account is active + non-Plaid

No production code touched. seed.ts behavior is correct; tests now
reflect post-seed reality."
```

---

## Task 2: `recurring.routes.test.ts` — delete wishful Pro-gate test

**Goal:** The test "POST 402 upgrade_required when trial expired (Free tier)" assumed Pro-gating that production never enforced. User decision: recurring is free for all tiers. Delete the test + leave a comment for future readers.

**Files:**
- Modify: `apps/api/tests/recurring.routes.test.ts`

- [ ] **Step 2.1: Confirm baseline failure**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/recurring.routes.test.ts -t "trial expired" 2>&1 | tail -8
```

Expected: 1 fail. Error: `expected 201 to be 402`.

- [ ] **Step 2.2: Locate the test block**

Open `apps/api/tests/recurring.routes.test.ts`. Find `it("POST 402 upgrade_required when trial expired (Free tier)", ...)` — it starts around line 99 and ends with `});` after `expect(res.json().error).toBe("upgrade_required");`.

- [ ] **Step 2.3: Replace the test block with a comment**

Delete the entire `it(...)` block (typically 20-25 lines including opening and closing). In its place, add:

```ts
// Recurring is free for all tiers (Plan 1K-cleanup-test-baseline 2026-05-25
// decision). No tier gate on POST /workspaces/:id/recurring. The previous
// '402 upgrade_required when trial expired (Free tier)' test was a wishful
// assertion against production that never had the gate. Inline trial-expiry
// fixture (no shared helper) removed alongside the test.
```

- [ ] **Step 2.4: Run recurring test file**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/recurring.routes.test.ts 2>&1 | tail -6
```

Expected: all tests in the file pass (one fewer than before).

- [ ] **Step 2.5: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/recurring.routes.test.ts && git commit -m "fix(test): recurring is free for all tiers — drop wishful Pro-gate test

Plan 1K-cleanup-test-baseline. The 'POST 402 upgrade_required when
trial expired (Free tier)' test asserted production gated recurring
behind Pro tier. Reality check: POST /workspaces/:id/recurring has
no tier check in apps/api/src/routes/recurring.ts. User confirmed
recurring is free for all tiers (only Plaid limits and AI-features
like budget-plans/suggest-split are Pro-gated).

Removed the test + inline trial-expiry fixture. 1-line comment
explains the decision so future readers don't re-introduce."
```

---

## Task 3: `budget-plans.routes.test.ts` — new Pro-gate regression test

**Goal:** suggest-split has a correct Pro-gate at `budget-plans.ts:175` but zero test coverage. Add a single Free-tier regression test so future regressions surface.

**Files:**
- Create: `apps/api/tests/budget-plans.routes.test.ts`

- [ ] **Step 3.1: Create the new test file**

Create `apps/api/tests/budget-plans.routes.test.ts` with the following content:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe("POST /workspaces/:id/budget-plans/suggest-split", () => {
  it("402 upgrade_required for Free tier (trial expired + consumed)", async () => {
    const u = await signUpAndGetCookie(app, { email: `bp-free-${Date.now()}@t.co` });
    const wsId = await getOwnerWorkspaceId(u.userId);
    // Expire trial → Free tier.
    await prisma.user.update({
      where: { id: u.userId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        trialConsumed: true,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budget-plans/suggest-split`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { totalAmount: 1000 },
    });
    expect(res.statusCode).toBe(402);
    // Strict body shape — no extra payload alongside the error code.
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });
});
```

- [ ] **Step 3.2: Run the new test**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/budget-plans.routes.test.ts 2>&1 | tail -6
```

Expected: 1 test pass.

- [ ] **Step 3.3: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same as baseline (no new errors from the new file).

- [ ] **Step 3.4: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/budget-plans.routes.test.ts && git commit -m "test(api): suggest-split Pro-gate regression defense

Plan 1K-cleanup-test-baseline. budget-plans.ts:175 has been Pro-only
since the route was added, but had zero test coverage. User asked
during brainstorm to confirm the gate works — confirmed by reading
production code; adding this test so a future refactor that removes
the gate surfaces immediately.

Single test: Free tier (trial expired + consumed) → 402
upgrade_required + strict body { error: 'upgrade_required' }.

Full coverage for suggest-split (other branches, success path with
Pro user) deferred to a separate plan."
```

---

## Final verification

After all 3 task-commits land:

- [ ] **Full API suite regression**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -8
```

Expected: 0 failures (down from 6).

- [ ] **3-commit chain check**

```bash
cd /home/cwsbr/personal/fina && git log --oneline -4
```

Expected: 3 fresh commits in order T1 → T2 → T3 (or T1/T2/T3 in any order — independent).

- [ ] **Verify no other files touched**

```bash
cd /home/cwsbr/personal/fina && git diff main~3 --stat
```

Expected: exactly 3 test files changed (2 modified, 1 new). No schema, migration, source, or @fina/shared changes.
