# Plan 1C-split-transaction — unified allocations model

**Date:** 2026-05-19
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes), follow-up to 1C-edit-delete-transaction. Introduces transaction allocations as the single source of truth for tx-to-category attribution.

---

## 1. Goal

Allow a single transaction to be allocated across multiple categories (e.g., Costco $200 → Groceries $120, Household $50, Electronics $30) for budgeting and spending analytics.

The design **unifies** how categories attach to transactions: **every** transaction has ≥1 allocation row in `transaction_allocations`. Non-split tx have exactly one allocation with the full amount. Split tx have ≥2 allocations summing to `tx.amount`. This replaces the previous "`Transaction.categoryId` for normal, `tx_allocations` for split" dual model that was sketched in `1C-edit-delete-transaction §1`.

### Why unified vs dual

We are pre-launch. Migration cost is zero. The dual model branches all category-aware read paths between "use `tx.categoryId`" and "use allocations table"; the unified model has a single read path. `MerchantMapping` and auto-categorize stay as-is conceptually (merchant → one categoryId; auto-categorize writes one allocation row with that category). Future per-allocation features (notes, tax flags) become natural extensions. Engineering cost of the migration is ~15 files but bounded.

### Out of scope

| Item | Why deferred |
|---|---|
| Web/Mobile UI for split | Separate plan |
| Chat tool `splitTransaction` (LLM dispatch) | UI-driven only for v1 |
| HTTP audit log | Consistent with prior 1C plans; deferred to `1C-audit-http` |
| Per-allocation note | YAGNI for v1; unified model makes it cheap to add later |
| Per-allocation tax flag | YAGNI; same as above |

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Storage | New table `transaction_allocations`. Drop `Transaction.categoryId` and `Transaction.categorizationSource`. |
| Allocation FK to category | `categoryId String?` (nullable). Uncategorized tx = one allocation with `categoryId = null`. |
| Per-allocation source | `source CategorizationSource?` (reuse existing enum: `manual | mapping | ai`). |
| Invariants | Every tx has ≥1 allocation. `sum(allocations.amount) = tx.amount` (strict, Decimal-exact). Null `categoryId` is allowed in any allocation regardless of N (split tx mid-edit may have some uncategorized rows). |
| Sum tolerance | None. Inputs must satisfy `sum(amount) === tx.amount` exactly at Decimal(14,2). |
| Split scope | Manual + posted Plaid both eligible. Pending Plaid → `cannot_split_pending`. |
| Surface | Extend existing `PATCH /workspaces/:id/transactions/:txId` with an `allocations` field. No separate `/split` endpoint. |
| Categorize endpoint | `POST /workspaces/:id/transactions/:txId/categorize` stays. Internally writes single-allocation `[{ categoryId, amount: tx.amount, source: "manual" }]`. Works on split tx too — overwrites the split with a single allocation. |
| Plaid sync (split tx, modified event) | Amount or merchantRaw changes → invalidate allocations (replace with single null-categoryId row) + set `needsReclassification = true`. Other field changes → preserve allocations, update tx fields normally. |
| Plaid sync (non-split tx, modified event) | Amount changes → update the single allocation's amount to match. MerchantRaw changes → no allocation change. |
| `needsReclassification` flag | New `Boolean` column on Transaction, default false, set by Plaid sync on invalidation, cleared on next PATCH with allocations. |
| GET response | Each tx surfaces `allocations: [{ categoryId, amount, source }]`. No tx-level `categoryId` field. |
| List filter `?categoryId=X` | Matches tx that have ≥1 allocation with `categoryId = X`. A split tx with Groceries+Electronics matches both filters. |
| Distinct categoryIds per tx | Not enforced — duplicates legal but not useful. Client/UX prevents. |
| Audit | Out of scope, consistent with prior 1C plans. |
| Role gate | `editor+` for PATCH and categorize (unchanged). |

---

## 3. Data model

### 3.1 New table

```prisma
model TransactionAllocation {
  id            String                @id @default(cuid())
  transactionId String
  categoryId    String?               // nullable = uncategorized
  amount        Decimal               @db.Decimal(14, 2)
  source        CategorizationSource? // manual | mapping | ai | null
  createdAt     DateTime              @default(now())
  updatedAt     DateTime              @updatedAt

  transaction Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  category    Category?   @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  @@index([transactionId])
  @@index([categoryId])
  @@index([categoryId, transactionId])  // composite: supports budget/category aggregation queries
  @@map("transaction_allocations")
}
```

Notes:
- `onDelete: Cascade` on Transaction → deleting a tx (hard delete) drops allocations. Soft delete (`removedAt`) leaves allocations intact (they still resolve via FK).
- `onDelete: Restrict` on Category → can't archive a category that's referenced by any allocation. Today categories support `archivedAt` (soft archive) which doesn't trigger the Restrict — archived categories continue to back existing allocations, only blocked from new allocations.
- No `@@unique([transactionId, categoryId])` constraint — duplicates legal (rare but possible) and the cost of enforcing it isn't worth it.

### 3.2 Transaction model changes

```prisma
model Transaction {
  // ... existing fields
  // DROP: categoryId String?
  // DROP: categorizationSource CategorizationSource?
  // ADD:
  needsReclassification Boolean @default(false)

  allocations TransactionAllocation[]
  // DROP relation: category Category? @relation(...)
}
```

Drop:
- `Transaction.categoryId` (and its FK to Category)
- `Transaction.categorizationSource`
- The `@@index([workspaceId, categoryId])` on Transaction (replaced by per-allocation indexes).

Add:
- `Transaction.needsReclassification` boolean
- `Transaction.allocations` relation array

