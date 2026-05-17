# Plan 1C-merchant-map — `mapMerchantToCategory` chat tool

**Date:** 2026-05-17
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation, per master design §15.1C)

---

## 1. Goal

Add a `mapMerchantToCategory` chat tool. The LLM can bind a merchant string
to a category — even when the user has no current transaction with that
merchant — and any existing null-category transactions for that merchant
in the same workspace are retroactively assigned. No schema changes; reuses
the existing `MerchantMapping` table from Plan 1B.

This is the third of three `setBudget` / `getBudget` /
`mapMerchantToCategory` items required by master design §5 + §15.1C for
the chat agent's write surface.

---

## 2. Background

`MerchantMapping` already exists from Plan 1B-categorize:

```prisma
model MerchantMapping {
  workspaceId        String
  merchantNormalized String
  categoryId         String
  confidence         Decimal       @default(1.00) @db.Decimal(3, 2)
  source             MappingSource  // enum: manual | ai | auto
  @@unique([workspaceId, merchantNormalized])
}
```

It is currently maintained as a **side effect** of `categorizeTransaction`
(via `manual-categorize.ts`): when a user assigns a category to a specific
transaction, the row's normalized merchant gets bound to that category in
`merchant_mappings`. This requires having an existing transaction to point
at.

`mapMerchantToCategory` removes that prerequisite. Use cases:

- **Pre-bind:** "Always categorize Amazon as Shopping" before any Amazon
  transaction has arrived.
- **Rebind:** "Change all Starbucks mappings to the Coffee category" — the
  current mapping points at a stale category.
- **Backfill:** when a binding is created, sweep the workspace's null-
  category transactions with the matching `merchantNormalized` and assign
  them to the new category (same as `manual-categorize` does today).

The chat route is Pro-gated. There is no separate HTTP route — master
design §5 lists this as a chat tool only; UI is out of scope (the user is
iterating on UI separately).

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| Backfill policy | **Null-only** — siblings whose `categoryId IS NULL`. Already-categorized rows are NOT touched (preserves manual choices) |
| Surface | Chat tool only (no HTTP route) |
| Role gate | editor+ (inherited from chat route) |
| Tier gate | Pro (inherited from chat route) |
| Confidence / source | Server hardcodes `confidence = 1.00`, `source = "manual"` (matches `manual-categorize.ts` pattern) |
| Merchant input shape | Raw text from LLM; server normalizes via existing `normalizeMerchant` |
| Empty normalized merchant | Throw `invalid_merchant` |
| Category resolution | `category_id` OR `category_name` (exactly one); chat tool resolves name CI to id |
| `categorizationSource` on backfill | `"mapping"` (existing enum value used by Plan 1B-categorize) |
| Bulk mapping (multiple merchants in one call) | Out of scope |
| Override already-categorized | Out of scope |
| Delete / unmap tool | Out of scope — separate follow-up |
| List mappings tool | Out of scope — separate follow-up |

---

## 4. Architecture

Three pieces:

**(a) Service module** `apps/api/src/categorize/map-merchant.ts`:

```typescript
export type MapMerchantInput = { categoryId: string; merchant: string };
export type MapMerchantOutput = {
  mapping: { merchantNormalized: string; categoryId: string };
  backfilledCount: number;
};

export async function mapMerchantToCategoryService(
  ctx: { workspaceId: string },
  input: MapMerchantInput,
): Promise<MapMerchantOutput>;
```

