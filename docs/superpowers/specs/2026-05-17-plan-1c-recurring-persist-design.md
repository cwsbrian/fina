# Plan 1C-recurring-persist — Recurring expenses entity + chat tools

**Date:** 2026-05-17
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation, per master design §15.1C)

---

## 1. Goal

Persist user-confirmed recurring expenses (Netflix, Spotify, hydro). Add a
new `RecurringExpense` entity, 3 chat tools (`addRecurring`, `listRecurring`,
`removeRecurring`), and 3 HTTP routes. Foundation for Phase 2's daily-ritual
context ("다음 7일 안 예정된 recurring expense" per master design §6).

`detectRecurringMerchants` remains read-only — this plan only adds the
persistence path. The LLM can chain `detectRecurringMerchants` → confirm
with the user → `addRecurring` for each candidate.

---

## 2. Background

Master design §5 lists `listRecurring()` + `addRecurring({ name, amount,
cadence, next_date })` as chat tools. Master design §8 proposes:

```
recurring_expenses (id, workspace_id, name, amount, category_id,
                    cadence: monthly/weekly/yearly,
                    next_occurrence, last_occurrence?, active)
```

For v1 we extend the cadence enum (add `biweekly` and `semimonthly` for
real-world bills/paychecks), drop the `active` and `lastOccurrenceDate`
fields (YAGNI), and add an optional `merchantNormalized` so
`detectRecurringMerchants` candidates can be linked when persisted.

The chat route is already Pro-gated. HTTP routes follow 1C-budget's
pattern: Pro for writes, all tiers for reads.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| Surface | 3 chat tools + 3 HTTP routes (matches 1C-budget) |
| Cadence enum | `monthly | semimonthly | biweekly | weekly | yearly` |
| `active` column | Out of scope — cancel via hard delete |
| `lastOccurrenceDate` | Out of scope — derivable via join later |
| Unique constraint | `(workspaceId, name)` — addRecurring upserts on this |
| `currency` default | `"CAD"` (matches Transaction.currency convention) |
| `categoryId` on delete | `SetNull` — preserve recurring even if category deleted |
| `merchantNormalized` | Optional, server-normalized via `normalizeMerchant` |
| `removeRecurring` | Hard delete; accepts `recurring_id` XOR `name` |
| Role gate (HTTP/chat writes) | editor+ (chat route default) |
| Tier gate (HTTP writes) | Pro |
| Tier gate (HTTP reads) | All tiers |
| Auto-link transactions to recurring on sync | Out of scope |
| `detectRecurringMerchants` "already persisted" flag | Out of scope |
| Semi-monthly second-anchor logic | Out of scope — only nextOccurrenceDate stored, future occurrences derived in a later forecast plan |
| Forecasting (next-N-days) | Out of scope — Phase 2 |
| Confirmation flow (`action_intents`) | Out of scope — separate 1C-confirmation plan |
| Audit log | Out of scope — separate 1C-audit plan |

---

## 4. Data model

```prisma
enum RecurringCadence {
  monthly
  semimonthly
  biweekly
  weekly
  yearly
}

model RecurringExpense {
  id                  String           @id @default(cuid())
  workspaceId         String
  name                String
  amount              Decimal          @db.Decimal(10, 2)
  currency            String           @default("CAD")
  categoryId          String?
  merchantNormalized  String?
  cadence             RecurringCadence
  nextOccurrenceDate  DateTime         @db.Date
  createdAt           DateTime         @default(now())
  updatedAt           DateTime         @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category  Category? @relation(fields: [categoryId], references: [id], onDelete: SetNull)

  @@unique([workspaceId, name])
  @@index([workspaceId, nextOccurrenceDate])
  @@map("recurring_expenses")
}
```

Inverse relations:
- `Workspace { recurringExpenses RecurringExpense[] }`
- `Category  { recurringExpenses RecurringExpense[] }`

Notes:
- `@db.Date` keeps `nextOccurrenceDate` as a timezone-naive calendar date
  (matches Budget pattern).
- `categoryId` nullable with `SetNull` so deleting a category doesn't
  cascade-destroy the user's recurring entry (the entry just loses its
  category tag).

---

## 5. Service module

`apps/api/src/recurring/service.ts` exports:

