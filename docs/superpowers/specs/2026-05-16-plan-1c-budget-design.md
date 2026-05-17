# Plan 1C-budget — Monthly per-category budgets

**Date:** 2026-05-16
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation, per master design §15.1C)

---

## 1. Goal

Add **monthly per-category budgets** with a complete surface:

- 3 chat tools: `setBudget`, `getBudget`, `compareSpendingVsBudget`.
- 3 HTTP routes: POST/GET/DELETE on `/workspaces/:id/budgets`.
- One new Prisma model `Budget` + migration. No schema changes elsewhere.

This satisfies the `getBudget`/`setBudget` tool entries in master design §5 and
the `setBudget` write-tool requirement in §15.1C. Weekly budgets, rollover,
currency variation, and overall (no-category) budgets are explicit follow-ups.

---

## 2. Background

`master design §5` lists `getBudget({ category?, period? })` and
`setBudget({ category, amount, period })` as required chat tools. `master
design §8` proposes:

```
budgets (id, workspace_id, category_id, period: monthly/weekly,
         amount, currency, start_date, rollover: bool,
         UNIQUE(workspace_id, category_id, period, start_date))
```

For v1 we drop `period`/`currency`/`rollover` per YAGNI — they become a
schema migration the day the corresponding feature lands.

The chat route is already Pro-gated. Writes from non-Pro tiers fail with
`402 upgrade_required` at the route level (existing 1D enforcement).
Read-only HTTP routes are tier-agnostic (viewers can see budgets even on Free
plans — the data is theirs).

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| v1 scope | Monthly per-category only |
| Surface | 3 chat tools + 3 HTTP routes |
| Role gate (chat + HTTP write) | editor+ (matches chat route + `categorizeTransaction`) |
| Tier gate (HTTP write) | Pro only (matches chat) |
| Tier gate (HTTP read) | All tiers (data ownership) |
| `period` enum | `"this_month" \| "last_month" \| "next_month"` |
| Period date in request | Computed server-side from enum; raw DATE not accepted via chat/POST |
| `periodStart` storage | `@db.Date` (calendar date), first of month in user-tz |
| Conflict on (ws, cat, periodStart) | Upsert (server-issued period; POST is set-or-update) |
| `Budget.amount` cap | `Decimal(10,2)` = max 99,999,999.99 |
| `period` column | Not added in v1 (weekly migration adds it later if needed) |
| `currency` column | Not added (pin to workspace currency via Transaction.currency, CAD default) |
| `rollover` | Not added |
| Overall (no-category) budget | Not supported v1 |
| PATCH endpoint | Not added — POST is upsert |
| Bulk set | Not supported |
| Confirmation flow (action_intents) | Out of scope — separate 1C-confirmation plan |
| Audit log | Out of scope — separate 1C-audit plan |

---

## 4. Data model

Prisma model added to `apps/api/prisma/schema.prisma`:

```prisma
model Budget {
  id           String   @id @default(cuid())
  workspaceId  String
  categoryId   String
  amount       Decimal  @db.Decimal(10, 2)
  periodStart  DateTime @db.Date
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category     Category  @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, categoryId, periodStart])
  @@index([workspaceId, periodStart])
  @@map("budgets")
}
```

Inverse relations added to `Workspace` (`budgets Budget[]`) and `Category`
(`budgets Budget[]`).

Notes:

- **`@db.Date`** is timezone-naive in Postgres. We always set `periodStart` to
  the first-of-month calendar date in the **user's timezone** (resolved via
  `resolveUserTz` from Plan 1E-time). The 1E-time helpers (`basicPeriodRange`,
  `partsInTz`) produce the right UTC instant for the period bounds when
  querying transactions; for the DATE column we extract the `year`/`month`
  in user-tz and set day=1.
- **Two-way cascade** so deleting a workspace or category cleans up budgets.
  Category deletion (archive vs hard delete) is separate; the existing
  category routes only soft-archive (`archivedAt`). Hard-delete is not in
  scope, so this cascade rarely fires for categories — it's defense-in-depth.

---

## 5. Period→periodStart computation