### 3.3 Category model

```prisma
model Category {
  // ... existing fields
  // DROP relation: transactions Transaction[]  (no longer linked directly)
  // ADD:
  allocations TransactionAllocation[]
}
```

### 3.4 Migration

Single migration `<timestamp>_unified_allocations`:

```sql
-- 1. Create the new table
CREATE TABLE "transaction_allocations" (
  "id"             TEXT PRIMARY KEY,
  "transactionId"  TEXT NOT NULL,
  "categoryId"     TEXT,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "source"         "CategorizationSource",
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transaction_allocations_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE,
  CONSTRAINT "transaction_allocations_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT
);
CREATE INDEX "transaction_allocations_transactionId_idx" ON "transaction_allocations"("transactionId");
CREATE INDEX "transaction_allocations_categoryId_idx"    ON "transaction_allocations"("categoryId");
CREATE INDEX "transaction_allocations_categoryId_transactionId_idx"
  ON "transaction_allocations"("categoryId", "transactionId");

-- 2. Add the new flag
ALTER TABLE "transactions" ADD COLUMN "needsReclassification" BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Backfill: one allocation per existing tx
--    Generate cuid via gen_random_uuid()::text (Postgres has uuid, Prisma uses cuid; for
--    backfill, an opaque pkey is fine since allocations are joined by transactionId).
--    NOTE: this assumes pgcrypto extension is available. If not, use a different uuid source.
INSERT INTO "transaction_allocations"
  ("id", "transactionId", "categoryId", "amount", "source", "createdAt", "updatedAt")
SELECT
  'allo_' || replace(gen_random_uuid()::text, '-', '')  AS id,
  t."id"                                                AS "transactionId",
  t."categoryId",
  t."amount",
  t."categorizationSource"                              AS "source",
  COALESCE(t."createdAt", CURRENT_TIMESTAMP),
  COALESCE(t."updatedAt", CURRENT_TIMESTAMP)
FROM "transactions" t;

-- 4. Sanity guard: every tx now has exactly one allocation summing to tx.amount
DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM (
    SELECT t."id", t."amount" AS tx_amount, COALESCE(SUM(a."amount"), 0) AS alloc_sum
    FROM "transactions" t
    LEFT JOIN "transaction_allocations" a ON a."transactionId" = t."id"
    GROUP BY t."id", t."amount"
  ) s
  WHERE s.alloc_sum <> s.tx_amount;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Allocation backfill mismatch: % rows have sum(allocations.amount) != tx.amount. Aborting migration.', bad_count;
  END IF;
END $$;

-- 5. Drop the old columns + index
DROP INDEX IF EXISTS "transactions_workspaceId_categoryId_idx";
ALTER TABLE "transactions" DROP COLUMN "categoryId";
ALTER TABLE "transactions" DROP COLUMN "categorizationSource";
```

The DO-block safety guard fails the migration loudly if any tx ends up with a sum mismatch — catches data corruption before the columns are dropped (still recoverable).

`gen_random_uuid()` is built into Postgres 16 core (no extension needed). Verified by the existing precedent at `apps/api/prisma/migrations/20260512170759_add_categorize/migration.sql:46-50`.

---

## 4. API surface

### 4.1 `PATCH /workspaces/:id/transactions/:txId` (extended)

**Body (all optional, partial update):**

```ts
{
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;          // YYYY-MM-DD
  note?: string | null;
  // NEW: single-category shortcut. Mutually exclusive with `allocations`.
  categoryId?: string | null;
  // NEW: full allocations replacement.
  allocations?: Array<{ categoryId: string | null; amount: number }>;
}
```

**Body parser rules** (Zod schema is `.strict()`):
- `categoryId` and `allocations` are **mutually exclusive**. Providing both → 400 `invalid_body`.
- `allocations` provided (any length): replaces all allocations atomically.
- `categoryId` provided: shortcut for `allocations: [{ categoryId, amount: <tx.amount AFTER any amount edit> }]`.
- Neither provided: allocations unchanged.

**Allocation validation (in lock):**
- Each entry's `amount > 0`, `≤ 999_999_999.99`, ≤ 2 decimal places (same `AMOUNT_RE` as create-manual).
- Each non-null `categoryId` must exist in workspace AND `archivedAt = null`. Else 404 `category_not_found`.
- `sum(allocations.amount) === effective_tx_amount` (the tx.amount AFTER applying any `input.amount` field in the same PATCH). Strict Decimal equality. Else 400 `sum_mismatch`.
- `allocations.length >= 1`. Empty array → 400 `invalid_body`.

**Pending Plaid gate**: applies whenever `allocations` is provided (or `categoryId` shortcut, which is also allocations). If `pending === true && plaidTransactionId !== null` → 400 `cannot_split_pending`.

**categorizationSource on PATCH**: any allocation written via PATCH gets `source = "manual"`. (The route is user-driven by definition.)

**`needsReclassification` clearing rule** — clears to `false` ONLY when PATCH includes `allocations` or `categoryId` in the body (the user-driven categorization paths). A PATCH that only edits `amount` / `merchantRaw` / `occurredAt` / `note` does NOT clear the flag, even if the single-allocation amount gets passively updated to track a new `tx.amount`. The flag is a signal "user has not yet re-classified after Plaid invalidation"; only an explicit categorization clears it.

**Pre-checks (in lock):**
1. Tx exists in workspace → else 404 `not_found`.
2. **Per-field source check** — let `manualOnlyFieldProvided = (amount || merchantRaw || occurredAt || note) is in body`. If `manualOnlyFieldProvided && tx.source !== "manual"` → 400 `not_editable`. Conversely, a Plaid posted tx may submit ONLY `categoryId` and/or `allocations` and proceed. See §4.1.1 for the partition rationale.
3. `removedAt === null` → else 400 `already_removed`.