```typescript
export type Cadence = "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";

export type AddRecurringInput = {
  name: string;
  amount: number;
  cadence: Cadence;
  nextOccurrenceDate: string;  // YYYY-MM-DD
  categoryId?: string | null;
  merchantNormalized?: string | null;
  currency?: string;
};

export type RecurringRow = {
  id: string;
  name: string;
  amount: string;             // toFixed(2)
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string; // YYYY-MM-DD
  categoryId: string | null;
  merchantNormalized: string | null;
};

export type AddRecurringOutput = { recurring: RecurringRow };
export type ListRecurringOutput = { recurring: RecurringRow[] };

export async function addRecurringService(
  ctx: { workspaceId: string },
  input: AddRecurringInput,
): Promise<AddRecurringOutput>;

export async function listRecurringService(
  ctx: { workspaceId: string },
): Promise<ListRecurringOutput>;

export async function removeRecurringByIdService(
  ctx: { workspaceId: string },
  input: { id: string },
): Promise<boolean>;

export async function removeRecurringByNameService(
  ctx: { workspaceId: string },
  input: { name: string },
): Promise<boolean>;
```

**`addRecurringService`:**
1. Validate `amount > 0` AND `amount <= 99_999_999.99` AND `Number.isFinite` → throw `invalid_amount`.
2. Validate `nextOccurrenceDate` matches `^\d{4}-\d{2}-\d{2}$`, parses to a real date, and round-trips back to the same string (rejects `2026-13-01`, `2026-02-30`, etc.) → throw `invalid_next_date`.
3. If `categoryId` non-null, verify same-workspace + non-archived → throw `category_not_found`.
4. Upsert on `(workspaceId, name)`: create with all fields; update sets `amount`, `currency`, `categoryId`, `merchantNormalized`, `cadence`, `nextOccurrenceDate`.
5. Return formatted row.

**`listRecurringService`:** `findMany` for workspaceId, `orderBy: [{ nextOccurrenceDate: "asc" }, { name: "asc" }]`. Returns formatted rows.

**`removeRecurringByIdService`:** `deleteMany({ where: { id, workspaceId } })`. Returns `count > 0`.

**`removeRecurringByNameService`:**
1. `findFirst` with case-insensitive name match in workspace. Not found → return `false`.
2. Call `removeRecurringByIdService` with the resolved id.

---

## 6. Validation + error codes

| Code | Cause | HTTP | Chat |
|---|---|---|---|
| `invalid_amount` | `amount <= 0` or `> 99999999.99` or NaN/Infinity | 400 | yes |
| `invalid_next_date` | not valid `YYYY-MM-DD` after round-trip | 400 | yes |
| `invalid_merchant` | `normalizeMerchant(merchant)` returned empty (whitespace-only) | 400 | yes (only when `merchant` arg present) |
| `invalid_body` | malformed/missing fields | 400 | n/a |
| `invalid_args: <message>` | Zod `.refine` (XOR on removeRecurring/category) | n/a | chat dispatcher (`apps/api/src/chat/dispatcher.ts:17`) |
| `category_not_found` | `categoryId` not in workspace or archived | 404 | yes |
| `recurring_not_found` | DELETE id doesn't match a row in this workspace | 404 | yes (via name resolution → `removed: false`) |
| `upgrade_required` | POST/DELETE from non-Pro | 402 | n/a (chat route pre-gated) |

---

## 7. Chat tools

All three tools use the standard `ToolDef` signature.

### 7.1 `addRecurring`

```typescript
const Args = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number().positive().max(99_999_999.99),
  cadence: z.enum(["monthly", "semimonthly", "biweekly", "weekly", "yearly"]),
  next_occurrence_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  merchant: z.string().min(1).max(200).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
}).refine(
  (a) => !(a.category_id && a.category_name),
  { message: "Provide at most one of category_id or category_name" },
);
```

Behavior:
1. If `category_id` provided, verify it + capture canonical `category.name`.
2. Else if `category_name` provided, resolve case-insensitively + capture canonical name. Not found → throw `category_not_found`.
3. Else `categoryId = null`, `categoryName = null`.
4. If `merchant` provided, call `normalizeMerchant`. Empty result → throw `invalid_merchant`. Pass result as `merchantNormalized` to service.
5. Call `addRecurringService({ workspaceId }, { ...resolved })`.
6. Return `{ recurring: { ...service-result, categoryName } }`.

### 7.2 `listRecurring`

```typescript
const Args = z.object({});
```

Behavior:
1. Call `listRecurringService({ workspaceId })`.
2. Hydrate `categoryName` by batch-loading categories for the unique non-null `categoryId`s in the result.
3. Return `{ recurring: [...] }` with `categoryName` added per row (null when `categoryId` is null or the category was archived/deleted).