- Normalizes via `normalizeMerchant`. Empty → throw `invalid_merchant`.
- Verifies category in workspace + active. Missing → throw `category_not_found`.
- Atomic `prisma.$transaction`:
  1. `merchantMapping.upsert` on `(workspaceId, merchantNormalized)` with
     `source = "manual"`, `confidence = 1.00`.
  2. **Normalize NULL-merchantNormalized siblings first.** Plaid sync writes
     `merchantNormalized = NULL` until something forces categorization, so
     a row that *would* match the new mapping can still be NULL today.
     Mirror `manual-categorize.ts:81-97`:
     - `findMany` rows where `workspaceId`, `merchantNormalized IS NULL`,
       and `merchantRaw` contains the prefix of the normalized target
       (case-insensitive, prefix length = `min(3, len(merchantNormalized))`).
       Select `id` + `merchantRaw`.
     - For each candidate, recompute `normalizeMerchant(merchantRaw)`. If
       it equals the target `merchantNormalized`, set the row's
       `merchantNormalized` to the target via `update`.
     - This stage **does not** set `categoryId` — it only fills the
       normalized column so the next stage's `updateMany` picks the row up.
  3. `transaction.updateMany` where `workspaceId AND merchantNormalized AND
     categoryId IS NULL AND removedAt IS NULL` setting `categoryId` +
     `categorizationSource = "mapping"`. Capture `count` as
     `backfilledCount`.
- Returns `{ mapping: { merchantNormalized, categoryId }, backfilledCount: count }`.

**(b) Chat tool** `apps/api/src/chat/tools/map-merchant-to-category.ts`:

```typescript
const Args = z.object({
  merchant: z.string().min(1).max(200).describe("Raw merchant text — server normalizes to lowercase + strips store IDs / locations."),
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
}).refine(
  (a) => Boolean(a.category_id) !== Boolean(a.category_name),
  { message: "Provide exactly one of category_id or category_name" },
);
```

Behavior:
1. Resolve `categoryId`: if provided, validate inside workspace + active.
   Else resolve `category_name` case-insensitively. Either path: capture
   canonical `category.name` for the response.
2. Call `mapMerchantToCategoryService({ workspaceId: ctx.workspaceId },
   { categoryId, merchant: args.merchant })`.
3. Return `{ mapping: { merchantNormalized, categoryId, categoryName }, backfilledCount }`.

**(c) Wiring:** add to registry in `apps/api/src/chat/tools/index.ts`
(count 17 → 18) and extend the existing write-tool sentence in
`apps/api/src/chat/turn.ts` SYSTEM_PROMPT.

---

## 5. Validation + error codes

| Code | Cause | Surfaced by |
|---|---|---|
| `invalid_merchant` | `normalizeMerchant(input.merchant)` returned empty string (whitespace-only input) | service |
| `invalid_args: …` | Zod `.refine` — neither or both of `category_id` / `category_name` (the chat dispatcher in `apps/api/src/chat/dispatcher.ts` wraps Zod failures as `invalid_args: <message>` — verified at line 17) | chat dispatcher |
| `category_not_found` | category not in workspace, or archived | both chat tool and service (defense-in-depth) |

The service is defensive: even if a future caller passes a `categoryId`
without going through the chat tool, the service re-checks workspace + active.

Note on `invalid_merchant`: `normalizeMerchant("   ")` (whitespace-only)
returns `""`, which is what this gate catches. Punctuation-only input
(e.g. `"###"`) currently normalizes to `"###"` because there is no rule
that strips arbitrary punctuation — those values pass the gate and create
a real mapping. That's acceptable for v1; an "is this a meaningful
merchant string" heuristic is a separate concern.

---

## 6. System prompt update

Current sentence in `apps/api/src/chat/turn.ts`:

```
For write tools (createCategory, addTransactionNote, setBudget), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?'
```

