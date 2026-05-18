# Plan 1C-currency-unify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Workspace.currency` the sole source of truth for amount math. Drop `Transaction.currency` and `RecurringExpense.currency`. Keep `BankAccount.currency` (Plaid's per-account truth). Add `PATCH /workspaces/:id/currency` (owner+, 409 if any amount-bearing row exists). Plaid item exchange rejects currency mismatch with `itemRemove` cleanup. All amount-row writers serialize per-workspace via a shared `withWorkspaceLock` helper.

**Architecture:**
1. Shared helper `apps/api/src/locks/workspace.ts` wraps `prisma.$transaction` and runs `pg_advisory_xact_lock(hashtext(workspaceId))` as the first SQL inside the callback. Every amount-row writer uses this helper instead of inlining the lock SQL.
2. Migration drops 2 columns. `BankAccount.currency` stays as Plaid's record per account.
3. Read-side responses pull `currency` from `workspace.currency` (one lookup per request) for Transaction-style payloads; BankAccount responses continue reading `a.currency` directly.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres (`pg_advisory_xact_lock`), Vitest (singleFork), Zod.

**Spec:** [`docs/superpowers/specs/2026-05-18-plan-1c-currency-unify-design.md`](../specs/2026-05-18-plan-1c-currency-unify-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/locks/workspace.ts` | NEW. `withWorkspaceLock(workspaceId, callback)` — first-statement advisory lock + tx wrapper |
| `apps/api/prisma/schema.prisma` | Drop `Transaction.currency`, `RecurringExpense.currency`. Keep `BankAccount.currency`. |
| `apps/api/prisma/migrations/<ts>_drop_per_row_currency/migration.sql` | DDL: 2 DROP COLUMN |
| `apps/api/src/transactions/create-manual.ts` | Migrate to `withWorkspaceLock`. Drop Transaction.currency write. Keep BankAccount.currency write on Cash auto-create. |
| `apps/api/src/recurring/service.ts` | Wrap upsert in `withWorkspaceLock`. Drop `currency` arg from `AddRecurringInput`. Drop column write. Read responses fetch workspace.currency. |
| `apps/api/src/routes/recurring.ts` | Remove `currency` Zod field |
| `apps/api/src/budgets/service.ts` | Wrap `setBudgetService` upsert in `withWorkspaceLock`. Drop `currency: "CAD"` filter from `compareSpendingVsBudgetService` Transaction.groupBy. Use `workspace.currency` for response. |
| `apps/api/src/routes/plaid.ts` | Plaid exchange: outer + in-lock currency check; on mismatch call `plaid.itemRemove` + 400. Wrap insert in helper. |
| `apps/api/src/plaid/sync.ts` | Drop Transaction.currency write. Wrap inserts in helper. |
| `apps/api/src/routes/transactions.ts` | Replace `t.currency` with workspace.currency lookup |
| `apps/api/src/categorize/manual-categorize.ts` | Replace `updated.currency` with workspace.currency |
| `apps/api/src/routes/workspaces.ts` | NEW PATCH `/workspaces/:id/currency` handler |
| `apps/api/src/chat/tools/{10 files}` | Drop Transaction.currency reads/filters; use workspace.currency for response. `list-accounts.ts` unchanged. |
| `apps/api/tests/workspaces.currency.test.ts` | NEW. PATCH route ~8 cases |
| `apps/api/tests/currency-lock.test.ts` | NEW. Lock-presence spy + integration race for all 4 writers |
| `apps/api/tests/plaid.routes.test.ts` | Add ~3 currency_mismatch cases |
| Existing test files | Drop `currency: "CAD"` from manual Transaction/RecurringExpense `prisma.*.create` seeds |

No new dependencies.

---

## Pre-flight Sanity Check

From the worktree root:

```bash
docker ps --filter name=fina-postgres-dev --format "{{.Names}}: {{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** Both `db:deploy` "No pending migrations". `83 passed / 699 passed`.

---

## Task 1: `withWorkspaceLock` helper + migration

**Files:**
- Create: `apps/api/src/locks/workspace.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_drop_per_row_currency/migration.sql`
- Create: `apps/api/tests/workspace-lock.test.ts` (helper unit test)

### 1.1 Create the helper

- [ ] **Step 1: Create `apps/api/src/locks/workspace.ts`**

```typescript
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

/**
 * Wrap DB work in a Prisma interactive transaction whose FIRST SQL
 * statement is `SELECT pg_advisory_xact_lock(hashtext(workspaceId))`.
 *
 * Every amount-row writer (creates rows in Transaction, BankAccount,
 * RecurringExpense, or Budget) must use this helper. It serializes
 * writers per-workspace so that PATCH /workspaces/:id/currency can
 * count amount rows and update the workspace.currency atomically
 * without any writer slipping in.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
    return await callback(tx);
  });
}
```

### 1.2 Helper unit test

- [ ] **Step 2: Create `apps/api/tests/workspace-lock.test.ts`**

```typescript
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { withWorkspaceLock } from "../src/locks/workspace.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

describe("withWorkspaceLock", () => {
  it("runs callback inside a transaction with the lock acquired first", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws" } });
    const out = await withWorkspaceLock(ws.id, async (tx) => {
      // tx is a TransactionClient, not the top-level prisma.
      const row = await tx.workspace.findUnique({
        where: { id: ws.id }, select: { id: true },
      });
      return row?.id;
    });
    expect(out).toBe(ws.id);
  });

  it("blocks a second concurrent call until the first releases", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws-2" } });
    let resolveFirst!: () => void;
    const firstHold = new Promise<void>((r) => { resolveFirst = r; });
    let secondStartedAt = 0;
    let secondFinishedAt = 0;

    const first = withWorkspaceLock(ws.id, async () => {
      await firstHold; // hold the lock until we release
      return "first-done";
    });
    // Yield so `first` enters the transaction + acquires the lock
    await new Promise((r) => setTimeout(r, 100));

    const second = withWorkspaceLock(ws.id, async () => {
      secondFinishedAt = Date.now();
      return "second-done";
    });
    secondStartedAt = Date.now();

    // Give `second` time to attempt acquiring the lock
    await new Promise((r) => setTimeout(r, 200));
    // Second must still be pending while first holds the lock
    expect(secondFinishedAt).toBe(0);

    resolveFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("first-done");
    expect(b).toBe("second-done");
    expect(secondFinishedAt - secondStartedAt).toBeGreaterThan(100);
  });

  it("propagates callback errors and rolls back", async () => {
    const ws = await prisma.workspace.create({ data: { name: "lock-ws-3" } });
    await expect(
      withWorkspaceLock(ws.id, async (tx) => {
        await tx.category.create({ data: { workspaceId: ws.id, name: "ShouldRollback" } });
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    const count = await prisma.category.count({ where: { workspaceId: ws.id, name: "ShouldRollback" } });
    expect(count).toBe(0);
  });

  it("does not block writes against different workspaces", async () => {
    const a = await prisma.workspace.create({ data: { name: "ws-a" } });
    const b = await prisma.workspace.create({ data: { name: "ws-b" } });
    let resolveFirst!: () => void;
    const hold = new Promise<void>((r) => { resolveFirst = r; });

    const first = withWorkspaceLock(a.id, async () => { await hold; });
    await new Promise((r) => setTimeout(r, 100));
    const otherStart = Date.now();
    await withWorkspaceLock(b.id, async () => { /* immediate */ });
    const otherDur = Date.now() - otherStart;
    expect(otherDur).toBeLessThan(500); // didn't wait on `a`'s lock

    resolveFirst();
    await first;
  });
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/workspace-lock.test.ts --reporter=basic 2>&1 | tail -10
```

### 1.3 Drop the two columns

- [ ] **Step 4: Edit `apps/api/prisma/schema.prisma`**

In `model Transaction`, remove the `currency` line:
```prisma
  // currency                  String            @default("CAD")    ← DELETE THIS LINE
```

In `model RecurringExpense`, remove the `currency` line:
```prisma
  // currency            String           @default("CAD")    ← DELETE THIS LINE
```

Leave `Workspace.currency` and `BankAccount.currency` untouched.

- [ ] **Step 5: Generate migration**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name drop_per_row_currency 2>&1 | tail -20
```

READ the generated `migration.sql`. It should contain exactly:
```sql
ALTER TABLE "transactions"       DROP COLUMN "currency";
ALTER TABLE "recurring_expenses" DROP COLUMN "currency";
```

Strip any unrelated `DROP INDEX` stub (recurring issue for chat_threads NULLS LAST index).

- [ ] **Step 6: Apply + regen + check baseline**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** Many tests will now FAIL — every file that reads/writes `Transaction.currency` or `RecurringExpense.currency` breaks. This is intentional; Tasks 2-5 fix them. Note the failure count.

### 1.4 Commit

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/locks/workspace.ts apps/api/tests/workspace-lock.test.ts apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-currency-unify): withWorkspaceLock helper + drop per-row currency columns"
```

---

## Task 2: Migrate writers (create-manual, recurring, budgets)

**Files:**
- Modify: `apps/api/src/transactions/create-manual.ts`
- Modify: `apps/api/src/recurring/service.ts`
- Modify: `apps/api/src/routes/recurring.ts`
- Modify: `apps/api/src/budgets/service.ts`

### 2.1 Migrate `createManualTransactionService`

- [ ] **Step 1: Edit `apps/api/src/transactions/create-manual.ts`**

(a) Replace the inline lock SQL with the helper. Add import at top:
```typescript
import { withWorkspaceLock } from "../locks/workspace.js";
```

(b) Find the existing `return await prisma.$transaction(async (tx) => { ... })` block. The body starts with `await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(${ctx.workspaceId}))\`;`. Replace the whole wrapper with:

```typescript
return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
  // (everything that was inside the old $transaction body, MINUS the
  //  $executeRaw lock line — withWorkspaceLock now does it.)
  // ...
});
```

(c) In the Transaction insert payload, remove the `currency` key (column gone):
```typescript
// BEFORE:
// const row = await tx.transaction.create({
//   data: {
//     ...
//     currency: workspace.currency,
//     ...
//   },
// });
// AFTER: just delete the `currency: workspace.currency,` line
```

(d) Keep the BankAccount Cash auto-create `currency: workspace.currency` (column retained).

(e) In the response transform at the bottom (`amount: row.amount.toString(), currency: row.currency, ...`), replace `row.currency` with `workspace.currency`:
```typescript
return {
  transaction: {
    // ...
    currency: workspace.currency,
    // ...
  },
};
```

### 2.2 Migrate `addRecurringService`

- [ ] **Step 2: Edit `apps/api/src/recurring/service.ts`**

(a) Add import:
```typescript
import { withWorkspaceLock } from "../locks/workspace.js";
```

(b) Drop `currency?: string` from the `AddRecurringInput` type (line ~16).

(c) Drop `currency: string` from the `RecurringExpenseRow` / response type (lines ~23, ~59) if they appear.

(d) In the read-side `listRecurringService` (and any singleton fetcher), look up `workspace.currency` once at the top and use it on all rows:
```typescript
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.workspaceId }, select: { currency: true },
});
// later, in row mapping:
//   currency: workspace.currency,    // not row.currency
```

(e) In `addRecurringService`:
- Wrap the upsert in `withWorkspaceLock`:
  ```typescript
  const data = await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    return await tx.recurringExpense.upsert({
      where: { ... },
      create: { ... /* no currency key */ },
      update: { ... /* no currency key */ },
    });
  });
  ```
- Remove `currency: (input.currency ?? "CAD").toUpperCase()` from create AND update payloads.
- In the response transform at the bottom, look up `workspace.currency` AFTER `withWorkspaceLock` returns (cheap, one extra query):
  ```typescript
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId }, select: { currency: true },
  });
  return {
    recurring: {
      // ...
      currency: workspace.currency,
      // ...
    },
  };
  ```

- [ ] **Step 3: Edit `apps/api/src/routes/recurring.ts`**

Remove the `currency: z.string().length(3).optional(),` line (line 19) from the `PostBody` zod schema.

Remove the conditional line `if (parsed.data.currency !== undefined) serviceInput.currency = parsed.data.currency;` (line 46).

### 2.3 Migrate `setBudgetService` + fix `compareSpendingVsBudgetService`

- [ ] **Step 4: Edit `apps/api/src/budgets/service.ts`**

(a) Add import at top:
```typescript
import { withWorkspaceLock } from "../locks/workspace.js";
```

(b) In `setBudgetService`, wrap the upsert call in `withWorkspaceLock`:
```typescript
return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
  return await tx.budget.upsert({ ... });
});
```

(c) In `compareSpendingVsBudgetService`, the `prisma.transaction.groupBy({ where: { ... } })` block has `currency: "CAD",` as one of its filter keys (line ~165). Remove that line — the column is gone and rows are single-currency by invariant.

(d) In the response payload at line ~166, replace the hardcoded `currency: "CAD"` with the workspace's currency. Add a lookup at the top of `compareSpendingVsBudgetService`:
```typescript
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.workspaceId }, select: { currency: true },
});
// ... later ...
return { ..., currency: workspace.currency, ... };
```

### 2.4 Run writer-related tests

- [ ] **Step 5: Re-run the relevant test files**

```bash
pnpm --filter @fina/api exec vitest run \
  tests/transactions.create-manual.test.ts \
  tests/recurring.service.test.ts \
  tests/recurring.routes.test.ts \
  tests/budgets.service.test.ts \
  2>&1 | tail -15
```

The tests that previously passed `currency: "USD"` in body and expected it preserved will now expect `workspace.currency` (default "CAD"). Update those assertions:
- Any test asserting `result.recurring.currency === "USD"` (when body had `currency: "USD"`) should expect `"CAD"` (workspace default; the body field is silently dropped).
- Any test passing `currency: "USD"` in `prisma.transaction.create({ data: ... })` direct seed should drop the `currency` key.

After updating assertions, re-run — expect PASS.

### 2.5 Commit

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/transactions/create-manual.ts apps/api/src/recurring/ apps/api/src/routes/recurring.ts apps/api/src/budgets/service.ts apps/api/tests/
git commit -m "feat(plan 1c-currency-unify): migrate writers to withWorkspaceLock + drop column writes"
```

---

## Task 3: Plaid exchange + sync

**Files:**
- Modify: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/src/plaid/sync.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts`

### 3.1 Plaid sync — drop transaction-level currency write

- [ ] **Step 1: Edit `apps/api/src/plaid/sync.ts`**

(a) Add helper import:
```typescript
import { withWorkspaceLock } from "../locks/workspace.js";
```

(b) Find the `currency: t.iso_currency_code ?? "CAD",` line (~line 275) in the Transaction upsert payload and DELETE it. The column is gone.

(c) Wrap the existing `prisma.$transaction(async (tx) => { ... })` block (the per-page transaction insert/upsert batch) with `withWorkspaceLock` instead of using `prisma.$transaction` directly. If the function loops over pages, the wrap is at the per-page level — each page's batch acquires the lock and releases on commit. If the existing code uses `prisma.$transaction` here, replace with `withWorkspaceLock(workspaceId, async (tx) => { ... })`.

### 3.2 Plaid exchange — outer + in-lock currency check + itemRemove

- [ ] **Step 2: Edit `apps/api/src/routes/plaid.ts`**

(a) Add helper imports at top:
```typescript
import { withWorkspaceLock } from "../locks/workspace.js";
```

(b) Find the `itemPublicTokenExchange` call followed by `accountsGet`. After both succeed but BEFORE the existing `prisma.$transaction(async (tx) => { ... })` block, add the OUTER currency-mismatch check:

```typescript
// Outer check: workspace.currency snapshot (cached read).
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.membership.workspaceId },
  select: { currency: true },
});
const mismatch = accountsRes.data.accounts.find(
  (a) => (a.balances?.iso_currency_code ?? null) !== workspace.currency,
);
if (mismatch) {
  // Plaid has already created an Item on its side. Clean it up before
  // returning 400 so the user's Plaid Items quota isn't consumed by a
  // ghost connection invisible in our UI. Best-effort: log on failure.
  try {
    await plaidClient(app.fina.env).itemRemove({ access_token: exch.data.access_token });
  } catch (e) {
    app.log.warn({ err: e }, "plaid.itemRemove failed during currency_mismatch cleanup");
  }
  const bankCurrency = mismatch.balances?.iso_currency_code ?? "unknown";
  return reply.code(400).send({
    error: "currency_mismatch",
    workspaceCurrency: workspace.currency,
    bankCurrency,
  });
}
```

(c) Replace the existing `prisma.$transaction(async (tx) => { ... })` wrapper with `withWorkspaceLock`. Inside the callback, BEFORE any inserts, add the IN-LOCK recheck:

```typescript
const result = await withWorkspaceLock(ctx.membership.workspaceId, async (tx) => {
  // In-lock recheck: PATCH could have landed between outer check and lock.
  const wsLocked = await tx.workspace.findUniqueOrThrow({
    where: { id: ctx.membership.workspaceId },
    select: { currency: true },
  });
  const mismatch2 = accountsRes.data.accounts.find(
    (a) => (a.balances?.iso_currency_code ?? null) !== wsLocked.currency,
  );
  if (mismatch2) {
    // Throw a sentinel — caller checks `err.code === "currency_mismatch_inlock"`
    // and triggers itemRemove + 400 response.
    const err = new Error("currency_mismatch_inlock") as Error & {
      code: "currency_mismatch_inlock";
      bankCurrency: string;
      workspaceCurrency: string;
    };
    err.code = "currency_mismatch_inlock";
    err.bankCurrency = mismatch2.balances?.iso_currency_code ?? "unknown";
    err.workspaceCurrency = wsLocked.currency;
    throw err;
  }
  const itemRowId = await storeAccessToken(app.fina.env, tx, { ... existing ... });
  for (const a of accountsRes.data.accounts) {
    await tx.bankAccount.create({
      data: {
        // ... existing fields ...
        currency: a.balances?.iso_currency_code ?? "CAD",  // KEEP — column retained
        // ...
      },
    });
  }
  return { itemRowId, accountCount: accountsRes.data.accounts.length };
});
```

(d) Wrap the `await result` call in a try/catch that handles the in-lock sentinel:

```typescript
try {
  const result = await withWorkspaceLock(ctx.membership.workspaceId, async (tx) => { /* ... */ });
  plaidItemId = result.itemRowId;
  accountCount = result.accountCount;
} catch (e) {
  if ((e as { code?: string })?.code === "currency_mismatch_inlock") {
    try {
      await plaidClient(app.fina.env).itemRemove({ access_token: exch.data.access_token });
    } catch (ee) {
      app.log.warn({ err: ee }, "plaid.itemRemove failed during in-lock currency_mismatch cleanup");
    }
    const e2 = e as { bankCurrency: string; workspaceCurrency: string };
    return reply.code(400).send({
      error: "currency_mismatch",
      workspaceCurrency: e2.workspaceCurrency,
      bankCurrency: e2.bankCurrency,
    });
  }
  if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return reply.code(422).send({ error: "already_connected" });
  }
  const m = mapPlaidError(e);
  return reply.code(m.statusCode).send({ error: m.code });
}
```

### 3.3 Add Plaid currency_mismatch tests

- [ ] **Step 3: Edit `apps/api/tests/plaid.routes.test.ts`** — append the following cases inside the existing describe block (or a new one). Use the same mock pattern as existing exchange tests:

```typescript
it("400 currency_mismatch when Plaid returns USD account for CAD workspace", async () => {
  const { cookie, wsId } = await setupOwnerWorkspace("pcurmismatch1@t.co");
  // mock Plaid client to return iso_currency_code: "USD" on accounts
  setMockExchangeAccounts([
    {
      account_id: "acc-1", name: "USD chequing", official_name: null, mask: "0001",
      type: "depository", subtype: "checking",
      balances: { iso_currency_code: "USD", current: 100, available: 100, limit: null },
    },
  ]);
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/plaid/exchange`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: { publicToken: "public-test-token", institutionId: "ins_x", institutionName: "USBank" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({
    error: "currency_mismatch",
    workspaceCurrency: "CAD",
    bankCurrency: "USD",
  });
  const itemCount = await prisma.plaidItem.count({ where: { workspaceId: wsId } });
  expect(itemCount).toBe(0);
  const acctCount = await prisma.bankAccount.count({ where: { workspaceId: wsId } });
  expect(acctCount).toBe(0);
  expect(plaidMockSpies.itemRemove).toHaveBeenCalledTimes(1);
});