### 7.3 `removeRecurring`

```typescript
const Args = z.object({
  recurring_id: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
}).refine(
  (a) => Boolean(a.recurring_id) !== Boolean(a.name),
  { message: "Provide exactly one of recurring_id or name" },
);
```

Behavior:
1. If `recurring_id` provided, call `removeRecurringByIdService`.
2. Else call `removeRecurringByNameService`.
3. Return `{ removed: boolean }`.

### 7.4 Registry

`apps/api/src/chat/tools/index.ts` adds three tools at positions 19/20/21
with the `as ToolDef` cast pattern (existing 18 entries use this — required
for `REGISTRY: ToolDef[]` to typecheck given `ToolDef<TArgs, TResult>`
variance). Registry count test bumps from 18 to 21.

---

## 8. HTTP routes

`apps/api/src/routes/recurring.ts`:

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  addRecurringService,
  listRecurringService,
  removeRecurringByIdService,
} from "../recurring/service.js";

const PostBody = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number(),  // service validates; Zod accepts any number so 0/neg map to invalid_amount, not invalid_body
  cadence: z.enum(["monthly", "semimonthly", "biweekly", "weekly", "yearly"]),
  nextOccurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().min(1).optional(),
  merchantNormalized: z.string().min(1).optional(),
  currency: z.string().length(3).optional(),
});

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  // POST  /workspaces/:id/recurring               — Pro + editor+
  // GET   /workspaces/:id/recurring               — viewer+, all tiers
  // DELETE /workspaces/:id/recurring/:recurringId — Pro + editor+
}
```

Each handler:
- Calls `requireWorkspaceContext(req, app, { requiredRole: <role> })`.
- For write ops: `effectiveTier(userId)` → 402 if not Pro.
- POST body Zod: amount is `z.number()` (no `.positive()`), so 0/neg surface as `invalid_amount` from service. Same pattern as 1C-budget routes.
- Catches `HttpError` and service-thrown error codes per §6.

Register in `apps/api/src/server.ts` alongside `budgetsRoutes`:

```typescript
import { recurringRoutes } from "./routes/recurring.js";
// ...
await app.register(recurringRoutes);
```

---

## 9. System prompt update

Current sentence in `apps/api/src/chat/turn.ts`:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?'
```