### 4.1.1 Plaid tx editability nuance

A user-driven categorization change to a Plaid tx is legitimate. The existing rule "PATCH is manual-only" was to block users from editing Plaid-pulled amount/merchant. **In this plan, that rule is partitioned:**

- `amount`, `merchantRaw`, `occurredAt`, `note` — manual-only (existing rule).
- `categoryId` shortcut OR `allocations` — works on **manual + posted Plaid** tx.

So a PATCH body on a Plaid tx that contains only `allocations` (or only `categoryId`) is accepted. A PATCH body on a Plaid tx that contains `amount` or `merchantRaw` is rejected with `not_editable`.

The check is per-field. Pending Plaid still gates the entire PATCH if allocations are provided (`cannot_split_pending`).

### 4.1.2 Response

```ts
{
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: string | null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    occurredAt: string;
    pending: boolean;
    source: TransactionSource;
    note: string | null;
    removedAt: string | null;
    needsReclassification: boolean;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;          // toFixed(2) or toString — match list shape
      source: CategorizationSource | null;
    }>;
  };
}
```

Note: `categoryId` and `categorizationSource` are GONE from the tx-level response (single source of truth = allocations). Clients reading these from old responses must switch to `allocations[0]` for non-split tx.

### 4.2 `DELETE /workspaces/:id/transactions/:txId`

Unchanged from `1C-edit-delete-transaction`. Soft-delete sets `removedAt`. Allocations remain (resolved by FK; soft-deleted tx is just hidden from default queries via `removedAt IS NULL` filter).

### 4.3 `POST /workspaces/:id/transactions/:txId/categorize`

**Existing endpoint preserved.** Body: `{ categoryName }`.

Behavior in unified model:
- Find/lookup category by case-insensitive name in workspace.
- Replace all allocations atomically with single entry: `[{ categoryId: <found>, amount: tx.amount, source: "manual" }]`.
- This works on split tx — categorize overwrites the split. No `already_split` error.
- `needsReclassification` cleared on this write.

This route remains as a UX/chat-tool shortcut. The PATCH route with `categoryId` shortcut is equivalent.

**Response shape update**: `ManualCategorizeResult.tx` drops `categoryId` and `categorizationSource` and gains `allocations: [...]` (same shape as the GET/PATCH response). Chat tool `categorizeTransaction` consumers update accordingly.

**LLM tool-result contract:** the chat tool's `ToolDef<Args, Result>` declares `Result` as the structured payload returned to the LLM. Changing `tx.categoryId` → `tx.allocations[0].categoryId` in the response means any prompt-side documentation of the tool's return shape must be regenerated. Audit: `apps/api/src/chat/tools/categorize-transaction.ts` declares the result type but the LLM-facing tool schema (`args` Zod) is the only thing serialized into the prompt today — verify before/after the change. If response-shape examples appear in the LLM system prompt, regenerate them.

### 4.4 `GET /workspaces/:id/transactions`

Response: each tx includes `allocations: [...]` and `needsReclassification: bool` (and drops `categoryId` / `categorizationSource`).

Filter `?categoryId=X`: matches tx where ≥1 allocation has `categoryId = X` AND `removedAt IS NULL` for the tx.

```sql
WHERE t."workspaceId" = $ws
  AND t."removedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM transaction_allocations a
    WHERE a."transactionId" = t."id" AND a."categoryId" = $cat
  )
```

Filter `?uncategorizedOnly=true`: matches tx where ≥1 allocation has `categoryId IS NULL` (any uncategorized portion). This matches the spirit of today's `categoryId IS NULL` filter — if any portion is uncategorized, the tx surfaces.

---

## 5. Architecture

### 5.1 Files

| File | Action | Responsibility |
|---|---|---|
| `apps/api/prisma/schema.prisma` | MODIFY | Add `TransactionAllocation`, drop `Transaction.categoryId`/`categorizationSource`, add `needsReclassification`, drop the workspaceId/categoryId index on Transaction. |
| `apps/api/prisma/migrations/<ts>_unified_allocations/migration.sql` | NEW | Single migration per §3.4. |
| `apps/api/src/transactions/allocations.ts` | NEW | `applyAllocations(tx, txId, allocations, txAmount)` — shared helper to validate + replace allocations atomically. Used by edit, categorize, create-manual, plaid sync invalidation. |
| `apps/api/src/transactions/create-manual.ts` | MODIFY | Create tx + 1 allocation in same lock. Optional input.categoryId → allocation.categoryId. Response shape: drop `categoryId`/`categorizationSource`, add `allocations`. |
| `apps/api/src/transactions/edit.ts` | MODIFY | Extend `EditTxInput` with `allocations?` and keep `categoryId?` (shortcut). New validation path. Partition Plaid-tx rule by field. Response shape match. |
| `apps/api/src/transactions/remove.ts` | NO CHANGE | Soft delete; allocations left intact. |
| `apps/api/src/categorize/manual-categorize.ts` | MODIFY | Replace tx.categoryId writes with allocation replacement. Sibling back-fill: only target tx with N=1 allocation that's uncategorized OR not "manual" sourced. Keep the workspace lock retrofit from 1C-edit-delete. |
| `apps/api/src/categorize/service.ts` | MODIFY | Auto-categorize: instead of updating tx.categoryId, replace allocations to `[{categoryId, amount: tx.amount, source: "ai"}]`. Skip tx where allocations.length > 1 (don't auto-clobber user's split). |
| `apps/api/src/categorize/map-merchant.ts` | MODIFY | Apply mapping: similar — replace allocations with single mapping-sourced entry. Skip tx with N>1 allocations. |
| `apps/api/src/plaid/sync.ts` | MODIFY | `upsertModified` extended: for tx with allocations (which is all tx now), if amount or merchantRaw changed AND allocations.length > 1 → invalidate (replace with single null-cat allocation, set needsReclassification). For N=1, just update the allocation.amount to match new tx.amount. Other plaid sync paths (`upsertAdded`, pending→posted promotion): create allocation for new tx, preserve allocation on promotion (just update amount if changed). |
| `apps/api/src/routes/transactions.ts` | MODIFY | PATCH body schema extended with `categoryId`/`allocations`; error mapping adds `sum_mismatch`, `cannot_split_pending`. GET response shape. Categorize route's downstream service stays the same (already returns the post-write tx). |
| `apps/api/src/budgets/service.ts` | MODIFY | `compareSpendingVsBudget` groups by `allocation.categoryId` joining `transactions` for workspace/period/removed filters. |
| Chat tools — `apps/api/src/chat/tools/*.ts` (~10 files) | MODIFY | Every read of `tx.categoryId` becomes a join on allocations. Response shapes updated. List below. |