it("400 currency_mismatch when Plaid returns null iso_currency_code", async () => {
  const { cookie, wsId } = await setupOwnerWorkspace("pcurmismatch2@t.co");
  setMockExchangeAccounts([
    {
      account_id: "acc-2", name: "weird account", official_name: null, mask: null,
      type: "depository", subtype: null,
      balances: { iso_currency_code: null, current: 0, available: 0, limit: null },
    },
  ]);
  const res = await app.inject({
    method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: { publicToken: "public-test-token", institutionId: "ins_y", institutionName: "Weird" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toMatchObject({
    error: "currency_mismatch",
    workspaceCurrency: "CAD",
    bankCurrency: "unknown",
  });
  expect(plaidMockSpies.itemRemove).toHaveBeenCalledTimes(1);
});
```

If the existing `plaid.routes.test.ts` doesn't have a `setMockExchangeAccounts` / `plaidMockSpies` pattern, READ the file's existing exchange test to mirror its mock approach. The two key needs: (1) control the accounts returned, (2) spy on `itemRemove`.

- [ ] **Step 4: Run plaid tests — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/plaid.routes.test.ts --reporter=basic 2>&1 | tail -15
```

### 3.4 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plaid.ts apps/api/src/plaid/sync.ts apps/api/tests/plaid.routes.test.ts
git commit -m "feat(plan 1c-currency-unify): Plaid exchange currency_mismatch + itemRemove + lock"
```

---

## Task 4: Read paths + chat tools

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/src/categorize/manual-categorize.ts`
- Modify: 10 chat tool files (see below)

### 4.1 Transactions list route

- [ ] **Step 1: Edit `apps/api/src/routes/transactions.ts`**

In the GET handler around line 119, the response mapper has `currency: t.currency`. Replace by reading workspace.currency once at the top:

```typescript
// near the top of the handler, after auth:
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.membership.workspaceId },
  select: { currency: true },
});
// ... in the row mapper:
//   currency: workspace.currency,    // not t.currency
```

### 4.2 Manual categorize service

- [ ] **Step 2: Edit `apps/api/src/categorize/manual-categorize.ts`**

(a) Around line 118, the `prisma.transaction.update({ ... select: { ..., currency: true, ... } })` selects `currency: true`. REMOVE that key (column gone).

(b) Around line 127, the response has `currency: updated.currency`. Replace by reading workspace.currency once at the top of the function:

```typescript
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.workspaceId }, select: { currency: true },
});
// ... in the response:
//   currency: workspace.currency,
```

### 4.3 Chat tools — Transaction currency reads (6 files)

For each of these files, the pattern is the same:
1. Read `workspace.currency` once at the top of the tool's `run` function.
2. **Remove BOTH `currency: "CAD"` AND `currency: { not: "CAD" }` filters** from any Prisma `where` clauses. The positive filter is in main `findMany`/`count`/`groupBy` queries; the negative filter is in companion "non-CAD-excluded" count queries. After the column drop, both are Prisma-invalid AND single-currency-per-workspace is enforced, so they're redundant.
3. **Remove any `excludedNonCadCount` / "excluded non-CAD" companion logic** — these counts were tracking how many rows had a different currency. With the invariant, they're always 0. Drop the count query, drop the variable, and drop the field from the output schema/response.
4. Remove `currency: true` from Prisma `select` clauses on Transaction (if present).
5. Replace `r.currency` / `t.currency` / `tx.currency` in response mappers with `workspace.currency`.

- [ ] **Step 3: Edit `apps/api/src/chat/tools/find-transactions.ts`**
  - In the `where: Prisma.TransactionWhereInput = { ... }` block (line ~170-173): **REMOVE** the `currency: "CAD",` line (it's a where-filter on Transaction, not an output value).
  - Drop `currency: { not: "CAD" }` from the companion `prisma.transaction.count` where clause (line ~216) AND remove the entire `excludedNonCadCount` count query + variable + field if present.
  - Add workspace lookup; map response currency from workspace.
  - `r.currency` in the row mapper → `workspace.currency`.

- [ ] **Step 4: Edit `apps/api/src/chat/tools/get-cashflow-summary.ts`**
  - **REMOVE `currency: "CAD"`** from the main `prisma.transaction.findMany` `where` block (line ~53) — it's a Prisma filter, not an output value.
  - Drop the companion `excludedNonCadCount` count query that uses `currency: { not: "CAD" }` (line ~67) plus its accumulator variable.
  - Drop `currency: "CAD"` from the output type declaration (line ~29) and response builder (line ~128).
  - Add workspace lookup; use `workspace.currency` for response.

- [ ] **Step 5: Edit `apps/api/src/chat/tools/get-category-breakdown.ts`**
  - **REMOVE `currency: "CAD"`** from the main Prisma `where` block (line ~59).
  - Drop the companion `currency: { not: "CAD" }` count query (line ~87) and `excludedNonCadCount` variable/field.
  - Drop `currency: "CAD"` from output type (line ~40) and response (line ~143).
  - Add workspace lookup; use `workspace.currency` for response.

- [ ] **Step 6: Edit `apps/api/src/chat/tools/compare-spending-periods.ts`**
  - **REMOVE `currency: "CAD"`** from any Prisma `where` blocks (lines ~127, ~137 if they're filters; check context).
  - Drop any companion `currency: { not: "CAD" }` count query.
  - Drop `currency: "CAD"` from output type (line ~40).
  - Add workspace lookup; use `workspace.currency` for response.

- [ ] **Step 7: Edit `apps/api/src/chat/tools/detect-recurring-merchants.ts`**
  - Drop `currency: true` from `prisma.transaction.findMany` select (line ~109)
  - Drop `currency: string` field from inner row type (line ~120)
  - Replace `${merchantKey}::${r.currency}` group key with just `merchantKey` (line ~132)
  - Drop `currency: r.currency` in group accumulator (line ~138)
  - Replace `currency: g.currency` in final response with `workspace.currency` (line ~200)
  - Add workspace lookup at the top

- [ ] **Step 8: Edit `apps/api/src/chat/tools/find-uncategorized-transactions.ts`**
  - Drop `currency: string` from row type (line ~35)
  - Replace `currency: r.currency` with `workspace.currency` (line ~81)
  - Add workspace lookup

- [ ] **Step 9: Edit `apps/api/src/chat/tools/get-transaction-details.ts`**
  - Drop `currency: string` from the top-level transaction type (line ~18 if it refers to Transaction-level, NOT account-level)
  - In `prisma.transaction.findUnique({ select: { ..., account: { select: { ..., currency: true } }, ... } })`:
    - The `account.select.currency: true` STAYS (BankAccount.currency column retained).
    - DROP any top-level `currency: true` on the Transaction select if present.
  - Top-level response `currency: tx.currency` (line ~69) → `workspace.currency`
  - `account.currency: tx.account.currency` (line ~84) — KEEP unchanged
  - Add workspace lookup at the top of the tool

### 4.4 Chat tools — Recurring currency reads (2 files)

- [ ] **Step 10: Edit `apps/api/src/chat/tools/list-recurring.ts`**
  - Drop `currency: string` from row type (line ~17)
  - Drop any `select: { currency: true }` on RecurringExpense (column gone)
  - Use `workspace.currency` for response

- [ ] **Step 11: Edit `apps/api/src/chat/tools/add-recurring.ts`**
  - Drop the `currency: z.string().length(3).optional()` field from the zod schema (line ~14)
  - Drop the conditional `if (args.currency) serviceInput.currency = args.currency;` (line ~75)
  - Drop `currency: string` from response type if present (line ~29)

### 4.5 Chat tool — Budgets

- [ ] **Step 12: Edit `apps/api/src/chat/tools/compare-spending-vs-budget.ts`**
  - The tool relays through `compareSpendingVsBudgetService` which Task 2 already fixed.
  - If the tool's own response shape includes `currency: "CAD"` hardcoded, replace with workspace currency from the service result.

### 4.6 list-accounts.ts — no change

- [ ] **Step 13: Verify `apps/api/src/chat/tools/list-accounts.ts` is unchanged.** BankAccount.currency column retained; the tool's `r.currency` read continues to work.

### 4.7 Run chat tool tests

- [ ] **Step 14: Run chat tool + read-path tests**

```bash
pnpm --filter @fina/api exec vitest run \
  tests/chat.tools.find-transactions.test.ts \
  tests/chat.tools.get-cashflow-summary.test.ts \
  tests/chat.tools.get-category-breakdown.test.ts \
  tests/chat.tools.compare-spending-periods.test.ts \
  tests/chat.tools.detect-recurring-merchants.test.ts \
  tests/chat.tools.find-uncategorized-transactions.test.ts \
  tests/chat.tools.get-transaction-details.test.ts \
  tests/chat.tools.list-recurring.test.ts \
  tests/chat.tools.add-recurring.test.ts \
  tests/chat.tools.compare-spending-vs-budget.test.ts \
  tests/categorize.test.ts \
  tests/transactions.routes.test.ts \
  --reporter=basic 2>&1 | tail -20
```

Some test files may not exist for every tool. Adjust the list to the actual files present (use `ls apps/api/tests/chat.tools.*.test.ts`).

Some existing tests assert `currency` in the response — those still pass because we now compute from workspace.currency which defaults to "CAD" in test setup.

Test seed updates: any test that does `prisma.transaction.create({ data: { ..., currency: "CAD", ... } })` directly must drop the `currency` key (column gone). Search:
```bash
grep -rn 'currency: "CAD"' apps/api/tests/ | head
grep -rn 'currency: "USD"' apps/api/tests/ | head
```
For each match, decide: (a) drop the key if it's an inline Prisma seed for `Transaction` or `RecurringExpense`, (b) keep if it's for `BankAccount` (column retained) or `Workspace`.

**Test assertion updates (excludedNonCadCount):** Any chat-tool test that asserts an `excludedNonCadCount` field in the response payload (find-transactions, get-cashflow-summary, get-category-breakdown, compare-spending-periods) must be updated. Search:
```bash
grep -rn 'excludedNonCadCount\|excluded_non_cad\|nonCadExcluded' apps/api/tests/ | head
```
For each match:
- If the assertion is `expect(result.excludedNonCadCount).toBe(0)`: delete the assertion (field no longer exists in response).
- If the assertion is `expect(result.excludedNonCadCount).toBe(N)` where N > 0: the test was previously seeding non-CAD transactions to verify exclusion — that seed code also fails after the column drop. Delete both the seed code AND the assertion since the single-currency invariant makes the scenario impossible.
- If the assertion is inside an object-shape match (e.g., `toEqual({ ... excludedNonCadCount: 0 })`): remove that key from the expected object.

### 4.8 Commit

- [ ] **Step 15: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/categorize/ apps/api/src/chat/tools/ apps/api/tests/
git commit -m "feat(plan 1c-currency-unify): read paths + chat tools use workspace.currency"
```

---

## Task 5: PATCH /workspaces/:id/currency route + tests

**Files:**
- Modify: `apps/api/src/routes/workspaces.ts`
- Create: `apps/api/tests/workspaces.currency.test.ts`

### 5.1 Add the PATCH handler

- [ ] **Step 1: Edit `apps/api/src/routes/workspaces.ts`** — append the new handler inside the existing routes function. The file already imports `z`, `prisma`, `HttpError`, `requireWorkspaceContext`.

```typescript
const PatchCurrencyBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
});

app.patch<{ Params: { id: string } }>(
  "/workspaces/:id/currency",
  async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (req.params.id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const parsed = PatchCurrencyBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const wsId = ctx.membership.workspaceId;
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;
        const [txCount, acctCount, recurringCount, budgetCount] = await Promise.all([
          tx.transaction.count({ where: { workspaceId: wsId } }),
          tx.bankAccount.count({ where: { workspaceId: wsId } }),
          tx.recurringExpense.count({ where: { workspaceId: wsId } }),
          tx.budget.count({ where: { workspaceId: wsId } }),
        ]);
        if (txCount + acctCount + recurringCount + budgetCount > 0) {
          throw new HttpError(409, "workspace_has_data");
        }
        return await tx.workspace.update({
          where: { id: wsId },
          data: { currency: parsed.data.currency },
          select: { id: true, name: true, currency: true },
        });
      });
      return reply.send({ workspace: updated });
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
      throw err;
    }
  },
);
```

NOTE: The PATCH handler uses inline `$transaction + advisory lock` rather than `withWorkspaceLock` — because it also UPDATEs workspace.currency and the recurring imports a `tx` typed for that. Either approach works; the spec uses the inline form here. Keep it as-is for consistency with the spec.

### 5.2 PATCH route tests

- [ ] **Step 2: Create `apps/api/tests/workspaces.currency.test.ts`**

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";

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

async function setupOwner(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("PATCH /workspaces/:id/currency", () => {
  it("200 happy: fresh workspace + valid ISO updates currency", async () => {
    const { cookie, wsId } = await setupOwner("pc1@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workspace: { currency: string } };
    expect(body.workspace.currency).toBe("USD");
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } });
    expect(ws.currency).toBe("USD");
  });

  it("400 invalid_body: lowercase currency", async () => {
    const { cookie, wsId } = await setupOwner("pc2@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "us" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 invalid_body: too-long currency", async () => {
    const { cookie, wsId } = await setupOwner("pc3@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "DOLLAR" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("403 insufficient_role: editor cannot change currency", async () => {
    const owner = await setupOwner("pc4own@t.co");
    const editor = await setupOwner("pc4ed@t.co");
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: owner.wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.wsId}/currency`,
      headers: { cookie: editor.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient_role" });
  });

  it("409 workspace_has_data: bank_account exists", async () => {
    const { cookie, wsId } = await setupOwner("pc5@t.co");
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Acct", type: "depository", currency: "CAD" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "workspace_has_data" });
  });

  it("409 workspace_has_data: transaction exists (with auto Cash account)", async () => {
    const { cookie, wsId } = await setupOwner("pc6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", currency: "CAD" },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        amount: "1.00", merchantRaw: "x", occurredAt: new Date("2026-05-18T12:00:00Z"),
        source: "manual", rawData: {},
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "workspace_has_data" });
  });

  it("409 workspace_has_data: RecurringExpense exists", async () => {
    const { cookie, wsId } = await setupOwner("pc7@t.co");
    await prisma.recurringExpense.create({
      data: {
        workspaceId: wsId, name: "Netflix", nameNormalized: "netflix",
        amount: "19.99", cadence: "monthly",
        nextOccurrenceDate: new Date("2026-08-01T12:00:00Z"),
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "workspace_has_data" });
  });

  it("409 workspace_has_data: Budget exists", async () => {
    const { cookie, wsId } = await setupOwner("pc8@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Coffee" },
    });
    await prisma.budget.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "100.00",
        periodStart: new Date("2026-05-01"),
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "workspace_has_data" });
  });
});
```

If the RecurringExpense seed in test 7 needs additional required fields (e.g., merchantNormalized), READ `apps/api/prisma/schema.prisma` `model RecurringExpense` and adjust the seed to satisfy required fields. The test purpose is to seed ONE row, not to validate the model.

- [ ] **Step 3: Run PATCH tests — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/workspaces.currency.test.ts --reporter=basic 2>&1 | tail -15
```

