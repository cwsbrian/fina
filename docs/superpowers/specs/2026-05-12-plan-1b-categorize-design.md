# Plan 1B-categorize — Auto Transaction Categorization (Backend) — Design Spec

**Date:** 2026-05-12
**Status:** Brainstorm complete, ready for implementation planning
**Owner:** Brian (cwsbrian@gmail.com)
**Implements:** master spec `docs/superpowers/specs/2026-05-07-fina-design.md` §15 Phase 1B (categorization portion) + §5 (chat agent will consume this later) + §8 (data model)
**Builds on:** Plan 1B-foundation (`docs/superpowers/specs/2026-05-11-plan-1b-plaid-foundation-design.md`) — schema for `transactions`, `categories`, `plaid_items` already exists.

---

## 1. Goal

After Plaid sync brings in new transactions, the backend automatically assigns each one to a category (e.g. `Groceries`, `Dining`, `Transit`). Two paths in priority order:

1. **`merchant_mappings` lookup** — if the workspace has previously mapped `starbucks → Dining`, all future Starbucks transactions get that category instantly (no LLM, no cost).
2. **LLM categorize** (Gemini 2.5 Flash Lite) — the remaining transactions get batched into one LLM call that returns `{tx_id, category}` for each. Results are written but **NOT** auto-mapped (mappings only created on manual confirm).

Users can also manually categorize via API (`POST /transactions/:txId/categorize`). Manual confirms create/update a `merchant_mapping` and back-fill any past transactions sharing that merchant — so "I categorized Starbucks once → all past Starbucks transactions update" works as expected.

**Exit criterion (smoke):** Pro user signs up → Plaid sandbox connect → 15-ish auto-imported transactions all have `categoryId` set after sync completes. Manually re-categorize one (`POST .../categorize`) and the corresponding `merchant_mapping` row appears + sibling transactions update.

This plan is **backend only.** No web/mobile UI. UI for categorize lands later:
- Phase 2 — mobile chat block `categorize_card` (the real daily UX, see master spec §6)
- Optional 1B-mobile — full transactions list on mobile

---

## 2. Scope

**In:**
- `merchant_mappings` table + `transactions.categorizationSource` enum column + 1 migration.
- Default category seed (10 English categories) on workspace bootstrap.
- `src/categorize/` module: rule-based merchant normalizer, mapping lookup, Gemini Flash Lite caller, batch service.
- Auto-categorize hook in `syncTransactions` (after final-tx commits cursor).
- API endpoints: categories CRUD, list uncategorized, manual categorize (auto-creates mapping + back-fills).
- Env vars: `GEMINI_API_KEY` (required), `CATEGORIZE_BATCH_MAX` (optional, default 50).
- Tests: unit (normalize, service with mocked LLM, route guards) + E2E (sync → assert categorized).