### 5.1.1 Chat tools that read `tx.categoryId` today

All need to be reworked to use allocations:

- `find-transactions.ts` (filter by category — match tx where ≥1 allocation has categoryId = X)
- `find-uncategorized-transactions.ts` (see §5.1.2 below — two modes)
- `get-category-breakdown.ts` (group by allocation.categoryId, sum allocation.amount)
- `get-spending-summary.ts` (similar)
- `get-cashflow-summary.ts` (only sums signed amount — no allocation join needed; unchanged)
- `compare-spending-periods.ts` (group by category)
- `list-transactions.ts` (return allocations array)
- `get-transaction-details.ts` (return allocations array)
- `categorize-transaction.ts` (writes single allocation via service)
- `add-transaction-note.ts` (no category, unchanged)

### 5.1.2 `find-uncategorized-transactions` unified semantics

The tool today filters via `categoryId IS NULL OR categorizationSource != "manual"`. Two modes mapped to unified:

- **Mode `uncategorized` (default)** — tx has ≥1 allocation with `categoryId IS NULL`. Matches the spirit of "this tx has unclassified portion".
- **Mode `not_manual`** — tx has any allocation where `source != "manual"` OR `categoryId IS NULL`. The intent is "tx that hasn't been user-confirmed", so even AI/mapping-sourced single allocations qualify. For a split tx (N≥2), if ANY allocation is not manual-sourced, the tx qualifies. This is consistent with the old per-tx `categorizationSource != "manual"` rule.

A split tx where all N allocations have `source = "manual"` is considered fully user-confirmed and is excluded from `not_manual`.

### 5.2 Shared `applyAllocations` helper

```ts
// transactions/allocations.ts

export type AllocationInput = { categoryId: string | null; amount: number };

export type AllocationErrorCode =
  | "invalid_allocation_amount"
  | "sum_mismatch"
  | "category_not_found"
  | "empty_allocations";

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  constructor(code: AllocationErrorCode);
}

/**
 * Replace all allocations for a transaction atomically. MUST be called inside
 * a withWorkspaceLock callback. Validates amounts, sum, and category existence.
 *
 * @param tx          Prisma TransactionClient from withWorkspaceLock
 * @param workspaceId
 * @param txId        Target transaction id
 * @param txAmount    Authoritative tx.amount (Prisma.Decimal) — sum must match
 * @param source      CategorizationSource for every new allocation row
 * @param allocations Array of (categoryId, amount) pairs
 */
export async function applyAllocations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  txId: string,
  txAmount: Prisma.Decimal,
  source: "manual" | "mapping" | "ai" | null,
  allocations: AllocationInput[],
): Promise<void>;
```

The helper:
1. Validates length ≥ 1 (≥1 throws empty_allocations).
2. Validates each amount via shared validator (`invalid_allocation_amount`).
3. Validates `sum === txAmount` exactly (`sum_mismatch`).
4. For each non-null categoryId, checks existence + non-archived (`category_not_found`).
5. `tx.transactionAllocation.deleteMany({ where: { transactionId } })`.
6. `tx.transactionAllocation.createMany({ data: [...] })`.
7. Sets `tx.transaction.update({ where: { id: txId }, data: { needsReclassification: false } })`.

Every write inside this helper uses the `tx` (TransactionClient) parameter passed in. The helper itself does NOT take the workspace lock — caller must already hold it.

### 5.3 Locking

All allocation writes go through `applyAllocations` which expects to be called inside `withWorkspaceLock`. The relevant call sites:

- `editTransactionService` — existing `withWorkspaceLock` callback. Pre-checks → input parse → `applyAllocations` (if allocations provided) → tx field update → response.
- `applyManualCategorize` — existing `withWorkspaceLock` (added in 1C-edit-delete-transaction). Replaces tx-level write with `applyAllocations` call.
- `createManualTransactionService` — existing `withWorkspaceLock`. After `tx.transaction.create(...)`, call `applyAllocations` with single entry (or single null-category entry if no input.categoryId).
- `upsertModified` (Plaid sync) — wrapped in `withWorkspaceLock` per page already (`apps/api/src/plaid/sync.ts`). Add the invalidation logic inside.

**Auto-categorize and map-merchant — DO NOT add `withWorkspaceLock`.** Both run as batch ingest in a hot path; adding a workspace-wide lock would serialize all ingestion. Instead, use per-row atomic update with a `where`-clause guard that makes the update idempotent and safe against concurrent user PATCH:

