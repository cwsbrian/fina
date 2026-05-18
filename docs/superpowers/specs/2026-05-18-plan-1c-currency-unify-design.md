# Plan 1C-currency-unify — Workspace.currency as sole source of truth

**Date:** 2026-05-18
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation)

---

## 1. Goal

Make `Workspace.currency` the sole source of truth for currency in a workspace.
Drop per-row `currency` columns from `Transaction` and `RecurringExpense`.
**Keep** `BankAccount.currency` as a historical record of Plaid's reported
`iso_currency_code` per account (not used for math; preserves Plaid's truth
in case multi-currency support is needed later). Reject Plaid item
connections whose account currencies differ from the workspace's. Make
`PATCH /workspaces/:id/currency` available only while the workspace has
zero amount-bearing rows.

**Product axiom:** workspace == currency boundary. A user wanting to track
multi-currency accounts creates separate workspaces — Fina does not perform
FX conversion in budget/spending math, so mixing currencies in one workspace
would silently produce nonsense.

---

## 2. Background

Currently currency lives in four places (all defaulting to `"CAD"`):
- `Workspace.currency` (added in 1C-add-transaction) — **stays as source of truth**
- `BankAccount.currency` — **stays** (Plaid's reported `iso_currency_code` per account; preserved for historical/forensic value)
- `Transaction.currency` — **drop**
- `RecurringExpense.currency` — **drop**

`Budget` has no currency at all — implicit assumption that all transactions
share the same currency, which is what we are now enforcing.

In practice every row in a workspace has identical currency: Plaid Canada
always returns CAD for Canadian-issued accounts (foreign-currency
transactions on Canadian cards are converted to CAD at booking by the card
issuer), and manual writes already inherit `workspace.currency`. The per-row
column carries no semantic information specific to the row.

---

## 3. Decisions

| Topic | Decision |
|---|---|
| Per-row currency columns | **Drop** `Transaction.currency` and `RecurringExpense.currency`. **Keep** `BankAccount.currency` (Plaid's truth per account; preserved for forensic/future use; not consulted for math). |
| `Workspace.currency` | Stays; sole source of truth for all amount math |
| `BankAccount.currency` | Stays. On Plaid exchange, set from `account.balances.iso_currency_code` (already validated to match workspace.currency at exchange time). On manual "Cash" auto-create, set from `workspace.currency`. |
| Read API responses | Continue to expose `currency` in response payloads; routes look up `workspace.currency` once per request and pass through |
| `addRecurring` request body | Drop the `currency` field (was optional `string.length(3)`); ignore if sent |
| Plaid Item exchange | If any returned account's `iso_currency_code` ≠ `workspace.currency`, reject the exchange with HTTP 400 `currency_mismatch`. No accounts/items persisted. |
| Plaid Item exchange — null iso_currency_code | Treat null/missing as mismatch (reject). Plaid Canada always provides it; null indicates anomalous data or unofficial currency. |
| Plaid `iso_currency_code` on individual transactions during sync | Ignored — the item-level validation at exchange time guarantees workspace consistency, and we no longer have a column to store it. |
| `PATCH /workspaces/:id/currency` | Owner-only. Body: `{ currency: string }` (3-char ISO regex). Reject (409 `workspace_has_data`) if **any of `Transaction`, `BankAccount`, `RecurringExpense`, or `Budget`** rows exist (all amount-bearing tables). The count+update must run inside `prisma.$transaction` with `pg_advisory_xact_lock(hashtext(workspaceId))`. **All amount-row writers must also wrap their work in the same advisory lock** (see §5.10) so PATCH and writers serialize per-workspace and writers cannot insert between PATCH's count and update. |
| Budget / categorize / spending math | Unchanged — already treats all amounts as same-currency. |
| Migration data loss | Acceptable: all existing rows have `currency = "CAD"` (verified by inspection). No prod data. |

---

## 4. Data model changes

### 4.1 Schema diff

```prisma
model Workspace {
  // ... unchanged
  currency String @default("CAD")   // STAYS — source of truth
}

model BankAccount {
  currency String @default("CAD")   // STAYS — Plaid's per-account truth
  // ... other fields unchanged
}

model Transaction {
  // REMOVED: currency String @default("CAD")
}

model RecurringExpense {
  // REMOVED: currency String @default("CAD")
}
```

### 4.2 Migration

```sql
ALTER TABLE "transactions"       DROP COLUMN "currency";
ALTER TABLE "recurring_expenses" DROP COLUMN "currency";
```

Irreversible for the two dropped columns. All current rows are `"CAD"` so
no information is lost in practice. `bank_accounts.currency` is retained
untouched.

---

## 5. Service / route changes

### 5.1 Manual transaction service

`apps/api/src/transactions/create-manual.ts`:
- Drop `currency: workspace.currency` from the **Transaction** create
  payload (column removed).
- **Keep** `currency: workspace.currency` on the BankAccount create
  payload (auto-create Cash account; column stays).
- Response still includes `currency` — value comes from the `workspace`
  lookup that already happens in the transaction.

### 5.2 Recurring service

`apps/api/src/recurring/service.ts`:
- Remove `currency` from `AddRecurringInput` type and from
  `addRecurringService` body — service no longer accepts a currency arg.
- Stop writing `currency` to RecurringExpense create.
- Read responses: replace `row.currency` with a lookup of
  `workspace.currency` once at the start of the list/get service.

`apps/api/src/routes/recurring.ts`:
- Remove the `currency: z.string().length(3).optional()` field from the
  Zod body schema (silently ignored if a client still sends it — Zod
  default behavior on unknown keys).
- Remove the conditional `serviceInput.currency = …` block.

### 5.3 Transactions list route

`apps/api/src/routes/transactions.ts`:
- The route's response transform currently reads `t.currency`. After auth
  succeeds, do one `prisma.workspace.findUniqueOrThrow({ where: { id: wsId }, select: { currency: true } })` lookup, then map all transaction rows to use that value.

### 5.4 Categorize service

`apps/api/src/categorize/manual-categorize.ts`:
- Response includes `currency`. Replace `updated.currency` with the
  workspace's currency (single lookup at the top of the service).

### 5.5 Accounts route

`apps/api/src/routes/accounts.ts`:
- **No change.** Continue reading `a.currency` from the row (column
  retained). Per-account currency is the Plaid-reported truth and is
  expected to equal workspace.currency for all rows in the workspace
  (enforced at exchange time).

### 5.6 Plaid item exchange

`apps/api/src/routes/plaid.ts`:
- After Plaid's `itemPublicTokenExchange` returns an `access_token` + the
  subsequent `accountsGet` call returns account list, BEFORE the local DB
  inserts, validate every account's `balances?.iso_currency_code`:
  - If any value differs from `workspace.currency`, OR is null/undefined,
    treat as mismatch.
- On mismatch: **call `plaid.itemRemove({ access_token })` BEFORE returning
  the error.** Plaid has already created an Item upstream on its end; we
  must un-create it or the user's Plaid "Items limit" is consumed by a
  ghost connection they can't see in our UI. Wrap the `itemRemove` call
  in a try/catch — if it fails (network, etc.), log a warning but still
  return the mismatch error to the user. Persisting a stub `PlaidItem`
  row with a "needs_unlink" flag for later cleanup is out of scope; we
  document the rare-failure case in the route comment.
- Return `400 currency_mismatch` with body
  `{ error: "currency_mismatch", workspaceCurrency: "...", bankCurrency: "..." }`.
  Use `"unknown"` for `bankCurrency` if null/undefined.
- **Keep** `currency: a.balances?.iso_currency_code ?? "CAD"` on the
  BankAccount insert payload (column retained; this stores Plaid's
  reported value, which we've now verified matches workspace.currency).

### 5.7 Plaid sync

`apps/api/src/plaid/sync.ts`:
- Remove `currency: t.iso_currency_code ?? "CAD"` from the transaction
  insert payload. The item-level validation at exchange time ensures
  consistency.

### 5.8 Budgets service

`apps/api/src/budgets/service.ts`:
- In `compareSpendingVsBudgetService` (the function the chat tool
  `compareSpendingVsBudget` calls via `apps/api/src/chat/tools/compare-spending-vs-budget.ts`),
  remove the `currency: "CAD"` predicate from the `prisma.transaction.groupBy({ where: { ... } })` clause. After the column drop, this filter would throw a Prisma validation error.
- Replace the hardcoded `currency: "CAD"` response field with the
  workspace's currency.
- `setBudgetService` must wrap its `prisma.budget.upsert(...)` in
  `prisma.$transaction` with the advisory lock (see §5.10).

### 5.9 Advisory lock on all amount-row writers

**Create** a shared helper at `apps/api/src/locks/workspace.ts` (note: NOT `apps/api/src/db/workspace-lock.ts` — `apps/api/src/db.ts` already exists as a file, blocking a sibling `db/` directory):

```typescript
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

export async function withWorkspaceLock<T>(
  workspaceId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return await client.$transaction(async (tx) => {
    // Lock is ALWAYS the first DB statement in this transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
    return await callback(tx);
  });
}
```

This guarantees `pg_advisory_xact_lock` is the first SQL emitted by the
transaction's callback. Writers MUST use this helper instead of inlining
the lock SQL.

Writers using the helper:

- `createManualTransactionService` (`apps/api/src/transactions/create-manual.ts`)
  — migrate from inline lock SQL to `withWorkspaceLock(wsId, async (tx) => {...})`.
- `addRecurringService` (`apps/api/src/recurring/service.ts`)
  — wrap the create call in `withWorkspaceLock`.
- `setBudgetService` (`apps/api/src/budgets/service.ts`)
  — wrap the upsert in `withWorkspaceLock`.
- Plaid item exchange (`apps/api/src/routes/plaid.ts`) — wrap the
  `PlaidItem.create` + `BankAccount.create` batch in `withWorkspaceLock`.
  **The currency-mismatch check is performed TWICE:**
  - First, outside the lock against the cached workspace.currency from
    the route handler (cheap reject before lock acquisition).
  - Second, INSIDE the lock by re-reading `workspace.currency` and
    re-comparing against the account currencies. If they no longer
    match (concurrent PATCH won), throw a sentinel inside the callback
    to trigger rollback, then call `itemRemove` AFTER the rollback
    completes (so Plaid's upstream Item is cleaned up).
- Plaid sync (`apps/api/src/plaid/sync.ts`) — wrap the
  transaction-batch insert/upsert work in `withWorkspaceLock`. (Sync
  writes can be large; the lock is held only for the duration of the
  batch.)

The lock is per-workspace (keyed on `hashtext(workspaceId)`), so
different workspaces never block each other. Within one workspace, PATCH
and writers serialize. Both flows are infrequent (user-driven) so
contention is acceptable.

The helper's existence + "first statement is the lock" invariant makes
the test strategy straightforward: spy on `withWorkspaceLock` and assert
every writer calls it before any other DB statement. The spy is
deterministic (no timing) and catches the "writer forgot to use the
helper" regression directly.

### 5.10 PATCH /workspaces/:id/currency (new)

`apps/api/src/routes/workspaces.ts`:

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
      // Wrap count+update in $transaction with the same per-workspace
      // advisory lock used by writers (createManualTransactionService).
      // Without the lock, a concurrent manual-tx or Plaid exchange could
      // insert amount rows between our count and update, silently
      // relabeling them in the new currency.
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;
        const [txCount, acctCount, recurringCount, budgetCount] = await Promise.all([
          tx.transaction.count({ where: { workspaceId: wsId } }),
          tx.bankAccount.count({ where: { workspaceId: wsId } }),
          tx.recurringExpense.count({ where: { workspaceId: wsId } }),
          tx.budget.count({ where: { workspaceId: wsId } }),
        ]);
        if (txCount + acctCount + recurringCount + budgetCount > 0) {
          // Signal failure via thrown sentinel; route maps to 409.
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

---

## 6. Endpoint contracts

### 6.1 PATCH /workspaces/:id/currency

**Request:** `{ "currency": "USD" }` (3-char ISO regex)

**Success (200):** `{ "workspace": { "id": "...", "name": "...", "currency": "USD" } }`

**Errors:**
| HTTP | Code |
|---|---|
| 400 | `invalid_body` (not 3 uppercase letters) |
| 400 | `workspace_mismatch` |
| 401/403/404 | from `requireWorkspaceContext` (owner role) |
| 409 | `workspace_has_data` (any transaction OR bank account exists) |

### 6.2 Plaid Item exchange — new failure mode

**Existing:** various Plaid errors mapped to error codes.

**New:** when `account.balances.iso_currency_code` for any returned account
is null OR differs from `workspace.currency`:

**HTTP 400:**
```json
{
  "error": "currency_mismatch",
  "workspaceCurrency": "CAD",
  "bankCurrency": "USD"
}
```

(If multiple accounts differ, report the first mismatching account's
currency. If null, report `"unknown"`.)

No `PlaidItem` or `BankAccount` rows are persisted. The Plaid public
token is discarded; user has to redo Link if they want to retry.

---

## 7. Files

**Migration:**
- `apps/api/prisma/migrations/<ts>_drop_per_row_currency/migration.sql`

**Schema:**
- `apps/api/prisma/schema.prisma` — remove `currency` columns on Transaction and RecurringExpense (BankAccount.currency stays)

**Shared helper:**
- `apps/api/src/locks/workspace.ts` (new) — `withWorkspaceLock(workspaceId, callback)`. Lock-first transaction wrapper used by every amount-row writer.

**Services:**
- `apps/api/src/transactions/create-manual.ts` (migrate to `withWorkspaceLock`)
- `apps/api/src/recurring/service.ts` (wrap in `withWorkspaceLock`)
- `apps/api/src/categorize/manual-categorize.ts`
- `apps/api/src/budgets/service.ts` (wrap `setBudgetService` in `withWorkspaceLock`)
- `apps/api/src/plaid/sync.ts` (wrap in `withWorkspaceLock`)

**Routes:**
- `apps/api/src/routes/transactions.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/recurring.ts`
- `apps/api/src/routes/plaid.ts`
- `apps/api/src/routes/workspaces.ts` — new PATCH handler

**Chat tools that touch Transaction or RecurringExpense currency:**
After dropping `Transaction.currency` and `RecurringExpense.currency`,
any `select: { currency: true }` or `where: { currency: ... }` against
those models fails the Prisma validator. Strip filters (mismatched rows
cannot exist when single-currency-per-workspace is enforced) and swap
response currency for the workspace value.

- `apps/api/src/chat/tools/find-transactions.ts` — drop `currency: { not: "CAD" }` filter on Transaction, drop `currency: "CAD"` from output schema, set response currency from workspace
- `apps/api/src/chat/tools/get-cashflow-summary.ts` — same pattern
- `apps/api/src/chat/tools/get-category-breakdown.ts` — same pattern
- `apps/api/src/chat/tools/compare-spending-periods.ts` — same pattern
- `apps/api/src/chat/tools/detect-recurring-merchants.ts` — drop `currency: true` from `prisma.transaction.findMany select`, drop `r.currency` from the merchant-grouping key (use just `merchantKey`), set response group currency from workspace
- `apps/api/src/chat/tools/find-uncategorized-transactions.ts` — drop `r.currency`; use workspace currency in response
- `apps/api/src/chat/tools/get-transaction-details.ts` — drop `tx.currency` read (column gone). The nested `tx.account.currency` read STAYS (BankAccount column retained); use it for the response's account-level currency. Top-level transaction currency comes from workspace.
- `apps/api/src/chat/tools/list-accounts.ts` — **no change** (BankAccount.currency column retained)
- `apps/api/src/chat/tools/list-recurring.ts` — drop RecurringExpense currency read; set response currency from workspace
- `apps/api/src/chat/tools/add-recurring.ts` — drop the `currency` zod field; ignore if model sends it
- `apps/api/src/chat/tools/compare-spending-vs-budget.ts` — set response currency from workspace; underlying `compareSpendingVsBudgetService` Prisma filter on Transaction is fixed in §5.8

**Tests:**
- `apps/api/tests/workspaces.currency.test.ts` (new) — PATCH route ~6 cases
- `apps/api/tests/plaid.routes.test.ts` — add ~2 currency_mismatch cases
- Existing tests that assert `currency` in response shapes need spot-fixes
  (the shapes stay the same — value computed from workspace.currency
  default `"CAD"`)

No new dependencies.

---

## 8. Tests

### 8.1 `workspaces.currency.test.ts` (new, ~8 cases)

1. PATCH 200 happy: fresh workspace, valid ISO → returns updated workspace
2. PATCH 400 invalid_body: `currency: "us"` (lowercase) → 400
3. PATCH 400 invalid_body: `currency: "DOLLAR"` (too long) → 400
4. PATCH 403 insufficient_role: editor → 403
5. PATCH 409 workspace_has_data: workspace with one bank_account (currency stays on row) but no transaction → 409 `workspace_has_data`
6. PATCH 409 workspace_has_data: workspace with one manual transaction (which atomically creates its Cash bank_account) → 409 `workspace_has_data`
7. PATCH 409 workspace_has_data: workspace with one RecurringExpense (no tx/account) → 409 `workspace_has_data`
8. PATCH 409 workspace_has_data: workspace with one Budget (no tx/account/recurring) → 409 `workspace_has_data`
**Test strategy:** Two layers.

**Layer A — `withWorkspaceLock` spy (deterministic, fast):** Spy on the helper. Each writer test asserts the helper is called before any direct `prisma.transaction.create` / `prisma.budget.upsert` / etc. Because the helper enforces "lock first" internally, calling the helper is sufficient proof. The spy is exact and produces no timing dependence.

**Layer B — Integration race (deterministic via holder lock):** A dedicated holder Prisma client acquires the lock; the candidate writer must block on it; release; assert the writer completes and (where applicable) returns the new currency. Catches the case where a writer mistakenly bypasses the helper.

9. **`withWorkspaceLock` spy assertions (4 cases):** For each of `createManualTransactionService`, `addRecurringService`, `setBudgetService`, and the Plaid exchange route handler:
   - Vi-spy on `withWorkspaceLock` from the helper module. The spy passes through to the real implementation.
   - Vi-spy on every top-level amount-write method the writer COULD call. For each writer, the methods to spy on are:
     - `createManualTransactionService`: `prisma.transaction.create`, `prisma.bankAccount.create` (auto-create Cash account path), `prisma.bankAccount.upsert`.
     - `addRecurringService`: `prisma.recurringExpense.create`, `prisma.recurringExpense.upsert` (the actual method used is `upsert`).
     - `setBudgetService`: `prisma.budget.create`, `prisma.budget.upsert` (the actual method used is `upsert`).
     - Plaid exchange handler: `prisma.plaidItem.create`, `prisma.plaidItem.upsert`, `prisma.bankAccount.create`, `prisma.bankAccount.upsert`.
   - Each of these top-level spies must be called **zero times** in the writer's happy path — all writes must go through the `tx` client provided by the helper callback.
   - Call the writer end-to-end.
   - Assert `withWorkspaceLock` was called with `(workspaceId, callbackFn)`.
   - Assert the top-level `prisma.<table>.create/upsert` spy was called **zero times** — the writer must use the `tx` client passed to the callback, never the top-level `prisma` instance for the amount-table write. This catches both "writer skipped the helper" AND "writer called helper with empty callback then wrote directly".

10. **Integration race (1 case per writer = 4 cases):** Standard Promise.all pattern using a holder Prisma client. Hold `pg_advisory_xact_lock(hashtext(wsId))`. Run the candidate. Assert `Promise.race([candidate, 300ms sleep])` → the timeout wins (candidate is blocked). Release the holder. Assert the candidate resolves. For the manual-tx, recurring, and Plaid candidate that has a currency response field, also update the workspace currency in the holder's tx before release and assert the resolved response shows the new currency.

11. **Plaid in-lock recheck (no race — same holder pattern):** Mock `plaid.itemPublicTokenExchange` + `accountsGet` to return CAD accounts. Holder acquires lock + updates workspace to USD + commits. Now run `POST /plaid/exchange`. The exchange's outer check (read against the pre-PATCH workspace state cached in route ctx) may or may not catch it depending on snapshot timing — what we care about is the IN-LOCK recheck. Assert: response 400 `currency_mismatch`, `plaid_items` count = initial, `bank_accounts` count = initial, mock `itemRemove` called once. (To force the path: pass a `?test_skip_outer_check=1` env-gated flag on the route, or use vi.spyOn to disable the outer check for this test.)
13. **Silent-relabel tripwire (50× coarse run):** A loop of 50 fresh workspaces, each doing `Promise.all([PATCH /currency to "USD", addRecurringService])`. For each iteration assert one of two valid outcomes:
   - **PATCH wins:** PATCH 200, workspace.currency=USD; the recurring call (whichever order) completes successfully and its returned currency matches whatever workspace.currency was at insert time — never the silent-relabel outcome (recurring inserted as old "CAD" but workspace ends up "USD").
   - **Recurring wins:** Recurring 200 with currency="CAD", PATCH 409 `workspace_has_data` (recurring row already exists).
   Acts as a tripwire even if lock-presence tests have gaps.

### 8.2 Plaid currency_mismatch (~2 cases)

Add to existing `plaid.routes.test.ts` mocked exchange test pattern:
1. Plaid exchange returns `iso_currency_code: "USD"` for workspace
   `currency: "CAD"` → 400 `currency_mismatch`, no `plaid_items` /
   `bank_accounts` rows persisted.
2. Plaid exchange returns `iso_currency_code: null` for workspace
   `currency: "CAD"` → 400 `currency_mismatch` (bankCurrency: "unknown").

### 8.3 Existing test fix-ups

- Any test that constructs rows with `currency: "CAD"` (e.g., manual
  inserts via `prisma.transaction.create(...)`) drops that key — column
  is gone.
- Any test that asserts `transaction.currency === "CAD"` in API responses
  still passes because the route handler computes it from workspace
  default `"CAD"`.
- Recurring tests that pass `currency: "USD"` in body verify it is
  ignored (returned response shows workspace.currency).

---

## 9. Acceptance criteria

1. Migration applies cleanly on both `fina` and `fina_test`.
2. All existing tests pass after fix-ups.
3. New PATCH route + Plaid mismatch tests pass.
4. baseline 83/699 → **84 files / ~707 tests** (one new test file + ~6
   cases + 2 plaid cases + small fix-ups).
5. No new dependency.
6. Sanity grep: `grep -rn "currency" apps/api/src/` should show only:
   - `workspace.currency` reads (and `Workspace.currency` schema definition)
   - `bankAccount.currency` / `a.currency` / `tx.account.currency` reads (column retained)
   - **BankAccount writes** of `currency` (manual Cash auto-create from `workspace.currency`; Plaid exchange from `iso_currency_code`)
   - response/field assignments setting `currency: <workspaceCurrencyValue>` for non-account fields
   - the new PATCH route + Plaid mismatch handler
   No `transaction.currency` or `recurringExpense.currency` reads, no
   `currency: { not: "CAD" }` filters on Transaction.

---

## 10. Excluded scope

- FX conversion / multi-currency display
- Cross-workspace data migration
- Aggregation across workspaces in different currencies
- (no longer in scope: `iso_currency_code` is preserved on `BankAccount.currency`)
- UI for "create another workspace in different currency" flow (frontend
  track)
- Auto-suggest workspace.currency from user locale at signup

---

## 11. Follow-up candidates

- **Plan 2-multi-workspace-switcher** — UI for switching between
  same-user workspaces of different currencies.
- **Plan 2-fx-snapshot** — optional read-only display of FX conversion
  rates (no math), if user requests.
- **Plan 1C-account-archive** — archive bank account UX (separate
  consideration; archived accounts already excluded from manual-account
  discriminator).