**Out (deferred):**
- UI of any kind (web or mobile) — chat block + daily ritual UX is Phase 2.
- Re-categorize already-categorized transactions on merchant change. categoryId is sticky once set.
- LLM-suggested NEW categories (LLM stays within seeded vocabulary; if it returns something off-list, that tx is left uncategorized).
- Localization. Categories are hardcoded English. See §10 below for the planned approach.
- Confidence-based UI hints (`merchant_mappings.confidence` is stored but not yet consumed downstream — Phase 2 may use it).
- Budget/spending aggregations (categorize unlocks them but they're Phase 2/3).
- Cron-based re-categorize for failed past attempts. If LLM is down during sync, those tx stay uncategorized until the next sync run touches them (which doesn't currently happen). A follow-up plan can add a daily retry.

---

## 3. Data Model

### 3.1 New table

```prisma
model MerchantMapping {
  id                  String         @id @default(cuid())
  workspaceId         String
  // Lowercased, stripped of store IDs/state codes/trailing digits.
  // E.g. "STARBUCKS #1234 TORONTO ON" → "starbucks".
  // See src/categorize/normalize.ts for the exact rules.
  merchantNormalized  String
  categoryId          String
  // 0.00 – 1.00. Manual confirms = 1.00. Reserved for future
  // confidence-weighted UI (Phase 2) — stored but not consumed in 1B.
  confidence          Decimal        @default(1.00) @db.Decimal(3, 2)
  source              MappingSource
  createdAt           DateTime       @default(now())

  workspace  Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category   Category  @relation(fields: [categoryId],  references: [id], onDelete: Cascade)

  @@unique([workspaceId, merchantNormalized])
  @@index([workspaceId])
  @@map("merchant_mappings")
}

enum MappingSource {
  manual  // user explicitly categorized — high trust
  ai      // LLM-suggested (NOT used in Plan 1B; reserved for future "auto-learn from confident LLM")
  auto    // RESERVED for future rule-based mappings (e.g. seed of obvious chains)
}
```

In Plan 1B-categorize, **only `manual` mappings get created** (per master spec §15 line "manual confirm 시 자동 생성"). The other enum values are forward-looking placeholders.

### 3.2 New column on `Transaction`

```prisma
model Transaction {
  // … existing fields …
  categorizationSource  CategorizationSource?  // null until categorized
}

enum CategorizationSource {
  mapping  // assigned via merchant_mappings lookup
  ai       // assigned via LLM
  manual   // user-confirmed (or chat agent in Phase 1C)
}
```

A null value means "uncategorized" (same as `categoryId IS NULL`). The two are correlated — never `categoryId IS NULL AND categorizationSource IS NOT NULL`.

### 3.3 Category seed

On workspace bootstrap (existing `apps/api/src/workspaces/bootstrap.ts`), after creating the workspace + owner membership, seed 11 categories (English):

```
Groceries
Dining
Transit
Housing
Utilities
Health
Shopping
Entertainment
Subscriptions
Income
Other
```

`Income` is included because Plaid emits negative-amount transactions (refunds, deposits) under merchant_name, and the categorizer needs a target for them.

Seeding is part of the bootstrap tx so a fresh workspace always has at least these 11 categories. **The migration also back-fills every existing workspace** with the same 11 defaults via raw SQL appended to `migration.sql`:

```sql
INSERT INTO categories ("id", "workspaceId", "name", "createdAt")
SELECT
  -- cuid-shaped collision-safe id: 'cmpseed_' + workspace prefix + name slug
  'cmpseed_' || substr(w.id, 4, 8) || '_' || lower(replace(c.name, ' ', '_')),
  w.id,
  c.name,
  NOW()
FROM "workspaces" w
CROSS JOIN (VALUES
  ('Groceries'),('Dining'),('Transit'),('Housing'),('Utilities'),
  ('Health'),('Shopping'),('Entertainment'),('Subscriptions'),('Income'),('Other')
) AS c(name)
ON CONFLICT ("workspaceId", "name") DO NOTHING;
```

The `ON CONFLICT DO NOTHING` makes the migration safe to re-run, and idempotent if the user already created some of those categories manually before the migration. This backfill is one-time and not invoked at runtime.

---

## 4. Flow

### 4.1 Auto-categorize after sync

After `syncTransactions` finishes its final-tx (cursor commit), it calls `categorizeNewTransactions(env, workspaceId, newTxIds)`. The list of new tx IDs is what `syncTransactions` knows it just added (NOT all uncategorized in the workspace — that would re-process forever).

Per-sync, not per-page. If sync was interrupted mid-page, the partially-committed transactions stay uncategorized; the next successful full sync will catch them via the `newTxIds` it builds during that run plus a separate "uncategorized backfill" call (NOT in this plan; flagged for follow-up).

```
categorizeNewTransactions(env, workspaceId, newTxIds):
  txs = SELECT id, merchantRaw, amount, occurredAt FROM transactions
        WHERE id IN (newTxIds) AND categoryId IS NULL

  # Step 1: Normalize merchant for each tx
  for tx in txs:
    tx.merchantNormalized = normalizeMerchant(tx.merchantRaw)
    UPDATE transactions SET merchantNormalized = ... WHERE id = tx.id

  # Step 2: Apply existing mappings (no LLM, no cost)
  mappings = SELECT * FROM merchant_mappings WHERE workspaceId = ? AND merchantNormalized IN (...)
  for tx in txs:
    if mapping = mappings[tx.merchantNormalized]:
      UPDATE transactions
        SET categoryId = mapping.categoryId,
            categorizationSource = 'mapping'
        WHERE id = tx.id
      remove tx from "unmapped" set

  # Step 3: LLM batch for unmapped
  if unmapped is empty: return
  categories = SELECT name FROM categories WHERE workspaceId = ? AND archivedAt IS NULL

  for batch in chunks(unmapped, env.CATEGORIZE_BATCH_MAX or 50):
    try:
      results = callGeminiCategorize(env, categories, batch)
      for r in results:
        if r.category not in categories: skip (leave uncategorized)
        UPDATE transactions
          SET categoryId = (SELECT id FROM categories WHERE name = r.category),
              categorizationSource = 'ai'
          WHERE id = r.tx_id
    except LLMError:
      log + continue (those tx stay uncategorized; no retry in same sync)
```

### 4.2 Manual categorize (`POST /workspaces/:id/transactions/:txId/categorize`)

```
Input: { categoryName: string }
Auth:  members (any role can categorize their workspace's tx)

1. Verify tx exists in workspace + load merchantRaw + merchantNormalized.
   If merchantNormalized is null (rare; tx imported before this plan):
     merchantNormalized = normalizeMerchant(merchantRaw); store back.

2. Find category by name in workspace.
   If not exists: 404 category_not_found
     (User must create categories explicitly. We don't auto-create from
      free-form input — keeps the category vocabulary controlled.)

3. UPDATE transactions
     SET categoryId, categorizationSource = 'manual'
     WHERE id = txId

4. Upsert merchant_mapping:
     INSERT INTO merchant_mappings (workspaceId, merchantNormalized, categoryId, confidence=1.0, source='manual')
     ON CONFLICT (workspaceId, merchantNormalized)
     DO UPDATE SET categoryId = excluded.categoryId, source = 'manual', confidence = 1.0

5. Back-fill: UPDATE transactions
     SET categoryId = (the mapping's category),
         categorizationSource = 'mapping'
     WHERE workspaceId = ?
       AND merchantNormalized = ?
       AND id != txId                         -- skip the one we just set to 'manual'
       AND categorizationSource != 'manual'   -- don't overwrite user's other manual decisions

6. Return updated tx.
```

### 4.3 Merchant normalization rules (`src/categorize/normalize.ts`)

Rule-based. Order matters:

1. Trim, lowercase.
2. Strip trailing parenthesized location: `pizza pizza (toronto)` → `pizza pizza`.
3. Strip trailing 2-letter state/province codes after space: `walmart bc` → `walmart`.
4. Strip trailing store IDs: `walmart #1234` → `walmart`, `walmart 1234` → `walmart`, `mcdonalds q39` → `mcdonalds`.
5. Strip city qualifiers we hard-list (small allowlist for major CA cities): `tim hortons toronto` → `tim hortons`.
6. Collapse repeated whitespace, trim again.

Plaid's `merchant_name` is usually already pretty clean (`"Starbucks"` rather than the raw card-network string), but we normalize defensively because:
- Plaid sometimes falls back to `name` (the raw string).
- Merchant chains have inconsistent suffixes (`McDonald's #5152`, `McDonald's q39`, etc.).

We accept that no rule-based normalizer is perfect — that's why `merchant_mappings` is keyed by the **already-normalized** form. If `mcdonalds 5152` and `mcdonalds q39` normalize differently, that's two mappings to confirm; not catastrophic.

---

## 5. LLM Contract (Gemini 2.5 Flash Lite)

### 5.1 Request

```
model: gemini-2.5-flash-lite
generationConfig: { responseMimeType: "application/json", responseSchema: {...} }
contents: [
  {
    role: "user",
    parts: [{
      text: """
        Categorize each Canadian personal financial transaction into exactly one
        of these categories: [Groceries, Dining, Transit, Housing, Utilities,
        Health, Shopping, Entertainment, Subscriptions, Income, Other].

        Currency is CAD. Positive amount = expense, negative = income/refund.

        Return JSON: { "results": [{ "tx_id": string, "category": string }] }
        Use exact category names from the list. If genuinely unclear, use "Other".

        Transactions:
        - tx_id: tx_abc123, merchant: Starbucks, amount: 5.50, date: 2026-05-10
        - tx_id: tx_def456, merchant: Loblaws, amount: 89.40, date: 2026-05-10
        - ...
      """
    }]
  }
]
```

### 5.2 Response schema (Gemini structured output)

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "tx_id": { "type": "string" },
          "category": { "type": "string" }
        },
        "required": ["tx_id", "category"]
      }
    }
  },
  "required": ["results"]
}
```

### 5.3 Validation & failure handling

- **Invalid JSON / API error** → log, leave the batch uncategorized, continue with remaining batches.
- **Category not in seeded list** → skip that tx (leave uncategorized). Don't trust the LLM to invent categories.
- **Unknown tx_id in response** → skip.
- **Missing tx_id in response** → that tx stays uncategorized. No retry within the same sync.
- **Empty `results` array** → no-op.

No exponential-backoff retry in v1. If LLM is flaky, those tx stay uncategorized and the user (or chat agent in Phase 1C) can manually categorize. A future plan can add a retry queue.

### 5.4 Cost estimate

Per call, ~15 tx batch:
- Prompt: ~200 tokens system + 80 tokens × 15 tx = ~1.4K input tokens
- Response: ~30 tokens × 15 = ~450 output tokens
- Gemini 2.5 Flash Lite: $0.10/M input, $0.40/M output → ~**$0.00032 per call**

Per active user/month (assume 100 new tx/month, 90% cached via mappings after first month):
- Month 1: ~7 calls (15 tx × 7) ≈ $0.0022
- Subsequent months: ~1 call (10 unmapped tx) ≈ $0.0003

**Effectively free at our scale.** Even 1,000 active users month-1 = ~$2.20 total.

---

## 6. API Endpoints

All under `/workspaces/:id/...`, with the same `requireWorkspaceContext` + path/header mismatch guard from Plan 2.

| Method | Path | Role | Tier | Notes |
|---|---|---|---|---|
| `GET`   | `/workspaces/:id/categories` | viewer | — | List active categories (archivedAt IS NULL). Returns `[{id, name, icon?, color?}]`. |
| `POST`  | `/workspaces/:id/categories` | owner  | — | Create category. Body `{name}`. 422 if name duplicates an existing (case-insensitive) active category in the workspace. |
| `PATCH` | `/workspaces/:id/categories/:catId` | owner | — | Rename, recolor, or archive. Body `{name?, icon?, color?, archived?}`. Renaming honors the same uniqueness rule. |
| `GET`   | `/workspaces/:id/transactions/uncategorized` | viewer | — | List uncategorized transactions (cursor-paginated, reuse the existing transactions paginator with `?uncategorizedOnly=true`). Returns the same `transaction` shape as the existing transactions route. |
| `POST`  | `/workspaces/:id/transactions/:txId/categorize` | **editor** | — | Manually categorize. Body `{categoryName: string}`. 404 if category name doesn't exist in workspace. Side effects: `merchant_mapping` upsert + back-fill (see §4.2). Returns the updated tx + count of back-filled tx. |

**Note on roles:**
- **viewer**: GET-only. Daily ritual users who only browse can still see categories and uncategorized lists.
- **editor**: can categorize transactions (write to tx + create mappings). The day-to-day household action.
- **owner**: workspace-structural changes — creating/renaming/archiving categories. The vocabulary is stable for the LLM and chat agent, so only owners can extend or change it.

---

## 7. Files Changed/Created

| File | Op | Purpose |
|---|---|---|
| `prisma/schema.prisma` | modify | `MerchantMapping` model, `MappingSource` enum, `Transaction.categorizationSource` field + enum |
| `prisma/migrations/<ts>_add_categorize/migration.sql` | new | generated |
| `src/env.ts` | modify | `GEMINI_API_KEY: z.string()`, `CATEGORIZE_BATCH_MAX: z.coerce.number().int().positive().default(50)` |
| `src/categorize/normalize.ts` | new | `normalizeMerchant(raw: string): string` |
| `src/categorize/seed.ts` | new | `DEFAULT_CATEGORIES: string[]` (11 names) + `seedDefaultCategories(tx, workspaceId)` |
| `src/workspaces/bootstrap.ts` | modify | call `seedDefaultCategories(tx, ws.id)` inside the existing bootstrap tx |
| `src/categorize/llm.ts` | new | Gemini SDK wrapper with structured-output config; `callGeminiCategorize(env, categories, txs)` |
| `src/categorize/service.ts` | new | `categorizeNewTransactions(env, workspaceId, txIds)` + helpers |
| `src/plaid/sync.ts` | modify | After final-tx in `syncTransactions`, call `categorizeNewTransactions` (best-effort, errors don't fail sync) |
| `src/routes/categories.ts` | new | CRUD routes |
| `src/routes/transactions.ts` | modify | add `?uncategorizedOnly=true` filter + `POST /:txId/categorize` |
| `src/server.ts` | modify | register `categoriesRoutes` |
| `tests/helpers/gemini-mock.ts` | new | `vi.hoisted` factory mirror of plaid-mock; scriptable queue |
| `tests/categorize.normalize.test.ts` | new | 6+ rule cases |
| `tests/categorize.service.test.ts` | new | mapping-first, LLM fallback, back-fill, source field, batch chunking |
| `tests/categorize.routes.test.ts` | new | categories CRUD + manual categorize + workspace_mismatch + role guards |
| `tests/plaid.sync.test.ts` | modify | add a "auto-categorize after sync" test (mocks Gemini) |
| `e2e/plan-1b-categorize.spec.ts` | new | Plaid sandbox connect → wait → assert categorized; manual categorize → mapping created + back-fill |
| `apps/api/.env.test` | modify | `GEMINI_API_KEY=test_gemini_key` |
| `.env.example` | modify | document `GEMINI_API_KEY` + how to get one |
| `apps/api/package.json` | modify | add `@google/genai` (Google's current Gemini SDK; the legacy `@google/generative-ai` is deprecated) |
| `docs/superpowers/smoke-tests/2026-05-12-plan-1b-categorize.md` | new | smoke guide |
| `README.md` | modify | Status block |

---

## 8. Testing Matrix

### 8.1 Unit — `categorize.normalize.test.ts`

| Input | Output |
|---|---|
| `STARBUCKS #1234 TORONTO ON` | `starbucks` |
| `McDonald's #5152` | `mcdonald's` |
| `Walmart 1234 BC` | `walmart` |
| `Tim Hortons Toronto` | `tim hortons` |
| `Pizza Pizza (Toronto)` | `pizza pizza` |
| `   Starbucks   ` | `starbucks` |
| `Amazon.ca` | `amazon.ca` (no rule strips suffixes; mapping handles aliases) |