The function uses a new **exported** helper added to `apps/api/src/chat/tools/periods.ts`. The existing helpers `partsInTz`, `startOfMonth`, etc. are private to that file — rather than export them all, this plan adds one focused export:

```typescript
// apps/api/src/chat/tools/periods.ts (new export, alongside existing exports)
export async function firstOfMonthDateInTz(
  userId: string,
  monthsOffset: number,        // 0 = this month, -1 = last, +1 = next
  now: Date = new Date(),
): Promise<Date> {
  const tz = await resolveUserTz(userId);
  // partsInTz is already used internally; this wrapper avoids exposing it.
  // Implementation mirrors the existing basicPeriodRange month arithmetic.
  // Returns Date at 12:00:00.000Z on the first of the resulting month —
  // safe for the @db.Date column (calendar date is unambiguous across
  // UTC-11..+11 zones, per 1E-time §5).
}
```

The budget service then calls:

```typescript
import { firstOfMonthDateInTz, basicPeriodRange } from "../chat/tools/periods.js";

async function periodStartFor(userId: string, period: "this_month" | "last_month" | "next_month"): Promise<Date> {
  const offset = period === "this_month" ? 0 : period === "last_month" ? -1 : 1;
  return firstOfMonthDateInTz(userId, offset);
}
```

The `T12:00:00Z` anchor matches 1E-time's UTC-noon storage policy — the DATE
column extracts the calendar date in UTC, which equals the user-local month's
first day across UTC-11..+11 zones. (UTC±12 known limitation per 1E-time §5.)

For `compareSpendingVsBudget`, the period start comes from `firstOfMonthDateInTz`.
The transaction filter range `{ gte, lt }` is computed by period:

- `period === "this_month"` → `basicPeriodRange(userId, "this_month")`.
- `period === "last_month"` → `basicPeriodRange(userId, "last_month")`.
- `period === "next_month"` → **explicit empty range** `{ gte: periodStart, lt: periodStart }` (UTC noon of next month's first day, used as both bounds so no transaction matches). This guarantees `spent = 0` for every budget regardless of current-month activity.

DO NOT call `basicPeriodRange(userId, "this_month")` as a fallback for `next_month` — that returns the **current** month's window and would attribute current spending to next month's budgets.

---

## 6. Service module

`apps/api/src/budgets/service.ts` exports four functions. All take a
`{ workspaceId, userId }` context plus the typed input and return typed
output. They throw `Error("error_code")` for the validation/lookup failures
listed in §7; the route maps to HTTP, the chat tool maps to LLM error
strings.

```typescript
export type SetBudgetInput = { categoryId: string; amount: number; period: "this_month" | "last_month" | "next_month" };
export type SetBudgetOutput = { budget: { id: string; categoryId: string; amount: string; periodStart: string } };

export type GetBudgetInput =
  | { categoryId?: string; period: "this_month" | "last_month" | "next_month" }
  | { categoryId?: string; periodStart: Date };
export type GetBudgetOutput = { budgets: Array<{ id: string; categoryId: string; amount: string; periodStart: string }> };

export type DeleteBudgetInput = { budgetId: string };

export type CompareSpendingInput = { period: "this_month" | "last_month" | "next_month" };
export type CompareSpendingOutput = {
  period: { start: string; end: string };
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;
    spent: string;
    remaining: string;
    spentPct: number;
    todayPct: number;
    status: "on-pace" | "over-pace";
  }>;
};

export async function setBudgetService(ctx: { workspaceId: string; userId: string }, input: SetBudgetInput): Promise<SetBudgetOutput>;
export async function getBudgetService(ctx: { workspaceId: string; userId: string }, input: GetBudgetInput): Promise<GetBudgetOutput>;
export async function deleteBudgetService(ctx: { workspaceId: string }, input: DeleteBudgetInput): Promise<boolean>;
export async function compareSpendingVsBudgetService(ctx: { workspaceId: string; userId: string }, input: CompareSpendingInput): Promise<CompareSpendingOutput>;
```

**`setBudgetService`:**
1. Validate `amount > 0` and `amount <= 99_999_999.99` → throw `invalid_amount`.
2. Compute `periodStart = await periodStartFor(userId, period)`.
3. Resolve category: `findFirst({ where: { id: categoryId, workspaceId, archivedAt: null }, select: { id: true, name: true } })`. Null → throw `category_not_found`.
4. Upsert: `prisma.budget.upsert({ where: { workspaceId_categoryId_periodStart: { workspaceId, categoryId, periodStart } }, create: { workspaceId, categoryId, amount, periodStart }, update: { amount } })`.
5. Return `{ budget: { id, categoryId, amount: amount.toFixed(2), periodStart: periodStart.toISOString().slice(0, 10) } }`.

**`getBudgetService`:**
1. Compute `periodStart`.
2. If `categoryId`: return `{ budgets: rowOrEmpty }` filtered to that category.
3. Else: return all budgets for the workspace + periodStart.
4. Map rows to the output shape.

**`deleteBudgetService`:**
1. `deleteMany({ where: { id: budgetId, workspaceId } })`.
2. Return `count > 0`.

**`compareSpendingVsBudgetService`:**
1. Compute `periodStart` (DATE) via `firstOfMonthDateInTz`. Compute the
   transaction filter `{ gte, lt }` by period:
   - `period = "this_month"`: `basicPeriodRange(userId, "this_month")`. `todayPct = days_elapsed_in_month / days_in_month * 100`.
   - `period = "last_month"`: `basicPeriodRange(userId, "last_month")`. `todayPct = 100`.
   - `period = "next_month"`: **explicit empty range** `{ gte: periodStart, lt: periodStart }` (UTC noon of next month's first day used as both bounds). `todayPct = 0`. Do NOT fall back to `basicPeriodRange(userId, "this_month")` — that returns the current month's window and would attribute this-month spending to next-month budgets.
2. Fetch budgets for the period: `findMany({ where: { workspaceId, periodStart }, include: { category: { select: { name: true } } } })`.
3. Fetch transaction sums per category: `groupBy({ by: ['categoryId'], where: { workspaceId, removedAt: null, occurredAt: { gte, lt }, categoryId: { in: budgetCategoryIds }, currency: "CAD", amount: { gt: 0 } }, _sum: { amount: true } })`. The `currency: "CAD"` + `amount: { gt: 0 }` filters match the existing convention in `get-category-breakdown.ts` and `get-cashflow-summary.ts` for "spending" — they exclude USD/foreign-currency transactions (since v1 budgets are implicitly CAD) and refund/inflow rows (negative amounts), so `spent`/`remaining`/pace are calculated against actual outflows only.
4. For each budget, compute `spent` (sum or 0), `remaining = amount - spent`, `spentPct = spent / amount * 100` (or 0 if amount = 0 — but amount > 0 enforced), `todayPct = days_elapsed / days_in_month * 100`, `status` = `"on-pace"` if `spentPct <= todayPct * 1.05` else `"over-pace"`. For `last_month`, `todayPct = 100`. For `next_month`, `todayPct = 0` and `spent = 0`.

---

## 7. Validation + error codes

| Code | Cause | HTTP | Chat tool surfaces it |
|---|---|---|---|
| `invalid_amount` | `amount <= 0` or `> 99999999.99` or NaN | 400 | yes |
| `invalid_period` | Bad enum (Zod catches this first) | 400 | yes |
| `invalid_period_start` | GET query `period_start` not first-of-month | 400 | no (chat doesn't take raw date) |
| `invalid_body` | Missing fields, both categoryId+name set, etc. | 400 | yes (chat uses Zod) |
| `category_not_found` | Category not in workspace or archived | 404 | yes |
| `budget_not_found` | DELETE id doesn't match a budget in this workspace | 404 | no (chat doesn't delete) |
| `upgrade_required` | POST/DELETE from non-Pro | 402 | no (chat route Pre-gated) |

---

## 8. Chat tools

All three tools use the standard `ToolDef` signature from `apps/api/src/chat/tools/types.ts` (Plan 1E-write).

### 8.1 `setBudget`

```typescript
const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  amount: z.number().positive().max(99_999_999.99),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
}).refine(
  (a) => Boolean(a.category_id) !== Boolean(a.category_name),
  { message: "Provide exactly one of category_id or category_name" },
);
```

Behavior:
1. If `category_id` present, use it. Else resolve `category_name`
   case-insensitively in the same workspace (`findFirst({ where: { workspaceId, name: { equals, mode: "insensitive" }, archivedAt: null } })`). Not found → throw `category_not_found`.
2. Call `setBudgetService` with `{ categoryId, amount, period: period ?? "this_month" }`.
3. Return `{ budget: { id, categoryId, categoryName: <canonical from DB>, amount, periodStart } }`.

### 8.2 `getBudget`

```typescript
const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});
```

Behavior:
1. If both `category_id` and `category_name` provided → `invalid_body`.
2. Resolve to `categoryId` (or `undefined` if neither provided).
3. Call `getBudgetService({ categoryId, period: period ?? "this_month" })`.
4. Return `{ budgets: [...] }` (always array; empty when none).

### 8.3 `compareSpendingVsBudget`

```typescript
const Args = z.object({
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});
```

Behavior:
1. Call `compareSpendingVsBudgetService({ period: period ?? "this_month" })`.
2. Return the service output directly.

### 8.4 Registry

`apps/api/src/chat/tools/index.ts` adds the three tools at positions 15/16/17.
Registry count test bumps from 14 to 17. Tool names must be unique across the
registry (existing test catches duplicates).

---

## 9. HTTP routes

`apps/api/src/routes/budgets.ts`:

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  setBudgetService,
  getBudgetService,
  deleteBudgetService,
} from "../budgets/service.js";

export function registerBudgetsRoutes(app: FastifyInstance) {
  // POST /workspaces/:id/budgets — editor+, Pro
  // GET  /workspaces/:id/budgets?period_start=YYYY-MM-DD — viewer+, all tiers
  // DELETE /workspaces/:id/budgets/:budgetId — editor+, Pro
}
```

Each handler:
- Calls `requireWorkspaceContext(req, app, { requiredRole: "editor" | "viewer" })`.
- For write ops: `effectiveTier(userId)` — return 402 if not Pro.
- Catches `HttpError` → maps to `reply.code(e.statusCode).send({ error: e.code })`.
- Catches service errors (string-based) → maps to the table in §7.

`GET` accepts an optional `period_start` query param (`YYYY-MM-DD`).
Validation: must parse as a Date and have day-of-month = 1, else `400 invalid_period_start`.

To support arbitrary historical months (`/budgets?period_start=2026-03-01`)
without forcing the route into the enum world, the **service** contract
accepts an `inputPeriodStart?: Date` alternative path:

```typescript
export type GetBudgetInput =
  | { categoryId?: string; period: "this_month" | "last_month" | "next_month" }
  | { categoryId?: string; periodStart: Date };
```

`getBudgetService` resolves `periodStart` from whichever variant arrived,
then proceeds identically. The chat tool only ever sends the enum variant
(no raw dates from the LLM); the HTTP route uses the `Date` variant when
`period_start` is supplied and falls back to `period: "this_month"` enum
when it is not.

Register the routes in `apps/api/src/server.ts` alongside existing route
registrations.

---

## 10. System prompt

The 1E-write system-prompt sentence currently names two tools explicitly:

> For write tools (createCategory, addTransactionNote), briefly confirm
> with the user before invoking unless the request is unambiguous.

To extend that guidance to `setBudget`, modify the existing sentence in
`apps/api/src/chat/turn.ts` so the LLM sees `setBudget` in the same list:

> For write tools (createCategory, addTransactionNote, setBudget), briefly
> confirm with the user before invoking unless the request is unambiguous.
> Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500
> 달러로 설정해줘'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or
> '식비 예산 줄여야 할까?'

`getBudget` and `compareSpendingVsBudget` are read tools — they do not
need confirmation guidance.

---

## 11. Tests

### 11.1 `apps/api/tests/budgets.service.test.ts` (~11 cases)

1. `setBudgetService` creates a new row at the expected `periodStart`.
2. `setBudgetService` upserts on conflict (second call updates `amount`).
3. `setBudgetService` rejects `amount: 0` → `invalid_amount`.
4. `setBudgetService` rejects `amount: -1` → `invalid_amount`.
5. `setBudgetService` rejects amount over Decimal cap → `invalid_amount`.
6. `setBudgetService` rejects archived category → `category_not_found`.
7. `setBudgetService` rejects cross-workspace category → `category_not_found`.
8. `getBudgetService` filters by `categoryId` (returns `[row]` or `[]`).
9. `getBudgetService` returns all rows for the period when no `categoryId`.
10. `deleteBudgetService` returns false for cross-workspace id.
11. `periodStart` computed in Toronto user-tz matches first-of-month locally
    even when server is UTC (TZ-pin test like 1E-time §9.2).

### 11.2 `apps/api/tests/budgets.routes.test.ts` (~6 cases)

1. `POST` 201 with valid body.
2. `POST` 400 on `amount: 0`.
3. `POST` 404 on missing category.
4. `POST` 402 on non-Pro tier.
5. `GET` 200 with viewer membership.
6. `DELETE` 204 happy path + 404 on cross-workspace.

### 11.3 `apps/api/tests/chat.tools.set-budget.test.ts` (~5 cases)

1. Zod `safeParse` rejects `amount: 0`.
2. Zod `safeParse` rejects both `category_id` + `category_name`.
3. `run` resolves category by name case-insensitively.
4. `run` upserts on conflict.
5. `run` returns canonical `categoryName` from DB lookup.

### 11.4 `apps/api/tests/chat.tools.get-budget.test.ts` (~3 cases)

1. Single budget when `category_id` provided.
2. All budgets when no category provided.
3. Empty array when no budgets exist.

### 11.5 `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts` (~5 cases)

1. Mid-month on-pace (spent below pace).
2. Mid-month over-pace (spent > pace + 5%).
3. `last_month` uses full-month baseline (todayPct = 100).
4. Excludes categories without a budget for the period.
5. Sums only transactions in the same workspace.

### 11.6 `apps/api/tests/chat.tools.registry.test.ts` (1 case bump)

Bump expected tool count from 14 to 17. Names assertion includes
`setBudget`, `getBudget`, `compareSpendingVsBudget`.

---

## 12. Acceptance criteria

This plan is complete when:

1. Prisma migration applies cleanly on both `fina` and `fina_test` DBs.
2. `Budget` model + relations on `Workspace`/`Category` regenerate via
   `prisma generate`.
3. Three chat tools registered, `chat.tools.registry.test.ts` passes
   17 tools.
4. Three HTTP routes return the codes in §7 for the corresponding inputs.
5. All new tests pass (~28 cases).
6. Baseline 64 files / 529 tests → 70 files / ~557 tests. No regressions
   in existing tests.
7. Migration name follows the pattern `<timestamp>_add_budgets`.

---

## 13. Excluded scope

- Weekly budgets (`period` column).
- Rollover.
- Currency variation.
- Overall (no-category) budget.
- `PATCH` endpoint (POST is upsert).
- Bulk set across categories.
- `action_intents` / two-phase confirmation flow.
- `audit_events` write logging.
- UI changes (user iterating separately).
- `compareSpendingVsBudget` HTTP route (chat tool only v1).

---

## 14. Follow-up candidates

- **Plan 1C-merchant-map:** `mapMerchantToCategory` write tool (next in 1C
  sequence; `MerchantMapping` table already exists from 1B-categorize).
- **Plan 1C-budget-weekly:** add `period` enum, weekly periods anchored to
  Mondays.
- **Plan 1C-budget-rollover:** `rollover: bool` column + unused-amount
  carry-over logic.
- **Plan 1C-budget-overall:** nullable `categoryId` for whole-workspace cap.
- **Plan 1C-recurring-persist:** persist `detectRecurringMerchants` patterns.
- **Plan 1C-schedule:** `ScheduledSpend` entity + `addScheduledSpend` write.
- **Plan 1C-confirmation:** `action_intents` + `categorize_card`/`confirm_card`
  block model.
- **Plan 1C-audit:** `audit_events` write log for all mutate tools.