### 5.3 Commit

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/workspaces.ts apps/api/tests/workspaces.currency.test.ts
git commit -m "feat(plan 1c-currency-unify): PATCH /workspaces/:id/currency route + tests"
```

---

## Task 6: Lock-presence spy + integration race tests

**Files:**
- Create: `apps/api/tests/currency-lock.test.ts`

### 6.1 Spy assertions + integration race tests

- [ ] **Step 1: Create `apps/api/tests/currency-lock.test.ts`**

```typescript
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import * as workspaceLockModule from "../src/locks/workspace.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
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
afterEach(() => { vi.restoreAllMocks(); });

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("withWorkspaceLock spy — writers go through the helper, NOT top-level prisma", () => {
  it("createManualTransactionService: uses helper, no top-level transaction/bankAccount writes", async () => {
    const { wsId, userId } = await setupEditor("ls1@t.co");
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const txCreate = vi.spyOn(prisma.transaction, "create");
    const acctCreate = vi.spyOn(prisma.bankAccount, "create");
    const acctUpsert = vi.spyOn(prisma.bankAccount, "upsert");

    const { createManualTransactionService } = await import("../src/transactions/create-manual.js");
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
    );
    expect(helperSpy).toHaveBeenCalledWith(wsId, expect.any(Function), expect.anything());
    // ^ third arg is optional `client`. Use the looser form:
    // expect(helperSpy).toHaveBeenCalledWith(wsId, expect.any(Function))
    expect(txCreate).not.toHaveBeenCalled();
    expect(acctCreate).not.toHaveBeenCalled();
    expect(acctUpsert).not.toHaveBeenCalled();
  });

  it("addRecurringService: uses helper, no top-level recurringExpense writes", async () => {
    const { wsId, userId } = await setupEditor("ls2@t.co");
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const recCreate = vi.spyOn(prisma.recurringExpense, "create");
    const recUpsert = vi.spyOn(prisma.recurringExpense, "upsert");

    const { addRecurringService } = await import("../src/recurring/service.js");
    await addRecurringService(
      { workspaceId: wsId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
    );
    expect(helperSpy).toHaveBeenCalled();
    expect(recCreate).not.toHaveBeenCalled();
    expect(recUpsert).not.toHaveBeenCalled();
  });

  it("setBudgetService: uses helper, no top-level budget writes", async () => {
    const { wsId, userId } = await setupEditor("ls3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const bCreate = vi.spyOn(prisma.budget, "create");
    const bUpsert = vi.spyOn(prisma.budget, "upsert");

    const { setBudgetService } = await import("../src/budgets/service.js");
    await setBudgetService(
      { workspaceId: wsId, userId },
      { categoryId: cat.id, amount: 100, periodStart: "2026-05-01" },
    );
    expect(helperSpy).toHaveBeenCalled();
    expect(bCreate).not.toHaveBeenCalled();
    expect(bUpsert).not.toHaveBeenCalled();
  });
});

describe("integration race — writers block while holder owns the lock", () => {
  it("createManualTransactionService blocks on held lock, then sees post-PATCH currency", async () => {
    const { wsId, userId } = await setupEditor("rc1@t.co");
    // Holder: separate Prisma client to keep its own connection.
    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { createManualTransactionService } = await import("../src/transactions/create-manual.js");
    const candidate = createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
    );

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout"); // proves the lock blocked the candidate

    // Update workspace currency from the holder's tx, then commit
    await holder.$executeRaw`UPDATE workspaces SET currency = 'USD' WHERE id = ${wsId}`;
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();

    const result = await candidate;
    expect(result.transaction.currency).toBe("USD");
  });

  it("addRecurringService blocks on held lock, then sees post-PATCH currency", async () => {
    const { wsId } = await setupEditor("rc2@t.co");
    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { addRecurringService } = await import("../src/recurring/service.js");
    const candidate = addRecurringService(
      { workspaceId: wsId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
    );
    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout");
    await holder.$executeRaw`UPDATE workspaces SET currency = 'USD' WHERE id = ${wsId}`;
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();
    const result = await candidate;
    expect(result.recurring.currency).toBe("USD");
  });

  it("setBudgetService blocks on held lock", async () => {
    const { wsId, userId } = await setupEditor("rc3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { setBudgetService } = await import("../src/budgets/service.js");
    const candidate = setBudgetService(
      { workspaceId: wsId, userId },
      { categoryId: cat.id, amount: 100, periodStart: "2026-05-01" },
    );
    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout");
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();
    const result = await candidate;
    expect(result).toBeDefined();
  });
});
```

For `setBudgetService`, READ the service signature from `apps/api/src/budgets/service.ts` and adjust the call shape if it differs (e.g., the function may take `{ ctx, input }` separately). The test purpose stands either way.

- [ ] **Step 2: Run currency-lock tests — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/currency-lock.test.ts --reporter=basic 2>&1 | tail -15
```

### 6.2 Commit

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/currency-lock.test.ts
git commit -m "test(plan 1c-currency-unify): writer lock spy + integration race tests"
```

---

## Task 7: Full suite + sanity verification

**Files:** none (verification only).

### 7.1 Full suite

- [ ] **Step 1: Reset + run all tests**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** 86 files / ~717 tests PASS (83 + 3 new files: workspace-lock, workspaces.currency, currency-lock; 699 + ~18 new tests).

If any existing test fails, the most common reasons:
- A test was seeding `Transaction.currency` or `RecurringExpense.currency` directly via `prisma.*.create({ data: { currency: "..." } })`. Drop the `currency` key.
- A test was asserting `result.something.currency === "USD"` from passing `currency: "USD"` in the body of an `addRecurring` POST. Update to expect `"CAD"` (workspace default; body field is ignored).

### 7.2 Sanity grep

- [ ] **Step 2: Verify the invariants**

```bash
grep -rn "currency" apps/api/src/ | grep -v -E "node_modules|workspace\.currency|Workspace\.currency|a\.currency|account\.currency|account: \{ select.+currency|bankAccount\.currency|BankAccount.+currency|tx\.account\.currency" | head -30
```

The output should be limited to:
- `withWorkspaceLock` helper docstring mentions of currency
- New PATCH route's `Workspace.currency` update
- Plaid exchange's `iso_currency_code` reads + mismatch check + BankAccount.create write
- Response assignments that use `workspace.currency` value

No leftover `transaction.currency`, `recurringExpense.currency`, or `currency: { not: "CAD" }` filters on Transaction.

### 7.3 No new dependency

- [ ] **Step 3: Check `package.json`**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged).

---

## Self-Review Checklist (after all tasks)

1. **Spec §3 decisions:** Drop only Transaction.currency + RecurringExpense.currency. BankAccount.currency stays. ✓ Task 1.
2. **Spec §4 schema/migration:** 2 DROP COLUMN. ✓ Task 1.
3. **Spec §5.1 create-manual:** Migrate to helper, drop Transaction.currency write, keep BankAccount.currency on Cash auto-create, response uses workspace.currency. ✓ Task 2.
4. **Spec §5.2 recurring:** Helper, drop column, drop body field, response uses workspace.currency. ✓ Task 2.
5. **Spec §5.3 transactions list route:** workspace.currency lookup in handler. ✓ Task 4.
6. **Spec §5.4 categorize service:** workspace.currency in response. ✓ Task 4.
7. **Spec §5.5 accounts route:** No change. ✓ Task 4 (verified).
8. **Spec §5.6 Plaid exchange:** Outer + in-lock check + itemRemove. ✓ Task 3.
9. **Spec §5.7 Plaid sync:** Drop Transaction.currency write, wrap in helper. ✓ Task 3.
10. **Spec §5.8 budgets:** Drop `currency: "CAD"` filter, wrap setBudget in helper, workspace.currency response. ✓ Task 2.
11. **Spec §5.9 helper:** withWorkspaceLock created. ✓ Task 1.
12. **Spec §5.10 PATCH route:** owner+, 409 on amount-bearing rows, inline lock+tx. ✓ Task 5.
13. **Spec §7 chat tools:** All 10 (minus list-accounts) updated. ✓ Task 4.
14. **Spec §8.1 PATCH tests:** 8 cases. ✓ Task 5.
15. **Spec §8.1 spy tests:** 3 cases (manual, recurring, budget). ✓ Task 6.
16. **Spec §8.1 race tests:** 3 cases. ✓ Task 6.
17. **Spec §8.2 Plaid mismatch:** 2 cases. ✓ Task 3.

---

## Known limitations (documented in spec §10)

- No FX conversion / multi-currency display
- No cross-workspace data migration
- No aggregation across workspaces in different currencies
- No UI for "create another workspace in different currency" flow (frontend track)
- No auto-suggest workspace.currency from user locale at signup