### 8.2 Unit — `categorize.service.test.ts`

(Gemini mocked)

1. All tx have existing mappings → no LLM call, all use `source='mapping'`.
2. No mappings, LLM returns valid categories for all → all `source='ai'`.
3. Mixed: 2 mapped, 3 unmapped → LLM called for 3 only.
4. LLM returns category not in seeded list → that tx stays uncategorized.
5. LLM returns unknown tx_id → skip silently, other valid tx_ids still applied.
6. LLM throws → all unmapped tx stay uncategorized; mapped tx still applied.
7. Batch > `CATEGORIZE_BATCH_MAX` → 2+ LLM calls.
8. `merchantNormalized` populated correctly on tx rows after run.

### 8.3 Unit — `categorize.routes.test.ts`

| Test | Expected |
|---|---|
| GET /categories — seeded 11 categories | 200, 11 names |
| POST /categories — viewer caller | 403 |
| POST /categories — owner, duplicate name | 422 |
| POST /categories — owner, new name | 201 |
| PATCH /categories/:id — rename to existing name | 422 |
| GET /transactions/uncategorized — empty | 200, [] |
| POST /transactions/:txId/categorize — happy path | tx updated, mapping created, back-fill count returned |
| POST /transactions/:txId/categorize — category doesn't exist | 404 |
| POST /transactions/:txId/categorize — back-fill skips manual-source tx | verify |
| All routes — workspace_mismatch | 400 |
| All routes — non-member | 404 |