```ts
// Auto-categorize (Gemini result) — service.ts Step 3
await tx.transactionAllocation.updateMany({
  where: {
    transactionId: targetTxId,
    source: null,           // only update an unclassified allocation
    categoryId: null,       // and only if still uncategorized
  },
  data: { categoryId: aiResult.categoryId, source: "ai" },
});
```

This is safe because:
1. The `where` clause matches only allocations that are still in the "uncategorized, no source" state. If a concurrent user PATCH already set the category (source="manual"), the `updateMany` matches 0 rows and is a no-op — user wins.
2. `updateMany` is a single SQL statement, atomic at the row level.
3. We also gate the BATCH-level lookup: `service.ts` queries `newTxIds` where the tx has exactly 1 allocation AND that allocation has `categoryId IS NULL` (see §6.2). A tx that's already been split (N≥2) is excluded from the batch entirely.

The same pattern applies to map-merchant (`source: "mapping"`).

The 1C-edit-delete-transaction plan already retrofitted `applyManualCategorize` to use `withWorkspaceLock` because it does multi-row sibling back-fill. Auto-categorize/map-merchant are simpler (per-tx atomic) and don't need the lock.

### 5.4 Plaid sync interaction (full spec)

`apps/api/src/plaid/sync.ts:upsertModified`, `upsertAdded` (incl. its pending→posted promotion branch), and `markRemoved` all write tx fields. With allocations as the source of truth, all paths must keep the invariant `sum(allocations.amount) = tx.amount`.

**`upsertModified` (modified event):** today uses `updateMany({ where: { workspaceId, plaidTransactionId } })` with no `removedAt` filter — soft-removed rows still get their fields updated to stay consistent with Plaid's view. We preserve that behavior with `findFirst` (also no `removedAt` filter) so a soft-removed split tx still gets its allocations kept consistent:

```ts
async function upsertModified(tx, plaidTx, workspaceId) {
  const existing = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId: plaidTx.transaction_id }, // NOTE: no removedAt filter — match today's updateMany scope
    include: { allocations: { select: { id: true, amount: true } } },
  });
  if (!existing) return; // shouldn't happen for `modified` event; matches today's no-op when row missing
  const oldAmount = existing.amount;
  const newAmount = new Prisma.Decimal(plaidTx.amount);
  const amountChanged = !oldAmount.equals(newAmount);
  const newMerchantRaw = plaidTx.merchant_name ?? plaidTx.name ?? "Unknown";
  const merchantChanged = existing.merchantRaw !== newMerchantRaw;
  const N = existing.allocations.length;

  const txDataBase = {
    amount: newAmount, merchantRaw: newMerchantRaw,
    occurredAt: plaidOccurredAt(plaidTx),
    postedAt: plaidPostedAt(plaidTx),
    pending: plaidTx.pending,
    rawData: plaidTx as Prisma.InputJsonValue,
  };

  if (N >= 2 && (amountChanged || merchantChanged)) {
    // Invalidate split: replace allocations with 1 null-cat row, set flag
    await tx.transactionAllocation.deleteMany({ where: { transactionId: existing.id } });
    await tx.transactionAllocation.create({
      data: { transactionId: existing.id, categoryId: null, amount: newAmount, source: null },
    });
    await tx.transaction.update({
      where: { id: existing.id },
      data: { ...txDataBase, needsReclassification: true },
    });
  } else {
    // N=1 (any change) OR N≥2 with only metadata changes: preserve allocations
    if (amountChanged && N === 1) {
      // Keep invariant: single allocation.amount tracks tx.amount
      await tx.transactionAllocation.update({
        where: { id: existing.allocations[0]!.id },
        data: { amount: newAmount },
      });
    }
    await tx.transaction.update({
      where: { id: existing.id },
      data: txDataBase,
    });
  }
}
```

**`upsertAdded` fresh-insert path:** create the tx, then create one allocation `{ transactionId, categoryId: null, amount: tx.amount, source: null }`. Auto-categorize fills in `categoryId` + `source` later via the categorize batch step (§6.1).

**`upsertAdded` pending→posted promotion branch (sync.ts:215-238):** today this finds the existing pending tx by `(workspaceId, plaidPendingTransactionId)` and updates fields including `removedAt: null` (intentional resurrection of any pending-side soft-removal). In unified, this branch must ALSO update the single allocation's amount when Plaid's posted amount differs from the pending row's amount:

```ts
const promotion = await tx.transaction.findFirst({
  where: { workspaceId, plaidPendingTransactionId: plaidTx.pending_transaction_id, pending: true },
  include: { allocations: { select: { id: true } } },
});
if (promotion) {
  const newAmount = new Prisma.Decimal(plaidTx.amount);
  // Invariant: pending tx had N=1 allocation (cannot_split_pending blocks user splits).
  // If allocations.length !== 1 here, that's a bug — log + skip the allocation update.
  if (promotion.allocations.length === 1) {
    await tx.transactionAllocation.update({
      where: { id: promotion.allocations[0]!.id },
      data: { amount: newAmount },
    });
  }
  await tx.transaction.update({
    where: { id: promotion.id },
    data: {
      plaidTransactionId: plaidTx.transaction_id,
      plaidPendingTransactionId: plaidTx.pending_transaction_id,
      pending: false,
      occurredAt: plaidOccurredAt(plaidTx),
      postedAt: plaidPostedAt(plaidTx),
      amount: newAmount,
      merchantRaw: plaidTx.merchant_name ?? plaidTx.name ?? "Unknown",
      rawData: plaidTx as Prisma.InputJsonValue,
      removedAt: null, // existing behavior; resurrection issue is gated by cannot_delete_pending
    },
  });
  return { kind: "updated", localId: promotion.id };
}
// ...else fresh insert (handled by upsertAdded outer code)
```

