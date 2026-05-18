# Plan 1C-currency-unify — Workspace.currency as sole source of truth

**Date:** 2026-05-18
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation)

---

## 1. Goal

Make `Workspace.currency` the sole source of truth for currency in a workspace.
Drop per-row `currency` columns from `Transaction`, `BankAccount`, and
`RecurringExpense`. Reject Plaid item connections whose account currencies
differ from the workspace's. Make `PATCH /workspaces/:id/currency` available
only while the workspace has zero transactions and zero bank accounts.

**Product axiom:** workspace == currency boundary. A user wanting to track
multi-currency accounts creates separate workspaces — Fina does not perform
FX conversion in budget/spending math, so mixing currencies in one workspace
would silently produce nonsense.

---

## 2. Background

Currently currency lives in four places (all defaulting to `"CAD"`):
- `Workspace.currency` (added in 1C-add-transaction)
- `BankAccount.currency`
- `Transaction.currency`
- `RecurringExpense.currency`

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
| Per-row currency columns | **Drop** `Transaction.currency`, `BankAccount.currency`, `RecurringExpense.currency` |
| `Workspace.currency` | Stays; sole source of truth |
| Read API responses | Continue to expose `currency` in response payloads; routes look up `workspace.currency` once per request and pass through |
| `addRecurring` request body | Drop the `currency` field (was optional `string.length(3)`); ignore if sent |
| Plaid Item exchange | If any returned account's `iso_currency_code` ≠ `workspace.currency`, reject the exchange with HTTP 400 `currency_mismatch`. No accounts/items persisted. |
| Plaid Item exchange — null iso_currency_code | Treat null/missing as mismatch (reject). Plaid Canada always provides it; null indicates anomalous data or unofficial currency. |
| Plaid `iso_currency_code` on individual transactions during sync | Ignored — the item-level validation at exchange time guarantees workspace consistency, and we no longer have a column to store it. |
| `PATCH /workspaces/:id/currency` | Owner-only. Body: `{ currency: string }` (3-char ISO regex). Reject (409 `workspace_has_data`) if any `Transaction` OR `BankAccount` exists in the workspace. |
| Budget / categorize / spending math | Unchanged — already treats all amounts as same-currency. |
| Migration data loss | Acceptable: all existing rows have `currency = "CAD"` (verified by inspection). No prod data. |

---

## 4. Data model changes

### 4.1 Schema diff

```prisma
model Workspace {
  // ... unchanged
  currency String @default("CAD")   // STAYS
}

model BankAccount {
  // currency String @default("CAD")  ← REMOVE
}

model Transaction {
  // currency String @default("CAD")  ← REMOVE
}

model RecurringExpense {
  // currency String @default("CAD")  ← REMOVE
}
```

### 4.2 Migration

```sql
ALTER TABLE "bank_accounts"      DROP COLUMN "currency";
ALTER TABLE "transactions"       DROP COLUMN "currency";
ALTER TABLE "recurring_expenses" DROP COLUMN "currency";
```

Irreversible. All current rows are `"CAD"` so no information is lost in
practice.

---

## 5. Service / route changes

### 5.1 Manual transaction service

`apps/api/src/transactions/create-manual.ts`:
- Drop `currency: workspace.currency` from the BankAccount create and
  Transaction create payloads (columns no longer exist).
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
- Replace `a.currency` in the response mapper with the workspace's
  currency.

### 5.6 Plaid item exchange

`apps/api/src/routes/plaid.ts`:
- After Plaid's `linkTokenExchange` returns accounts, BEFORE the DB inserts,
  validate every account's `balances?.iso_currency_code`:
  - If any value differs from `workspace.currency`, return
    `400 currency_mismatch` with body
    `{ error: "currency_mismatch", workspaceCurrency: "...", bankCurrency: "..." }`.
  - If any value is null/undefined, also treat as mismatch.
- Remove `currency: a.balances?.iso_currency_code ?? "CAD"` from the
  account insert payload.

### 5.7 Plaid sync

`apps/api/src/plaid/sync.ts`:
- Remove `currency: t.iso_currency_code ?? "CAD"` from the transaction
  insert payload. The item-level validation at exchange time ensures
  consistency.

### 5.8 Budgets service

`apps/api/src/budgets/service.ts`:
- Replace the hardcoded `currency: "CAD"` in response with the workspace's
  currency.

### 5.9 PATCH /workspaces/:id/currency (new)

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
      const [txCount, acctCount] = await Promise.all([
        prisma.transaction.count({ where: { workspaceId: wsId } }),
        prisma.bankAccount.count({ where: { workspaceId: wsId } }),
      ]);
      if (txCount > 0 || acctCount > 0) {
        return reply.code(409).send({ error: "workspace_has_data" });
      }
      const updated = await prisma.workspace.update({
        where: { id: wsId },
        data: { currency: parsed.data.currency },
        select: { id: true, name: true, currency: true },
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
- `apps/api/prisma/schema.prisma` — remove 3 currency columns

**Services:**
- `apps/api/src/transactions/create-manual.ts`
- `apps/api/src/recurring/service.ts`
- `apps/api/src/categorize/manual-categorize.ts`
- `apps/api/src/budgets/service.ts`
- `apps/api/src/plaid/sync.ts`

**Routes:**
- `apps/api/src/routes/transactions.ts`
- `apps/api/src/routes/accounts.ts`
- `apps/api/src/routes/recurring.ts`
- `apps/api/src/routes/plaid.ts`
- `apps/api/src/routes/workspaces.ts` — new PATCH handler

**Tests:**
- `apps/api/tests/workspaces.currency.test.ts` (new) — PATCH route ~6 cases
- `apps/api/tests/plaid.routes.test.ts` — add ~2 currency_mismatch cases
- Existing tests that assert `currency` in response shapes need spot-fixes
  (the shapes stay the same — value computed from workspace.currency
  default `"CAD"`)

No new dependencies.

---

## 8. Tests

### 8.1 `workspaces.currency.test.ts` (new, ~6 cases)

1. PATCH 200 happy: fresh workspace, valid ISO → returns updated workspace
2. PATCH 400 invalid_body: `currency: "us"` (lowercase) → 400
3. PATCH 400 invalid_body: `currency: "DOLLAR"` (too long) → 400
4. PATCH 403 insufficient_role: editor → 403
5. PATCH 409 workspace_has_data: workspace with one bank_account but no transaction → 409 `workspace_has_data`
6. PATCH 409 workspace_has_data: workspace with one manual transaction (which atomically creates its Cash bank_account) → 409 `workspace_has_data`

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
6. Sanity grep: `grep -rn "\.currency" apps/api/src/` should show only:
   - `workspace.currency` reads
   - response `currency: workspaceCurrency` assignments
   No `row.currency` reads or per-row writes for the 3 dropped columns.

---

## 10. Excluded scope

- FX conversion / multi-currency display
- Cross-workspace data migration
- Aggregation across workspaces in different currencies
- Storing `iso_currency_code` from Plaid for audit/forensics (lost — we
  validate at exchange time but don't persist the bank's reported value)
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