Replace with:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?'
```

---

## 7. Files

- **Create** `apps/api/src/categorize/map-merchant.ts` — `mapMerchantToCategoryService`.
- **Create** `apps/api/src/chat/tools/map-merchant-to-category.ts` — chat tool.
- **Modify** `apps/api/src/chat/tools/index.ts` — register the new tool with `as ToolDef` cast (count 17 → 18).
- **Modify** `apps/api/src/chat/turn.ts` — replace the write-tool sentence per §6.
- **Modify** `apps/api/tests/chat.tools.registry.test.ts` — bump 17 → 18; assert `"mapMerchantToCategory"` in the names list.
- **Create** `apps/api/tests/categorize.map-merchant.test.ts` — service tests (~8 cases).
- **Create** `apps/api/tests/chat.tools.map-merchant-to-category.test.ts` — chat tool tests (~5 cases).

No schema changes. No new dependencies. No HTTP route.

---

## 8. Tests

### 8.1 `apps/api/tests/categorize.map-merchant.test.ts` (~9 cases)

1. Creates a new mapping when none exists for the merchant; `backfilledCount = 0` if no matching txs.
2. Upserts an existing mapping (changes `categoryId`, keeps `source = "manual"`, `confidence = 1.00`).
3. Backfills null-category siblings with matching `merchantNormalized` → their `categoryId` is set and `categorizationSource = "mapping"`. `backfilledCount` reflects the change.
4. **Backfills siblings with `merchantNormalized IS NULL`** whose `merchantRaw` normalizes to the target — first sets `merchantNormalized`, then assigns `categoryId`. (Seed a row with raw `"STARBUCKS #1234 TORONTO ON"` and `merchantNormalized = null`, then map `"starbucks" → Coffee`; assert the row ends with both columns populated.)
5. Does NOT touch already-categorized siblings (different `categoryId` stays unchanged; `categorizationSource` unchanged).
6. Cross-workspace isolation — a mapping in workspace A does not backfill identical-merchant txs in workspace B.
7. Rejects whitespace-only input (`"   "`) → throws `invalid_merchant` (since `normalizeMerchant("   ")` returns `""`).
8. Rejects category that belongs to a different workspace → throws `category_not_found`.
9. Rejects archived category → throws `category_not_found`.

### 8.2 `apps/api/tests/chat.tools.map-merchant-to-category.test.ts` (~5 cases)

1. Zod `safeParse` rejects when both `category_id` and `category_name` are present.
2. Zod `safeParse` rejects when neither is present.
3. Chat tool resolves `category_name` case-insensitively and returns canonical `categoryName` from DB.
4. Result includes `backfilledCount` from the service.
5. `mapping.merchantNormalized` is server-normalized (e.g. `"STARBUCKS #1234 TORONTO ON"` → `"starbucks"`).

### 8.3 `apps/api/tests/chat.tools.registry.test.ts` (1 case bump)

Bump expected tool count from 17 to 18. Names assertion includes
`"mapMerchantToCategory"`.

---

## 9. Acceptance criteria

This plan is complete when:

1. New chat tool registered; registry test passes 18 tools.
2. Service throws the two documented error codes (`invalid_merchant`, `category_not_found`); chat-tool Zod failures surface via the dispatcher as `invalid_args: <message>` (not `invalid_body`).
3. Mapping row has `source = "manual"`, `confidence = 1.00` (verified by a service test).
4. Backfilled transactions get `categorizationSource = "mapping"` (existing enum value).
5. All new tests pass; baseline 70 files / 578 tests → 72 files / ~591 tests.
6. System prompt sentence extended exactly as in §6.
7. No schema changes, no new dependency in `package.json`.

---

## 10. Excluded scope

- HTTP route — chat tool only (master design §5 phrasing).
- Bulk mapping (multiple merchants in one call).
- Override already-categorized transactions (only null-category siblings).
- Delete / unmap tool.
- List mappings tool.
- Confidence / source as args (server hardcodes manual + 1.0).
- `action_intents` / two-phase confirmation flow.
- `audit_events` write logging.
- UI changes.

---

## 11. Follow-up candidates

- **Plan 1C-merchant-map-list:** read tool `listMerchantMappings({ merchant? })` and `unmapMerchant({ merchant })`.
- **Plan 1C-recurring-persist:** persist `detectRecurringMerchants` patterns to a DB table.
- **Plan 1C-schedule:** `ScheduledSpend` entity + `addScheduledSpend` write tool.
- **Plan 1C-confirmation:** `action_intents` + `categorize_card`/`confirm_card` block model.
- **Plan 1C-audit:** `audit_events` write log for all mutate tools.