The `promotion.allocations.length === 1` check is a paranoid defensive — `cannot_split_pending` (§4.2 of 1C-edit-delete + this plan §4.1) prevents user split of pending tx, so N must be 1. If we ever find N≠1 in production, log + skip allocation update; the tx row still gets the field update.

**`markRemoved`:** unchanged. Sets `removedAt`. Allocations remain (referenced by FK; only hard delete cascades them). Soft-removed split tx still has its allocations on disk, just hidden from default queries.

Pending DELETE remains gated by `cannot_delete_pending`. Split (PATCH with allocations) on pending Plaid is gated by `cannot_split_pending`.

### 5.5 Service signatures

```ts
// transactions/edit.ts (extended)
export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  note?: string | null;
  // Either (mutually exclusive):
  categoryId?: string | null;
  allocations?: Array<{ categoryId: string | null; amount: number }>;
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "cannot_split_pending"
  | "category_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note"
  | "invalid_allocation_amount"
  | "sum_mismatch"
  | "empty_allocations"
  | "conflicting_body"; // both categoryId AND allocations provided
```

Route maps codes to HTTP status:
- `not_found`, `category_not_found` → 404
- everything else → 400

```ts
// transactions/create-manual.ts (extended)
// Response.transaction loses categoryId; gains allocations: [...].
export type CreateManualTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    needsReclassification: false;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | null;
    }>;
  };
};
```

`createManualTransactionService` body still accepts `categoryId?: string`. Internally:
1. Create tx (no categoryId / source columns to set anymore).
2. Call `applyAllocations(tx, workspaceId, row.id, row.amount, "manual", [{ categoryId: input.categoryId ?? null, amount: input.amount }])`.

---

## 6. Auto-categorize + map-merchant changes

### 6.1 `apps/api/src/categorize/service.ts` (Gemini auto-categorize)

Current flow (Step 3, post-mapping):
1. Reads `newTxIds` with `categoryId: null`.
2. Calls Gemini, parses results.
3. Per result: `tx.transaction.update({ where: { id }, data: { categoryId: catId, categorizationSource: "ai" } })`.

New flow (no workspace lock per §5.3):
1. Reads `newTxIds` where the tx has exactly one allocation AND that allocation has `categoryId IS NULL`. Tx that are already split (N≥2) or already categorized (allocation has source) are excluded from the batch.
2. Calls Gemini (unchanged).
3. Per result: `tx.transactionAllocation.updateMany({ where: { transactionId: id, categoryId: null, source: null }, data: { categoryId: aiCatId, source: "ai" } })`. The `where` guard makes this idempotent and concurrency-safe: if a user PATCH categorizes between batch-read and this write, the `updateMany` matches 0 rows.

The where-clause guard is the entire concurrency mechanism. No lock needed (per §5.3). Last-writer-wins is fine because the where-clause guarantees auto-categorize only fires when state is still untouched.

### 6.2 Step 2 mapping (`map-merchant.ts` and the mapping-application step in service.ts)

Mapping application (per workspace) updates batches of tx that have `merchantNormalized = X` and `categoryId = null` (today). In unified: tx with N=1 allocation that's null-category, matching merchantNormalized.

Pattern (no workspace lock per §5.3):
```ts
// Step 2 in categorize/service.ts after Gemini batch (mapping):
const mappings = await tx.merchantMapping.findMany({ where: { workspaceId } });
for (const [norm, catId] of mappings) {
  // Find target tx: have exactly 1 allocation, that allocation categoryId IS NULL.
  // In unified, every tx has ≥1 allocation, so `some: {}` is defensive (excludes the
  // theoretical N=0 case Prisma's `every` would match vacuously).
  const targets = await tx.transaction.findMany({
    where: {
      workspaceId,
      merchantNormalized: norm,
      allocations: { some: {}, every: { categoryId: null, source: null } },
    },
    include: { allocations: { select: { id: true } } },
  });
  const singleNullTargets = targets.filter((t) => t.allocations.length === 1);
  for (const t of singleNullTargets) {
    // Per-row atomic update with where-clause guard — idempotent, concurrency-safe
    await tx.transactionAllocation.updateMany({
      where: { id: t.allocations[0]!.id, categoryId: null, source: null },
      data: { categoryId: catId, source: "mapping" },
    });
  }
}
```

The `every` filter alone matches a vacuous N=0 case, which by invariant cannot happen — but `some: {}` makes intent explicit and resistant to invariant violations. Filtering to `N === 1` in JS handles "exactly one" (Prisma has no native single-element filter). This whole block runs at ingest time, batch size limited.

### 6.3 `applyManualCategorize` (manual categorize endpoint)

Today: writes tx.categoryId + categorizationSource + back-fills siblings.

New: writes single allocation (replacing whatever's there) + back-fills siblings the same way (single-allocation tx with null categoryId or non-manual source).

The sibling back-fill rule in unified:
- Target sibling tx: same workspaceId + same merchantNormalized + NOT the target tx itself + has exactly 1 allocation.
- For each: if that allocation's `categoryId IS NULL` OR `source != "manual"`, replace with `{ categoryId: target.categoryId, source: "mapping" }`. (Don't overwrite a user-set "manual" source — same semantics as today.)
- Skip siblings with N≥2 allocations (don't clobber user's split).
- **Archived-source sibling allocations:** if a sibling's existing allocation points to an archived category, the back-fill overwrites it (consistent with today's behavior — archive does not protect existing rows from re-categorization). Only the NEW write target (the user-picked category in `applyManualCategorize`) is checked for `archivedAt IS NULL`.

