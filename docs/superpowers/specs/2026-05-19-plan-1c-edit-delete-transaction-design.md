# Plan 1C-edit-delete-transaction — manual edit + soft delete HTTP endpoints

**Date:** 2026-05-19
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes), follow-up to 1C-add-transaction. Provides the
counterpart to `POST /workspaces/:id/transactions/manual`: partial edits for
manual transactions and soft-delete for both manual and Plaid transactions.

---

## 1. Goal

Two HTTP endpoints:

- **`PATCH /workspaces/:id/transactions/:txId`** — partial update of a
  manual transaction's user-facing fields.
- **`DELETE /workspaces/:id/transactions/:txId`** — soft-delete (set
  `removedAt`) for both manual and Plaid transactions.

The existing `removedAt` column already powers list-side filtering
(`includeRemoved=false` default in `GET /workspaces/:id/transactions`), so
no new column is needed.

### Out of scope

| Item | Why deferred |
|---|---|
| **Split transactions** | Separate sync-conflict design + parent/child model + UI. Becomes `1C-split-transaction`. |
| **Plaid tx direct field edit** (amount/date/merchant) | Sync re-pull conflicts with user edits. Categorize/note for Plaid tx already use existing endpoints. |
| **Restore endpoint** (un-set `removedAt`) | YAGNI. Plaid `markRemoved` already no-ops on already-removed rows; user restore is rare and can be re-imported via Plaid or re-entered as manual. |
| **Web/Mobile UI** | Separate plan. This plan ships API + smoke only. |
| **Chat tool** (`editTransaction`/`removeTransaction` LLM dispatch) | Out of scope. UI-driven only for v1. |
| **HTTP audit log** | Consistent with `1C-add-transaction §2` ("HTTP routes are not audited in v1"). Deferred to `1C-audit-http`. |

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Surface | REST verbs — `PATCH /workspaces/:id/transactions/:txId`, `DELETE /workspaces/:id/transactions/:txId` |
| Role gate | `editor+` via `requireWorkspaceContext` |
| Tier gate | None — Free-tier users use manual tx as primary path |
| Confirmation | None — destructive ops protected by soft-delete (`removedAt`) and route-level role check |
| Editable fields (PATCH) | `amount`, `merchantRaw`, `occurredAt`, `categoryId`, `note` |
| PATCH only-manual rule | `source !== "manual"` → 400 `not_editable`. Plaid tx must use existing `/categorize` or future split flow. |
| PATCH already-removed rule | `removedAt != null` → 400 `already_removed`. User must restore (out of scope) before editing. |
| DELETE applies to | Manual tx (any state). Plaid tx **only when `pending = false`** — see §6. Pending Plaid tx → 400 `cannot_delete_pending`. |
| DELETE idempotent | Already-removed tx → 200 `{ removed: false, alreadyRemoved: true }`. No DB write, no audit row, no error. |
| `categorizationSource` on edit | If PATCH sets `categoryId` to non-null → `categorizationSource = "manual"`. If PATCH clears (`null`) → `categorizationSource = null`. Otherwise untouched. |
| `merchantNormalized` on edit | If PATCH changes `merchantRaw` → recompute via `normalizeMerchant` and write. Otherwise untouched. |
| Currency | Workspace-scoped (per `1C-currency-unify`). No per-row currency field. Response surfaces `workspace.currency` for client display. |
| Concurrency | Per-workspace serialization via `withWorkspaceLock(workspaceId, ...)`. Reads + write happen under the lock. |
| Audit log | Out of scope. Deferred to `1C-audit-http`. |

---

## 3. Data model

No schema changes. Reuses existing fields:

- `Transaction.removedAt: DateTime?` — set on soft delete, cleared only by Plaid pending→posted promotion (see §6).
- `Transaction.categorizationSource: CategorizationSource?` — already in use by `applyManualCategorize`.

---

## 4. API surface

### 4.1 PATCH `/workspaces/:id/transactions/:txId`

**Request body (all fields optional, partial update):**

```ts
{
  amount?: number;          // > 0, ≤ 999_999_999.99, ≤ 2 decimal places
  merchantRaw?: string;     // 1-200 chars after trim
  occurredAt?: string;      // "YYYY-MM-DD"
  categoryId?: string | null;  // null clears; non-null must exist & not archived in this workspace
  note?: string | null;     // null clears; ≤ 1000 chars
}
```