### 8.4 Integration — `plaid.sync.test.ts`

Add to existing file:
- After-sync auto-categorize: mock Gemini to return categories; assert tx rows get `categoryId` + `categorizationSource = 'ai'`.
- LLM failure during auto-categorize: assert sync still returns success + tx stay uncategorized.

### 8.5 E2E — `e2e/plan-1b-categorize.spec.ts`

Real Gemini API only if `GEMINI_API_KEY` is set (matches Plaid sandbox conditional skip pattern).

1. Sign up → connect Tartan sandbox → wait → assert all tx have `categoryId`.
2. Manually re-categorize one tx → assert mapping appears + sibling tx update.

---

## 9. Risk & Failure Modes

| Risk | Mitigation |
|---|---|
| Gemini API down during sync | Sync still succeeds (categorize is best-effort). Tx stay uncategorized; chat agent (Phase 1C) or follow-up cron can retry. |
| LLM returns category not in seed list | Skip that tx — never trust LLM to invent vocabulary. |
| User creates a category, then archives it, then LLM returns its name | LLM only sees non-archived categories (per §4.1 step 3 query), so this can't happen for fresh syncs. Existing tx pointing to an archived category remain pointing — UI can filter or relabel as "Other". |
| Massive batch (e.g. initial connect with 500 tx) | `CATEGORIZE_BATCH_MAX = 50` default → 10 sequential LLM calls × $0.0003 ≈ $0.003. Trivial. |
| Cross-workspace data leak via merchant_mappings | All queries scope by `workspaceId` (same defense-in-depth as Plan 1B-foundation). Tested in route tests. |
| Race: two concurrent syncs both call auto-categorize on overlapping tx | Each `categorizeNewTransactions` call takes its own `newTxIds` list (a sync's locally-known new tx IDs). UPDATEs are idempotent (set categoryId; if already set, no harm). Worst case: two LLM calls for the same tx — wasted ~$0.0001. Not worth defending against. |
| Manual categorize back-fills 1000+ historical tx | One UPDATE statement — bounded by query timeout (default 5s). For very large workspaces (Phase 3 territory), can add LIMIT + paginate. Not blocking for v1. |

---

## 10. Localization Plan (v2+)

**Decision for v1:** Categories are hardcoded English. The 11-name seed list is in source code, the LLM prompt is in English, and the API returns English names verbatim.

**Why now-not-later for the decision but later-not-now for the implementation:**
- Canadian launch is English-first. We have one user (Brian, dogfooding) and Brian can read English.
- Categories baked into both `categories` rows and LLM training data are an early-stage product decision that's easier to migrate from "English-only" to "multilingual" than from "Korean-only" to "Canadian English."

**Planned approach for v2:**
1. Add `category_translations` table: `(categoryId, locale, name)` with PK `(categoryId, locale)`. Keep the existing `categories.name` as the canonical "internal key" (English) so LLM prompts and mappings stay stable.
2. API response includes both `name` (English canonical) and `displayName` (locale-resolved via `category_translations`). Mobile/web reads `displayName`.
3. Locale resolution: client sends `Accept-Language` header (or app reads device locale). Server falls back to English if no translation row exists.
4. LLM prompt stays in English (categories list passed as English names). User-facing strings translated via the same `category_translations` table.
5. Migration: backfill English `category_translations` from existing `categories.name` for every workspace. Korean translations seeded for the 11 defaults.
6. `merchant_mappings.merchantNormalized` stays unchanged (it's the normalized merchant string, not a translation key).

This means **no schema changes are wasted by waiting** — the v1 design naturally extends to v2.

---

## 11. Open Questions Resolved During Brainstorming

| Question | Decision | Rationale |
|---|---|---|
| Scope: include UI? | **No.** Backend only. | Phase 2 mobile chat block is the real UX. Web `/transactions` page would be throwaway. |
| Categorize trigger? | **Auto-after-sync.** | Daily ritual UX requires tx already categorized. Cost is trivial. |
| LLM choice? | **Gemini 2.5 Flash Lite.** | Cheapest option, structured-output works well, master spec already plans Gemini for chat. |
| Category vocabulary? | **English seed (11 names), hardcoded for v1.** | Canadian launch, Brian dogfoods. Localization plan (§10) doesn't require schema changes now. |
| Re-categorize already-set tx? | **Never (auto).** Manual API call always works. | Avoid LLM second-guessing user's earlier decisions. |
| Merchant_mappings auto-create from LLM? | **No.** Only manual confirm creates mappings. | Master spec contract. Avoids LLM mistakes becoming permanent. |
| Smoke test approach? | **API + psql + E2E.** | No UI, matches Plan 1B-foundation pattern. |

---

## 12. Out of Scope (Follow-Up Plans)

- **1B-cron** — Daily re-sync of stale items. Will also pick up tx that auto-categorize missed (LLM was down at sync time).
- **1B-mobile** — Mobile transactions list + per-tx categorize sheet. Mirrors web `/transactions/banks` pattern.
- **1B-webhooks** — Plaid webhook signature verify. Categorize is triggered by webhook-driven sync calls just like manual sync calls.
- **Phase 1C** — Chat agent tools: `categorizeTransaction`, `mapMerchantToCategory`, `presentCategorizationCards`. These wrap the same API endpoints from this plan.
- **Phase 2** — Daily ritual + mobile `categorize_card` chat block. Surfaces uncategorized tx as 1-tap categorize cards.
- **Phase 3** — Bulk categorize ("move all of yesterday's restaurants to Groceries"). Built on top of these endpoints.