This stays inside `withWorkspaceLock` (already retrofitted in 1C-edit-delete).

---

## 7. Budget + spending logic

`apps/api/src/budgets/service.ts:compareSpendingVsBudget`:

Today:
```ts
const sums = await prisma.transaction.groupBy({
  by: ["categoryId"],
  where: {
    workspaceId, removedAt: null, occurredAt: { gte, lt },
    categoryId: { in: budgetCategoryIds },
    amount: { gt: 0 },
  },
  _sum: { amount: true },
});
```

New (allocations-based):
```ts
const sums = await prisma.transactionAllocation.groupBy({
  by: ["categoryId"],
  where: {
    categoryId: { in: budgetCategoryIds },
    amount: { gt: 0 },
    transaction: {
      workspaceId, removedAt: null,
      occurredAt: { gte, lt },
      amount: { gt: 0 },
    },
  },
  _sum: { amount: true },
});
```

The `amount: { gt: 0 }` on both allocation and transaction guards against refund-style negative entries flowing through. A tx with all positive allocations summing to a positive tx.amount is the normal case.

Chat-tool category breakdowns/summaries follow the same pattern: group by `allocation.categoryId` joined to tx for workspace/period/removed filters.

---

## 8. Testing strategy

### 8.1 Validators / helper (unit)

`apps/api/tests/transactions.allocations.test.ts` (NEW):
- `applyAllocations` rejects empty array → `empty_allocations`
- Rejects sum mismatch (sum < amount, sum > amount, off-by-1-cent) → `sum_mismatch`
- Rejects invalid per-allocation amount (negative, > MAX, 0.005 fraction) → `invalid_allocation_amount`
- Rejects nonexistent or archived categoryId → `category_not_found`
- Happy: 1 allocation null cat (uncategorized)
- Happy: 1 allocation with cat
- Happy: 3 allocations summing to amount
- Resets `needsReclassification` to false on every call

### 8.2 Migration

`apps/api/tests/migrations.unified-allocations.test.ts` (NEW or extended):
- Seed pre-migration: tx with categoryId=X, tx with categoryId=null
- Run migration in test DB
- Assert: tx_allocations row exists per tx with matching amount + categoryId
- Assert: post-migration `sum(alloc.amount) = tx.amount` for every tx (the DO-block guard works)

If existing test-db reset uses `prisma migrate deploy`, the migration is exercised in every test run already — the assertion is the DO-block. Add a separate test only if backfill correctness needs explicit checks.

### 8.3 Edit service

`apps/api/tests/transactions.edit.service.test.ts` (extend):
- New happy path: PATCH with `allocations: [{c1,50},{c2,150}]` on $200 tx → DB has 2 alloc rows
- PATCH `categoryId: X` shortcut → DB has 1 alloc with X, amount = tx.amount
- PATCH both `categoryId` and `allocations` → `conflicting_body` 400
- PATCH `allocations: []` → `empty_allocations` 400
- PATCH allocations sum != tx.amount → `sum_mismatch` 400
- PATCH allocations with nonexistent cat → `category_not_found` 404
- PATCH `amount: 250` AND `allocations: [...sum 250]` (sum matches NEW amount) → 200, both updated
- PATCH `amount: 250` AND `allocations: [...sum 200]` → `sum_mismatch` 400
- PATCH on Plaid pending with `allocations` → `cannot_split_pending`
- PATCH on Plaid posted with `allocations` → 200 (categorization is partition-allowed)
- PATCH on Plaid posted with `amount` → `not_editable` 400 (amount partition rule)
- PATCH on Plaid posted with `categoryId` shortcut → 200 (categorization on Plaid allowed)
- PATCH with `allocations` clears `needsReclassification` to false

### 8.4 Categorize endpoint