**Body parser semantics:**

- The Zod body schema is `.strict()` — unknown keys (typos like `merchant` instead of `merchantRaw`) → 400 `invalid_body`.
- Omitted field → leave column unchanged.
- Field set to `null` (for nullable columns: `categoryId`, `note`) → clear column.
- For non-nullable columns (`amount`, `merchantRaw`, `occurredAt`): the Zod schema does NOT mark them `.nullable()`. `null` fails Zod parsing → 400 `invalid_body`. No separate `invalid_<field>` path for nulls.
- Empty body `{}` → no-op; return current tx unchanged (200).

**Pre-checks (in lock):**

1. Tx exists in `:id` workspace → else 404 `not_found`.
2. `source === "manual"` → else 400 `not_editable`.
3. `removedAt === null` → else 400 `already_removed`.
4. If `categoryId` non-null: category exists in workspace AND `archivedAt === null` → else 404 `category_not_found`.

**Response (200):**

```ts
{
  transaction: {
    id: string;
    amount: string;            // Prisma.Decimal.toString() — matches POST /manual and GET shape
    currency: string;          // workspace.currency
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;        // ISO
    note: string | null;
    source: "manual";
    accountId: string;
    createdAt: string;         // ISO
    updatedAt: string;         // ISO (always — even for empty-body no-op, return DB row's current updatedAt)
  }
}
```

**Errors:**

| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_body` | Zod parse failure |
| 400 | `invalid_amount` | Amount fails the same validator as `create-manual` |
| 400 | `invalid_date` | Date fails `YYYY-MM-DD` validator |
| 400 | `invalid_merchant` | Length out of bounds |
| 400 | `invalid_note` | Length > 1000 |
| 400 | `not_editable` | Tx source != manual |
| 400 | `already_removed` | Tx has `removedAt != null` |
| 401 | (Better Auth default) | No session |
| 403 | `insufficient_role` | Membership < editor |
| 400 | `workspace_mismatch` | Path `:id` != session's active workspace |
| 404 | `not_found` | Tx not in workspace |
| 404 | `category_not_found` | `categoryId` non-null but not in workspace |

### 4.2 DELETE `/workspaces/:id/transactions/:txId`

**Request:** no body.

**Pre-checks (in lock):**

1. Tx exists in `:id` workspace → else 404 `not_found`.
2. If `pending === true` AND `plaidTransactionId !== null` → 400 `cannot_delete_pending`. See §6 for the durability reason. Manual tx (`plaidTransactionId === null`) is never "pending" in the Plaid sense — its `pending` column is always `false` (per `create-manual.ts`), so the gate only ever rejects Plaid pending tx.

**Logic:**

- If `removedAt === null`: set `removedAt = now()`. Return `{ removed: true }`.
- If `removedAt != null`: idempotent no-op. Return `{ removed: false, alreadyRemoved: true }`.

**Response (200):**

```ts
{ removed: boolean; alreadyRemoved?: true }
```

**Errors:** same auth/role/workspace gates as PATCH. 404 `not_found` if tx missing. 400 `cannot_delete_pending` for Plaid pending tx.

---

## 5. Architecture

### 5.1 New / changed files

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/transactions/validators.ts` | NEW | `validateAmount`, `validateMerchantRaw`, `validateNote`, `parseOccurredAt` — extracted from `create-manual.ts`. Shared between create + edit. |
| `apps/api/src/transactions/create-manual.ts` | MODIFY | Replace inline validators with imports from `validators.ts`. Behavior unchanged. |
| `apps/api/src/transactions/edit.ts` | NEW | `editTransactionService(ctx, txId, input)` + `EditTxError`. |
| `apps/api/src/transactions/remove.ts` | NEW | `removeTransactionService(ctx, txId)` + `RemoveTxError`. |
| `apps/api/src/categorize/manual-categorize.ts` | MODIFY | Wrap the existing `$transaction` body in `withWorkspaceLock(workspaceId, ...)` and re-read the tx **inside** the lock so a concurrent PATCH (or anything writing `merchantRaw`/`merchantNormalized`) cannot leave `merchantNormalized` stale relative to `merchantRaw`. The category lookup may stay outside the lock (it's read-only and cheap; archiving races are pre-existing and out of scope). See §6 for the race scenario. |
| `apps/api/src/routes/transactions.ts` | MODIFY | Add `PATCH` and `DELETE` handlers wiring to the services. |
| `apps/api/tests/transactions.validators.test.ts` | NEW | Unit tests for the shared validators. |
| `apps/api/tests/transactions.edit.service.test.ts` | NEW | Unit tests for `editTransactionService`. |
| `apps/api/tests/transactions.remove.service.test.ts` | NEW | Unit tests for `removeTransactionService`. |
| `apps/api/tests/transactions.edit.route.test.ts` | NEW | Route integration: status codes, body parsing (including `.strict()` reject of unknown keys), role gate. |
| `apps/api/tests/transactions.remove.route.test.ts` | NEW | Route integration: status codes, idempotent path, `cannot_delete_pending` for Plaid pending. |
| `apps/api/tests/transactions.edit.race.test.ts` | NEW | Lock serialization test: two concurrent PATCHes resolve linearly. Also covers PATCH-vs-categorize race (concurrent PATCH `merchantRaw` + categorize → final `merchantNormalized` matches final `merchantRaw`). |

### 5.2 Service signatures

```ts
// edit.ts
export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  categoryId?: string | null;
  note?: string | null;
};

export type EditTxResult = {
  transaction: { /* same shape as CreateManualTxResult.transaction, plus updatedAt */ };
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "category_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note";

export class EditTxError extends Error {
  readonly code: EditTxErrorCode;
  constructor(code: EditTxErrorCode);
}

export async function editTransactionService(
  ctx: { workspaceId: string },
  txId: string,
  input: EditTxInput,
): Promise<EditTxResult>;
```

```ts
// remove.ts
export type RemoveTxResult = {
  removed: boolean;
  alreadyRemoved?: true;
};

export type RemoveTxErrorCode = "not_found";

export class RemoveTxError extends Error {
  readonly code: RemoveTxErrorCode;
  constructor(code: RemoveTxErrorCode);
}

export async function removeTransactionService(
  ctx: { workspaceId: string },
  txId: string,
): Promise<RemoveTxResult>;
```

### 5.3 Validators module (shared)

```ts
// validators.ts
export class TxValidationError extends Error {
  readonly code:
    | "invalid_amount" | "invalid_date" | "invalid_merchant" | "invalid_note";
  constructor(code: TxValidationError["code"]);
}

export function validateAmount(amount: number): void;
export function validateMerchantRaw(raw: string): string; // returns trimmed
export function validateNote(note: string | null | undefined): string | null;
export function parseOccurredAt(s: string): Date;
```

**Single strategy:** validators throw their own `TxValidationError`. Each service catches and rethrows as its own error type, mapping the `code` field 1:1:

```ts
// In create-manual.ts and edit.ts:
try { validateAmount(input.amount); }
catch (e) {
  if (e instanceof TxValidationError) throw new CreateManualTxError(e.code); // or EditTxError
  throw e;
}
```

The shared codes (`invalid_amount` / `invalid_date` / `invalid_merchant` / `invalid_note`) are present in both `CreateManualTxErrorCode` and `EditTxErrorCode`, so the 1:1 mapping is type-safe.

### 5.4 Locking

```ts
return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
  const row = await tx.transaction.findFirst({
    where: { id: txId, workspaceId: ctx.workspaceId },
    select: { /* fields needed */ },
  });
  if (!row) throw new EditTxError("not_found");
  // ... checks + update
  return { transaction: shape(row) };
});
```

All reads (tx existence, category check) and writes happen inside the same Prisma `$transaction` callback with the advisory lock held. Audit log writes (deferred per §1) would happen outside the lock.

### 5.5 Update payload construction (PATCH)

Build the `data` object incrementally:

```ts
const data: Prisma.TransactionUpdateInput = {};
if (input.amount !== undefined)      data.amount = new Prisma.Decimal(input.amount);
if (input.merchantRaw !== undefined) {
  data.merchantRaw = trimmed;
  data.merchantNormalized = normalizeMerchant(trimmed);
}
if (input.occurredAt !== undefined)  data.occurredAt = parseOccurredAt(input.occurredAt);
if (input.categoryId !== undefined) {
  data.categoryId = input.categoryId; // null or string
  data.categorizationSource = input.categoryId === null ? null : "manual";
}
if (input.note !== undefined)        data.note = input.note;

// Empty data → skip the update call; return current row.
if (Object.keys(data).length === 0) return { transaction: shape(row) };

const updated = await tx.transaction.update({
  where: { id: txId },
  data,
  select: { /* full shape */ },
});
```

---

## 6. Concurrency: Plaid sync + categorize interactions

### 6.1 Plaid sync vs. user DELETE

Three sync code paths touch `removedAt`:

| Path | Behavior | Interaction with user soft-delete |
|---|---|---|
| `upsertModified` (Plaid `modified` event) | Updates amount/merchant/etc; does NOT touch `removedAt`. | ✓ User delete persists. |
| `markRemoved` (Plaid `removed` event) | `updateMany where removedAt: null` → no-op if already removed. | ✓ User delete persists. |
| Pending→posted promotion | Forces `removedAt: null` (intentional — re-link pending to posted) at `apps/api/src/plaid/sync.ts:235`. | ✗ Would resurrect a user-deleted pending Plaid tx. |

**Mitigation: reject DELETE for `pending = true && plaidTransactionId != null`** (§4.2 pre-check 2). This avoids the resurrection without a schema change. Users wait for posted, then DELETE.

A future plan (likely bundled with split or audit-http) can introduce `removedReason: PLAID_SYNC | USER` (or `userRemovedAt: DateTime?`) and gate the promotion's clear on the reason. Then we can lift the pending-DELETE restriction.

### 6.2 PATCH vs. categorize race

`applyManualCategorize` reads `merchantRaw` outside any lock, computes `merchantNormalized`, then writes `merchantNormalized` later. A concurrent PATCH that changes `merchantRaw` (which recomputes and writes its own `merchantNormalized`) can interleave such that the categorize's stale `merchantNormalized` overwrites the PATCH's fresh one:

```
T1 (categorize): read merchantRaw="Costco"  → norm="costco"
T2 (PATCH):     write merchantRaw="Walmart", merchantNormalized="walmart"
T1 (categorize): write merchantNormalized="costco"   ❌ inconsistent
```

**Fix in this plan:** `applyManualCategorize` adopts `withWorkspaceLock`. The lock acquires before the existing `prisma.$transaction` body, and the tx read moves inside the lock so it sees post-PATCH state. The category lookup may stay outside (read-only; pre-existing archive races are not introduced by this plan).

### 6.3 PATCH vs. PATCH race

Two concurrent PATCH calls on the same tx → serialized by `withWorkspaceLock`. Final state is one of {T1, T2} (whichever commits second wins), never an interleaved mix. Asserted by §8.5 race test.

### 6.4 PATCH vs. Plaid sync race

PATCH only edits manual tx (`source = "manual"`, no `plaidTransactionId`). Plaid sync only touches rows with a `plaidTransactionId`. Disjoint row sets → no row-level race. The advisory lock is still held by both, which serializes them, but no overlap is expected.

---

## 7. Validation rules (verbatim)

Reuse `create-manual.ts` logic exactly:

```ts
// Amount: Decimal(14, 2). Reject inputs that wouldn't round-trip cleanly.
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999.99) throw new TxValidationError("invalid_amount");
  if (!AMOUNT_RE.test(String(amount))) throw new TxValidationError("invalid_amount");
}

// Date: strict YYYY-MM-DD, anchored at UTC noon.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new TxValidationError("invalid_date");
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new TxValidationError("invalid_date");
  return d;
}

// Merchant: 1-200 chars after trim.
function validateMerchantRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) throw new TxValidationError("invalid_merchant");
  return trimmed;
}

// Note: ≤ 1000 chars; null/undefined → null.
function validateNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (note.length > 1000) throw new TxValidationError("invalid_note");
  return note;
}
```

The PATCH route distinguishes "field omitted" (Zod `undefined`) from "field set to `null`", and uses `.strict()` to reject unknown keys:

```ts
const PatchBody = z
  .object({
    amount: z.number().optional(),
    merchantRaw: z.string().optional(),
    occurredAt: z.string().optional(),
    categoryId: z.string().nullable().optional(),  // null = clear, string = set, omitted = no-op
    note: z.string().nullable().optional(),
  })
  .strict();
```

For non-nullable fields (`amount`, `merchantRaw`, `occurredAt`): we deliberately do NOT use `.nullable()`. Sending `null` for these triggers Zod parse failure → 400 `invalid_body`. Sending unknown keys (e.g., `{ merchant: "Costco" }` typo) also fails parsing → 400 `invalid_body`.

---

## 8. Testing strategy

### 8.1 Validators (unit)

`apps/api/tests/transactions.validators.test.ts`

- `validateAmount`: 0 / negative / Infinity / NaN / > max → throws. 0.01 / 1.5 / max-exact → passes. 0.005 / 0.000000001 / 1e20 → throws (regex rejects).
- `parseOccurredAt`: bad format / impossible date / empty → throws. Valid date → returns UTC noon Date.
- `validateMerchantRaw`: empty / 201-char → throws. "  Costco  " → returns "Costco".
- `validateNote`: undefined / null → null. 1000-char → passes. 1001-char → throws.

### 8.2 Edit service (unit)

`apps/api/tests/transactions.edit.service.test.ts`

| Case | Setup | Assertion |
|---|---|---|
| happy 5 fields | manual tx + new category | All fields updated, `merchantNormalized` recomputed, `categorizationSource = "manual"` |
| partial (amount only) | manual tx | Other fields unchanged |
| clear `categoryId` to null | manual tx with category | `categoryId = null`, `categorizationSource = null` |
| clear `note` to null | manual tx with note | `note = null` |
| empty body `{}` | manual tx | Returns current tx, no `update` call (verified via spy) |
| plaid tx | source = plaid | Throws `EditTxError("not_editable")` |
| already-removed | manual tx with `removedAt` set | Throws `EditTxError("already_removed")` |
| wrong workspace | tx in workspace B, ctx workspace A | Throws `EditTxError("not_found")` |
| nonexistent tx | bad txId | Throws `EditTxError("not_found")` |
| archived category | manual tx + archived category | Throws `EditTxError("category_not_found")` |
| invalid amount | 0.005 | Throws `EditTxError("invalid_amount")` |
| invalid date | "2026-13-01" | Throws `EditTxError("invalid_date")` |
| invalid merchant | 201 chars | Throws `EditTxError("invalid_merchant")` |
| invalid note | 1001 chars | Throws `EditTxError("invalid_note")` |

### 8.3 Remove service (unit)

`apps/api/tests/transactions.remove.service.test.ts`

| Case | Setup | Assertion |
|---|---|---|
| happy manual | manual tx | `removed: true`, DB `removedAt != null` |
| happy plaid (posted) | plaid tx, `pending: false` | `removed: true`, DB `removedAt != null` |
| reject plaid pending | plaid tx, `pending: true` | Throws `RemoveTxError("cannot_delete_pending")`, DB `removedAt` unchanged |
| idempotent | tx already removed | `removed: false, alreadyRemoved: true`, DB `removedAt` unchanged (same value) |
| idempotent pending plaid | plaid tx, `pending: true`, already `removedAt != null` | Returns idempotent `{ removed: false, alreadyRemoved: true }` — the pending check applies only to fresh-delete attempts, not to already-removed rows (otherwise an idempotent retry would start failing if Plaid flipped `pending` later) |
| wrong workspace | tx in workspace B | Throws `RemoveTxError("not_found")` |
| nonexistent | bad txId | Throws `RemoveTxError("not_found")` |

### 8.4 Routes (integration)

`apps/api/tests/transactions.edit.route.test.ts`

- PATCH 200 with full body → returns updated tx
- PATCH 200 empty body → no-op (returns current tx, no `update` call)
- PATCH 400 `invalid_body` (bad Zod shape, e.g., `amount: "abc"`)
- PATCH 400 `invalid_body` (null on non-nullable: `amount: null`, `merchantRaw: null`, `occurredAt: null`)
- PATCH 400 `invalid_body` (unknown key: `{ merchant: "Costco" }` typo — `.strict()` rejects)
- PATCH 400 `not_editable` (plaid tx)
- PATCH 400 `already_removed`
- PATCH 400 `workspace_mismatch`
- PATCH 401 (no session)
- PATCH 403 `insufficient_role` (viewer)
- PATCH 404 `not_found` (bad txId)
- PATCH 404 `category_not_found`
- PATCH error → status mapping table verified

`apps/api/tests/transactions.remove.route.test.ts`

- DELETE 200 `{ removed: true }` on first call (manual tx)
- DELETE 200 `{ removed: true }` (posted Plaid tx)
- DELETE 400 `cannot_delete_pending` (pending Plaid tx)
- DELETE 200 `{ removed: false, alreadyRemoved: true }` on second call
- DELETE 401 / 403 / 404 / `workspace_mismatch`

### 8.5 Race (integration)

`apps/api/tests/transactions.edit.race.test.ts`

- **PATCH vs. PATCH:** Two concurrent PATCH calls on same tx with different `amount` → final value is one of the two (not interleaved). Verifies advisory lock serializes.
- **PATCH vs. categorize:** Concurrent PATCH (sets `merchantRaw = "Walmart"`) and `applyManualCategorize` (started before PATCH commit, originally reading `merchantRaw = "Costco"`) → final row has `merchantRaw = "Walmart"` AND `merchantNormalized = normalizeMerchant("Walmart")`. The categorize must see the post-PATCH `merchantRaw` thanks to the lock + re-read added in §5.1 to `manual-categorize.ts`. (Test pattern: use `pg_advisory_lock` from a separate connection to hold the workspace lock, fire categorize in background, release, then PATCH, then assert final state.)

### 8.6 Smoke

`docs/superpowers/smoke-tests/2026-05-19-plan-1c-edit-delete-transaction.md`

1. Create manual tx via POST `/manual` → capture `txId`.
2. PATCH partial (amount only) → 200, GET shows new amount.
3. PATCH full (all 5 fields) → 200, GET shows all updated.
4. PATCH `categoryId: null` → 200, GET shows `categoryId === null`, `categorizationSource === null`.
5. PATCH on Plaid tx (use seeded plaid tx) → 400 `not_editable`.
6. DELETE manual tx → 200 `{ removed: true }`.
7. GET (default `includeRemoved=false`) → tx not in list.
8. GET `?includeRemoved=true` → tx present with `removedAt != null`.
9. DELETE same tx again → 200 `{ removed: false, alreadyRemoved: true }`.

---

## 9. Migration & rollout

No DB migration. Pure additive route + service code.

Rollout: ship behind no flag. PATCH/DELETE are net-new verbs at this URL — no existing client behavior changes.

---

## 10. Reviewer checklist

- [ ] PATCH only allows source = "manual" (Plaid edits routed elsewhere)
- [ ] PATCH refuses already-removed tx (must use DELETE-restore flow, deferred)
- [ ] PATCH body uses `.strict()` — unknown keys → 400 `invalid_body`
- [ ] DELETE rejects `pending && plaidTransactionId != null` fresh deletes with `cannot_delete_pending`
- [ ] DELETE is idempotent for already-removed tx (no error on second call), and the pending-check does NOT block idempotent returns
- [ ] Validators are shared with `create-manual` (no duplication); each service maps `TxValidationError.code` 1:1 to its own error
- [ ] `categorizationSource` updates on category change (null → null, set → "manual")
- [ ] `merchantNormalized` recomputed on `merchantRaw` change
- [ ] Empty PATCH body returns current row (no update call)
- [ ] All reads + writes happen inside `withWorkspaceLock` (PATCH, DELETE, AND the modified `applyManualCategorize`)
- [ ] `applyManualCategorize` re-reads tx INSIDE the lock to avoid stale `merchantRaw` race
- [ ] Plaid sync paths (§6.1) reviewed — pending-DELETE rejection is the gate against pending→posted resurrection
- [ ] Audit log explicitly out of scope (defer to `1C-audit-http`)
- [ ] Amount in response uses `Prisma.Decimal.toString()` (matches POST/GET) — NOT `toFixed(2)`
- [ ] Smoke test covers all paths including idempotent DELETE and Plaid pending rejection