Replace with:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?' or '구독 정리 좀 해줄까?'
```

`listRecurring` is a read tool — NOT in the confirmation list.

---

## 10. Files

- **Create** `apps/api/prisma/migrations/<timestamp>_add_recurring_expenses/migration.sql` — CREATE TYPE + CREATE TABLE + 2 indexes + 2 FK constraints.
- **Modify** `apps/api/prisma/schema.prisma` — `RecurringExpense` model + inverse relations.
- **Create** `apps/api/src/recurring/service.ts` — 4 service functions.
- **Create** `apps/api/src/chat/tools/add-recurring.ts`
- **Create** `apps/api/src/chat/tools/list-recurring.ts`
- **Create** `apps/api/src/chat/tools/remove-recurring.ts`
- **Modify** `apps/api/src/chat/tools/index.ts` — register 3 new tools (18 → 21).
- **Modify** `apps/api/src/chat/turn.ts` — write-tool sentence per §9.
- **Create** `apps/api/src/routes/recurring.ts` — POST/GET/DELETE.
- **Modify** `apps/api/src/server.ts` — register `recurringRoutes`.
- **Modify** `apps/api/tests/chat.tools.registry.test.ts` — bump 18 → 21; new describe block for plan 1c-recurring.
- **Create** `apps/api/tests/recurring.service.test.ts` (~10 cases).
- **Create** `apps/api/tests/recurring.routes.test.ts` (~6 cases).
- **Create** `apps/api/tests/chat.tools.add-recurring.test.ts` (~5 cases).
- **Create** `apps/api/tests/chat.tools.list-recurring.test.ts` (~3 cases).
- **Create** `apps/api/tests/chat.tools.remove-recurring.test.ts` (~3 cases).

No new dependencies. The migration introduces one schema change (the new
enum + table); no existing model is altered.

---

## 11. Tests

### 11.1 `recurring.service.test.ts` (~10 cases)

1. `addRecurringService` creates a row with `currency` defaulting to `"CAD"`.
2. `addRecurringService` upserts on `(workspaceId, name)` — second call with same name updates `amount` and `nextOccurrenceDate`; row count stays 1.
3. Rejects `amount: 0` → `invalid_amount`.
4. Rejects `amount: 100_000_000` → `invalid_amount`.
5. Rejects `next_occurrence_date: "2026-13-01"` → `invalid_next_date`.
6. Rejects `next_occurrence_date: "2026-02-30"` (not a real date) → `invalid_next_date`.
7. Rejects cross-workspace `categoryId` → `category_not_found`.
8. Rejects archived `categoryId` → `category_not_found`.
9. `listRecurringService` returns rows ordered by `nextOccurrenceDate` ASC, then `name` ASC.
10. `removeRecurringByIdService` returns `false` for cross-workspace id.
11. `removeRecurringByNameService` case-insensitive match + delete + returns `true`; returns `false` for nonexistent name.
12. `semimonthly` cadence is accepted and persisted.

### 11.2 `recurring.routes.test.ts` (~6 cases)

1. POST 201 with valid body.
2. POST 400 `invalid_amount` on `amount: 0`.
3. POST 404 `category_not_found` on missing category.
4. POST 402 `upgrade_required` on Free tier (after expiring trial).
5. GET 200 with viewer membership.
6. DELETE 204 happy path + 404 `recurring_not_found` on cross-workspace id.

### 11.3 `chat.tools.add-recurring.test.ts` (~5 cases)

1. Zod `safeParse` rejects `amount: 0`.
2. Zod `safeParse` rejects `next_occurrence_date: "not-a-date"`.
3. `semimonthly` cadence is accepted by Zod and persisted.
4. Resolves `category_name` case-insensitively and returns canonical `categoryName`.
5. Upserts on conflict: second call with same name updates the row.

### 11.4 `chat.tools.list-recurring.test.ts` (~3 cases)

1. Returns empty array when no rows.
2. Returns rows sorted by `nextOccurrenceDate` ASC, with `categoryName` hydrated for non-null `categoryId`.
3. Returns `categoryName: null` for rows whose categoryId is null OR whose category was archived (the rows themselves remain in the listing).

### 11.5 `chat.tools.remove-recurring.test.ts` (~3 cases)

1. Zod XOR refine: rejects when both `recurring_id` and `name` are present; rejects when neither is present.
2. Remove by id happy path returns `{ removed: true }`; cross-workspace id returns `{ removed: false }`.
3. Remove by name case-insensitive happy path returns `{ removed: true }`; nonexistent name returns `{ removed: false }`.

### 11.6 `chat.tools.registry.test.ts` (1 bump + new describe block)

- Bump expected tool count from 18 to 21.
- Add `describe("REGISTRY (plan 1c-recurring-persist)", …)` with 4 it-cases
  asserting the three new tools' names + canonical description strings.

---

## 12. Acceptance criteria

This plan is complete when:

1. Prisma migration applies cleanly on both `fina` and `fina_test` DBs.
2. `RecurringExpense` model + relations regenerate via `prisma generate`.
3. Three chat tools registered; registry test passes 21 tools.
4. Three HTTP routes return the codes in §6 for the corresponding inputs.
5. All new tests pass (~30 cases).
6. Baseline 72 files / 596 tests → 77 files / ~628 tests. No regressions in existing tests.
7. Migration name follows the pattern `<timestamp>_add_recurring_expenses`.
8. System prompt sentence extended exactly as in §9.
9. No new dependency in `package.json`.

---

## 13. Excluded scope

- `active` column / cancel-vs-pause semantics.
- `lastOccurrenceDate` column.
- Auto-link transactions to recurring on sync.
- `detectRecurringMerchants` "already persisted" flag.
- PATCH endpoint (POST is upsert).
- Semi-monthly second-anchor logic (forecasting future occurrences).
- Next-N-days forecast tool.
- `action_intents` / two-phase confirmation flow.
- `audit_events` write logging.
- UI changes.

---

## 14. Follow-up candidates

- **Plan 1C-recurring-active:** add `active` boolean + snooze/pause tools.
- **Plan 1C-recurring-forecast:** next-N-days tool + semimonthly anchor logic + integration with daily-ritual context.
- **Plan 1C-recurring-autolink:** transaction → recurring on Plaid sync.
- **Plan 1C-recurring-detect-link:** detectRecurringMerchants surfaces a `persistedId` field when a candidate already has a `RecurringExpense` row.
- **Plan 1C-schedule:** one-time `ScheduledSpend` entity + `addScheduledSpend`.
- **Plan 1C-confirmation:** `action_intents` + rich blocks.
- **Plan 1C-audit:** `audit_events` write log.