`apps/api/tests/categorize.manual-service.test.ts` (extend):
- Already-split tx + categorize → now succeeds, replaces split with single allocation (NOT `already_split` — that error is removed)
- Cat name case-insensitive match (unchanged)
- Back-fill: target sibling with N=1 null-cat allocation gets updated to mapping
- Back-fill: target sibling with N=1 manual-source allocation NOT updated
- Back-fill: target sibling with N≥2 allocations NOT updated (preserves user's split)

### 8.5 Plaid sync edge cases

`apps/api/tests/plaid.sync.unified-alloc.test.ts` (NEW):
- Plaid added: new tx + 1 null-cat allocation
- Plaid modified, N=1, amount changed: tx.amount + allocation.amount both update
- Plaid modified, N=1, amount unchanged: no allocation change
- Plaid modified, N≥2, amount changed: allocations invalidated → 1 null-cat allocation + needsReclassification=true
- Plaid modified, N≥2, merchant changed but amount same: invalidated (per user decision)
- Plaid modified, N≥2, only postedAt/pending changed: allocations preserved
- Plaid removed: tx.removedAt set, allocations untouched (FK cascades on hard delete only)

### 8.6 Auto-categorize + map-merchant

`apps/api/tests/categorize.service.test.ts` (extend):
- Auto-categorize Gemini result: target tx had 1 null-cat allocation → allocation.categoryId set to AI's pick, source="ai"
- Auto-categorize: target tx had N=2 allocations → SKIPPED (user's split preserved)
- Mapping apply: target tx with N=1 null-cat allocation → allocation set to mapping, source="mapping"
- Mapping apply: target tx with N≥2 → SKIPPED

### 8.7 Budget + spending

`apps/api/tests/budgets.service.test.ts` (extend):
- compareSpendingVsBudget: workspace has a tx split across Groceries/Electronics → both categories show their split amount in the response
- Workspace has tx with N=1 null-cat allocation → not counted in any category budget
- Tx with `removedAt` → not counted (allocation join respects tx.removedAt)

### 8.8 Routes (integration)

`apps/api/tests/transactions.edit.route.test.ts` (extend):
- PATCH with `allocations` → 200, response.allocations array matches
- PATCH with `categoryId` shortcut → 200, response.allocations has 1 entry
- PATCH both → 400 `conflicting_body`
- PATCH sum_mismatch → 400 `sum_mismatch`
- PATCH cannot_split_pending → 400

`apps/api/tests/transactions.list.test.ts` (or wherever list lives):
- GET response includes `allocations` array per tx
- GET response does NOT include `categoryId` or `categorizationSource` at tx level
- `?categoryId=X` returns tx that have ≥1 allocation matching X
- `?uncategorizedOnly=true` returns tx with ≥1 null-cat allocation

### 8.9 Chat tools

Each touched chat tool gets a test exercising the unified path. List in §5.1.1. Most tests just update assertions from `tx.categoryId === X` to `tx.allocations[0].categoryId === X` (for N=1 case).

### 8.10 Smoke

`docs/superpowers/smoke-tests/2026-05-19-plan-1c-split-transaction.md`:
1. Create manual tx $200 Costco (no category) → response shows `allocations: [{categoryId: null, amount: "200", source: null}]`
2. PATCH with `categoryId: <groceries>` → allocations = 1 entry with Groceries
3. PATCH with `allocations: [{cat: groceries, 120}, {cat: electronics, 50}, {cat: household, 30}]` → 3 alloc, sum 200
4. PATCH back to single category via `categoryId` shortcut → allocations replaced with 1 entry
5. PATCH with `allocations: [...sum 150]` (wrong) → 400 `sum_mismatch`
6. PATCH on pending Plaid tx (if you have one) with `allocations` → 400 `cannot_split_pending`
7. PATCH on posted Plaid tx with `allocations` → 200
8. GET tx → response shows allocations, no top-level categoryId
9. GET `?categoryId=<groceries>` → split tx in step 3 appears

---

## 9. Migration & rollout

Single Prisma migration per §3.4. Pre-launch, so no production data risk. The DO-block guard catches any backfill mismatch immediately.

No feature flag — the API change is breaking (response shape changes; clients must read allocations). But there are no external clients yet — only the in-repo web/mobile apps, which can be updated in the same plan if needed (but UI is out of scope per §1).

---

## 10. Reviewer checklist

- [ ] `Transaction.categoryId` and `Transaction.categorizationSource` dropped; no code path reads them after migration
- [ ] `TransactionAllocation` invariant: every tx has ≥1 allocation, sum == tx.amount
- [ ] Null `categoryId` allowed in allocations regardless of N (no enforcement that splits must be fully categorized)
- [ ] DO-block safety guard in migration verifies sum invariant before dropping columns
- [ ] Composite index `(categoryId, transactionId)` on transaction_allocations supports budget aggregation queries
- [ ] `applyAllocations` helper is the single write path for user-driven allocation replacement; Plaid sync invalidation + auto-categorize/map-merchant per-row updates are the only intentional exceptions
- [ ] Every `applyAllocations` call is inside `withWorkspaceLock`
- [ ] Auto-categorize and map-merchant use per-row atomic `updateMany` with where-clause guards (categoryId=null, source=null) — no workspace lock, idempotent against concurrent user PATCH (§5.3, §6.1, §6.2)
- [ ] PATCH body: `categoryId` and `allocations` are mutually exclusive → `conflicting_body` 400
- [ ] PATCH pre-check 2 is PER-FIELD: only `amount`/`merchantRaw`/`occurredAt`/`note` provided on non-manual tx → `not_editable`. PATCH with only `allocations` or `categoryId` on Plaid posted → succeeds.
- [ ] PATCH on Plaid pending with allocations → `cannot_split_pending`
- [ ] Plaid sync `upsertModified`: N≥2 with amount/merchant change → invalidate (replace with 1 null-cat alloc, set needsReclassification); N=1 with amount change → just update allocation amount; `findFirst` does NOT filter by `removedAt` (matches today's `updateMany` scope)
- [ ] Plaid sync `upsertAdded` pending→posted promotion branch ALSO updates the single allocation's amount (paranoid check: allocations.length === 1, else log + skip)
- [ ] Sibling back-fill in categorize/map-merchant skips N≥2 allocation tx; archived-cat siblings ARE overwritten
- [ ] Budget + spending queries group by `allocation.categoryId` joined to tx (workspace + period + removedAt filters live on the tx side)
- [ ] GET list response: allocations array, no tx-level categoryId; `?categoryId=X` filter matches via allocation
- [ ] `find-uncategorized-transactions` modes mapped: `uncategorized` = ≥1 null-cat allocation; `not_manual` = any allocation with `source != "manual"` or `categoryId IS NULL`
- [ ] Categorize endpoint works on split tx (replaces with single allocation), NOT errors with already_split
- [ ] `needsReclassification` clears ONLY when PATCH provides `allocations` or `categoryId` field; passive single-allocation amount update from `amount` PATCH does NOT clear
- [ ] LLM tool-result shapes regenerated for any prompt that references `tx.categoryId` (categorize-transaction, find-transactions, etc.)
- [ ] No new HTTP audit log (deferred to 1C-audit-http)
- [ ] Strict Decimal equality on sum (no tolerance); validators run on string form before Number conversion
