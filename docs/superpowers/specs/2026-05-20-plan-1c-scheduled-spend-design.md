# Plan 1C-scheduled-spend — category-only future spend entries

**Date:** 2026-05-20
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes). Reverses the earlier ScheduledSpend
deferral (memory `project_scheduled_spend_deferred`) — design refined so the
entity is genuinely distinct from `Transaction` and `RecurringExpense`.

---

## 1. Goal

A `ScheduledSpend` is a single, future-dated expectation: "I will spend
roughly $X in category Y on date Z." Unlike `Transaction` it has no
merchant, no payment surface, and no impact on account balances. Unlike
`RecurringExpense` it is one-shot and has no cadence.

The feature integrates with budget planning so the user sees both
**past spent** and **upcoming planned** within the current period, and
gets a proactive nudge from Fina when a scheduled date passes without a
matching real transaction.

### Why we changed our mind from the deferral memo

The original decision (`memory/project_scheduled_spend_deferred.md`) held
that Recurring covered the same ground. After the user's refinement, the
shape diverges enough to justify a separate entity:

- **No merchant** — Recurring needs `merchantNormalized` for downstream
  auto-categorize matching; ScheduledSpend matches by category only.
- **Budget interaction** — Recurring is a forecast (informational);
  ScheduledSpend actively participates in the same `compareSpendingVsBudget`
  output as `spent`, surfaced as `planned`.
- **Auto-match → followup prompt** — once the scheduled date passes
  without a matching tx, Fina nudges the user about the missing expense.
  Recurring has no such loop.

### Out of scope

| Item | Why deferred |
|---|---|
| Daily brief (the message that actually surfaces unresolved schedules) | Phase 2 Magic Ritual; this plan provides the data + a chat tool query the brief generator will call. |
| Web/Mobile UI for schedule list/add | Separate UI plan. |
| HTTP audit log on the new routes | Consistent with prior 1C plans; deferred to `1C-audit-http`. |
| Conversion of schedule → manual transaction | Auto-match already covers the natural path. User can dismiss + add manually if they want explicit control. |
| Unifying Recurring + ScheduledSpend | Keep distinct; the shapes diverge enough. |
| PATCH endpoint to mutate schedule fields | YAGNI — dismiss + re-add covers it. |

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Entity | New `ScheduledSpend` model + `scheduled_spends` table |
| Identity | `(workspaceId, categoryId, scheduledDate)` is NOT unique — same day same category may have ≥2 schedules (e.g., two medical visits) |
| Required fields | `workspaceId`, `categoryId`, `amount Decimal(14,2)`, `scheduledDate Date` |
| Optional fields | `note String?` |
| State tracking | Two nullable timestamp columns: `matchedTxId String?` (cron sets when auto-match succeeds), `dismissedAt DateTime?` (user explicit dismiss). State is derived from these — no enum column. |
| Auto-match rule | `Transaction.occurredAt::date = scheduledDate AND ≥1 allocation has categoryId = scheduleCategoryId AND tx.removedAt IS NULL`. Amount ignored. |
| Auto-match scope | First matching tx wins. Order: `occurredAt asc, id asc`. |
| Cron frequency | Daily, runs after the existing Plaid sync job so newly-synced tx are visible. |
| Allow past `scheduledDate` on create | Yes — user may backfill a forgotten expectation. |
| API surface | Chat tools primary; HTTP routes for completeness (no PATCH). |
| Role gate | `editor+` for write paths; chat tool runs under editor session. |
| Validation | `amount` reuses transaction validators; `scheduledDate` strict YYYY-MM-DD; `categoryId` must exist and not be archived. |
| Budget integration | `compareSpendingVsBudgetService` adds `planned` aggregate alongside `spent`. |
| Concurrency | All writes inside `withWorkspaceLock` (same workspace-scoped advisory lock used by other 1C services). |
| Multiple users in workspace | Allowed. Schedule is workspace-owned, not user-owned. |
| Idempotent dismiss/remove | Yes — dismiss on an already-dismissed schedule is a no-op; remove on a missing id returns 404. |

---

## 3. Data model

### 3.1 New table

```prisma
model ScheduledSpend {
  id            String   @id @default(cuid())
  workspaceId   String
  categoryId    String
  amount        Decimal  @db.Decimal(14, 2)
  scheduledDate DateTime @db.Date
  note          String?
  matchedTxId   String?
  dismissedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  workspace Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category  Category     @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  matchedTx Transaction? @relation("ScheduledSpendMatch", fields: [matchedTxId], references: [id], onDelete: SetNull)

  @@index([workspaceId, scheduledDate])
  @@index([workspaceId, categoryId, scheduledDate])
  @@index([matchedTxId])
  @@map("scheduled_spends")
}
```

`Transaction` model gains the inverse relation:
```prisma
model Transaction {
  // ... existing fields ...
  matchedSchedules ScheduledSpend[] @relation("ScheduledSpendMatch")
}
```

`Category` model gains:
```prisma
model Category {
  // ... existing fields ...
  scheduledSpends ScheduledSpend[]
}
```

`Workspace` model gains the back-relation as Prisma requires.

### 3.2 Derived state (no enum column)

| Condition | State | Behavior |
|---|---|---|
| `matchedTxId IS NOT NULL` | resolved (auto-matched) | counted in `spent` via the matched tx; NOT in `planned` |
| `dismissedAt IS NOT NULL` | dismissed | excluded from `planned` and from unresolved-list |
| Else, `scheduledDate >= today` | upcoming | counted in `planned` |
| Else (`scheduledDate < today` and both null) | unresolved | counted in `planned`? **No** — past unresolved is the cue to ask, NOT to count |

Past-unresolved rationale: counting an unresolved past schedule would inflate the current period's `planned` indefinitely. Better to surface it as a prompt and let the user act.

### 3.3 Migration

Single Prisma migration `<ts>_add_scheduled_spends`:

```sql
CREATE TABLE "scheduled_spends" (
  "id"             TEXT PRIMARY KEY,
  "workspaceId"    TEXT NOT NULL,
  "categoryId"     TEXT NOT NULL,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "scheduledDate"  DATE NOT NULL,
  "note"           TEXT,
  "matchedTxId"    TEXT,
  "dismissedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scheduled_spends_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_spends_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_spends_matchedTxId_fkey"
    FOREIGN KEY ("matchedTxId") REFERENCES "transactions"("id") ON DELETE SET NULL
);
CREATE INDEX "scheduled_spends_workspaceId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "scheduledDate");
CREATE INDEX "scheduled_spends_workspaceId_categoryId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "categoryId", "scheduledDate");
CREATE INDEX "scheduled_spends_matchedTxId_idx"
  ON "scheduled_spends"("matchedTxId");
```

Pure additive — no risk to existing data.

---

## 4. API surface

### 4.1 Chat tools

All under `apps/api/src/chat/tools/`.

#### `addScheduledSpend`

```ts
Args: {
  category: string;         // category name (case-insensitive lookup in workspace)
  amount: number;
  scheduled_date: string;   // YYYY-MM-DD
  note?: string;
}
Result: { schedule: { id, categoryId, categoryName, amount, scheduledDate, note } }
```

Validates via `editor+`. Uses category-by-name lookup pattern from existing `addRecurring`. Confirmation flow: same intent/consume pattern as other write tools (per master design §11.1 confirmation).

#### `listScheduledSpends`

```ts
Args: {
  from?: string;   // YYYY-MM-DD inclusive
  to?: string;     // YYYY-MM-DD inclusive
  status?: "upcoming" | "unresolved" | "resolved" | "all";  // default "all"
}
Result: { schedules: Array<{ id, categoryId, categoryName, amount, scheduledDate, note, matchedTxId, dismissedAt, status }> }
```

`status` is the derived field computed at read time (§3.2).

#### `listUnresolvedSchedules`

A convenience wrapper around `listScheduledSpends({ status: "unresolved" })` so the Phase 2 daily-brief plan has a clean entry point. Internally calls the same service.

```ts
Args: {}     // no args; queries the active workspace
Result: { schedules: Array<{ id, categoryId, categoryName, amount, scheduledDate, note }> }
```

#### `dismissScheduledSpend`

```ts
Args: { schedule_id: string }
Result: { schedule: { id, dismissedAt } } | { dismissed: false, alreadyDismissed: true }
```

Sets `dismissedAt = now()`. Idempotent — second call on the same id returns `alreadyDismissed: true`.

#### `removeScheduledSpend`

```ts
Args: { schedule_id: string }
Result: { removed: boolean }
```

Hard delete. Used when user wants the schedule gone entirely (vs. just marking it dismissed).

### 4.2 HTTP routes (role: editor+)

- **`POST /workspaces/:id/schedules`** — body matches `addScheduledSpend` args. Returns `{ schedule: {...} }`.
- **`GET /workspaces/:id/schedules`** — query: `?from=&to=&status=`. Returns `{ schedules: [...] }`.
- **`POST /workspaces/:id/schedules/:scheduleId/dismiss`** — no body. Returns dismiss result.
- **`DELETE /workspaces/:id/schedules/:scheduleId`** — no body. Returns `{ removed: bool }`.

No PATCH endpoint (per YAGNI decision).

Error mapping:
| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_body` | Zod parse failure |
| 400 | `invalid_amount` / `invalid_date` / `invalid_note` | Validator failures |
| 400 | `workspace_mismatch` | path `:id` != session workspace |
| 403 | `insufficient_role` | viewer trying to write |
| 404 | `not_found` | schedule id not in workspace, OR category_not_found for non-existent/archived category |

### 4.3 Confirmation flow

`addScheduledSpend`, `dismissScheduledSpend`, `removeScheduledSpend` follow the existing confirmation pattern (§11.1 of master design) — intent is queued with `dispatch.ok`, user confirms, then `consumeIntentService` runs the actual write. `listScheduledSpends` and `listUnresolvedSchedules` are read-only and bypass confirmation.

Concrete: matches the existing patterns from `addRecurring`/`setBudget` chat tools. Reuse `AUDIT_WRITE_TOOLS` semantics if/when audit lands (per `1C-audit-http` deferral, audit hook is not wired in this plan).

---

## 5. Auto-match cron

### 5.1 Job placement

New file: `apps/api/src/cron/jobs/scheduled-spend-match.ts`.

Wire into the scheduler (`apps/api/src/cron/scheduler.ts`) as a **separate cron entry scheduled ~5 minutes after the daily Plaid refresh window** — ordering matters because freshly-synced posted Plaid tx need to be visible to the match scan. Registering as a distinct entry (rather than chaining into the Plaid job) keeps each job's failure independent.

### 5.2 Algorithm

For each active workspace:
1. Open `withWorkspaceLock(workspaceId, async (tx) => {...})`.
2. Inside the lock, query unresolved schedules:
   ```ts
   const candidates = await tx.scheduledSpend.findMany({
     where: {
       workspaceId,
       matchedTxId: null,
       dismissedAt: null,
       scheduledDate: { lte: today },  // only past-or-today; future schedules don't need matching yet
     },
     orderBy: { scheduledDate: "asc" },
   });
   ```
3. For each candidate, look for a matching tx:
   ```ts
   const match = await tx.transaction.findFirst({
     where: {
       workspaceId,
       removedAt: null,
       occurredAt: { gte: dayStart, lt: nextDayStart },
       allocations: { some: { categoryId: candidate.categoryId } },
     },
     orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
     select: { id: true },
   });
   if (match) {
     await tx.scheduledSpend.update({
       where: { id: candidate.id },
       data: { matchedTxId: match.id },
     });
   }
   ```
4. Schedules with no match remain `matchedTxId: null` (the unresolved state) — picked up by daily-brief later.

### 5.3 Edge cases

- **Multiple schedules same date+category**: each is matched independently against the same tx pool. Each schedule that finds a candidate locks onto the first tx by `(occurredAt asc, id asc)`. Two schedules on the same day with one tx → only the first schedule matches; second stays unresolved. Acceptable — user can dismiss the second or it surfaces in the brief.
- **Same tx matching multiple schedules**: yes — we don't deduplicate. The matched tx may show up under multiple schedules' `matchedTxId`. Budget aggregation treats this as a single tx contribution to spending (it always was one tx); the schedule "completed" state is just informational.
- **Tx deleted after match**: `onDelete: SetNull` on the FK clears `matchedTxId` automatically. The schedule goes back to unresolved state and resurfaces in the next brief.
- **Schedule scheduledDate in the future**: skipped (filter is `lte: today`).

---

## 6. Budget aggregation changes

### 6.1 `compareSpendingVsBudgetService` extension

`apps/api/src/budgets/service.ts:compareSpendingVsBudgetService` adds a parallel aggregation over `scheduled_spends` and emits a new `planned` field per category.

**Definition of `planned` for a budget category in a given period**:
- Sum of `amount` from `scheduled_spends` where:
  - `workspaceId = ctx.workspaceId`
  - `categoryId = budget.categoryId`
  - `scheduledDate >= today`  ← only future/today schedules count
  - `scheduledDate >= period.gte AND scheduledDate < period.lt`  ← within the period
  - `matchedTxId IS NULL`  ← not already realized
  - `dismissedAt IS NULL`  ← not dismissed

**Past unresolved** (`scheduledDate < today AND both null`) is intentionally NOT counted — counting it would inflate "planned" forever.

### 6.2 Response shape

```ts
{
  period: { start, end },
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;           // budget amount
    spent: string;            // unchanged
    planned: string;          // NEW — sum of upcoming schedules in period
    remaining: string;        // amount - spent - planned
    spentPct: number;         // spent / amount * 100
    plannedPct: number;       // planned / amount * 100
    todayPct: number;         // unchanged
    status: "on-pace" | "over-pace";
  }>;
}
```

Existing chat tools that consume `compareSpendingVsBudgetService` (e.g., `compare-spending-vs-budget.ts`) automatically inherit the new field. Their tool response schemas need updating to expose `planned` to the LLM.

### 6.3 `status` calculation note

Today's `status = spentPct > todayPct * 1.05 ? "over-pace" : "on-pace"`. We keep that semantic — `planned` is informational, not a pace warning. Future enhancement could add a `"projected-over"` status if `(spent + planned) > amount` but that's YAGNI.

---

## 7. Architecture (file list)

| File | Action | Responsibility |
|---|---|---|
| `apps/api/prisma/schema.prisma` | MODIFY | Add `ScheduledSpend` model + back-relations on Transaction, Category, Workspace |
| `apps/api/prisma/migrations/<ts>_add_scheduled_spends/migration.sql` | NEW | Create table + 3 indexes |
| `apps/api/src/schedules/service.ts` | NEW | `addScheduledSpendService`, `listScheduledSpendsService` (returns derived status), `dismissScheduledSpendService`, `removeScheduledSpendService` |
| `apps/api/src/schedules/match.ts` | NEW | `matchScheduledSpends(workspaceId, today)` — the core matching logic; called by both cron and (optionally) tests |
| `apps/api/src/cron/jobs/scheduled-spend-match.ts` | NEW | Per-workspace loop wrapping `matchScheduledSpends` |
| `apps/api/src/cron/scheduler.ts` | MODIFY | Register the new job |
| `apps/api/src/routes/schedules.ts` | NEW | 4 HTTP handlers |
| `apps/api/src/server.ts` | MODIFY | Register schedule routes |
| `apps/api/src/chat/tools/add-scheduled-spend.ts` | NEW | Chat tool |
| `apps/api/src/chat/tools/list-scheduled-spends.ts` | NEW | Chat tool |
| `apps/api/src/chat/tools/list-unresolved-schedules.ts` | NEW | Chat tool — wrapper for daily-brief consumption |
| `apps/api/src/chat/tools/dismiss-scheduled-spend.ts` | NEW | Chat tool |
| `apps/api/src/chat/tools/remove-scheduled-spend.ts` | NEW | Chat tool |
| `apps/api/src/chat/tools/index.ts` | MODIFY | Register the 5 new tools |
| `apps/api/src/budgets/service.ts` | MODIFY | Add `planned` aggregation to `compareSpendingVsBudgetService` |
| `apps/api/src/chat/tools/compare-spending-vs-budget.ts` | MODIFY | Response schema gains `planned` + `plannedPct` |
| `apps/api/src/intents/service.ts` | MODIFY | Register the 3 new write tools (`addScheduledSpend`, `dismissScheduledSpend`, `removeScheduledSpend`) in the dispatch map so confirmation/consume flow handles them like existing write tools (`addRecurring`, `setBudget`, etc.) |
| Tests for each src file | NEW/MODIFY | See §8 |

### 7.1 Service signatures

```ts
// schedules/service.ts

export type AddScheduledSpendInput = {
  workspaceId: string;
  categoryId: string;       // resolved from name in chat tool layer
  amount: number;
  scheduledDate: string;    // YYYY-MM-DD
  note?: string;
};

export type ScheduledSpendStatus = "upcoming" | "unresolved" | "resolved-matched" | "resolved-dismissed";

export type AddScheduledSpendErrorCode =
  | "invalid_amount" | "invalid_date" | "invalid_note" | "category_not_found";

export class ScheduledSpendError extends Error {
  readonly code: AddScheduledSpendErrorCode | "not_found";
  constructor(code: ScheduledSpendError["code"]);
}

export async function addScheduledSpendService(input: AddScheduledSpendInput): Promise<{ schedule: ... }>;
export async function listScheduledSpendsService(ctx: { workspaceId: string }, filter: { from?: Date; to?: Date; status?: ScheduledSpendStatus | "all" }): Promise<{ schedules: ... }>;
export async function dismissScheduledSpendService(ctx, id): Promise<DismissResult>;
export async function removeScheduledSpendService(ctx, id): Promise<{ removed: boolean }>;
```

```ts
// schedules/match.ts

export async function matchScheduledSpends(
  workspaceId: string,
  today: Date,
): Promise<{ matched: number; unresolved: number }>;
```

The match function is called from inside `withWorkspaceLock`'s callback — its signature accepts the `tx` client OR it manages its own lock (decide at implementation time; defaulting to "manages its own" so the cron entry point can call it once per workspace).

---

## 8. Testing strategy

### 8.1 Service unit tests

`apps/api/tests/schedules.service.test.ts`:

| Case | Assertion |
|---|---|
| `add` happy | Schedule row created with all fields |
| `add` invalid amount (0.005) | `invalid_amount` |
| `add` invalid date (2026-13-01) | `invalid_date` |
| `add` archived category | `category_not_found` |
| `add` past date | Accepted (allowed per §2) |
| `list` returns all with status field derived | `upcoming` / `unresolved` / `resolved-matched` / `resolved-dismissed` classified correctly |
| `list` filter by `from`/`to` | Returns only schedules in date range |
| `list` filter by status | Returns matching subset |
| `dismiss` happy | Sets `dismissedAt`, returns success |
| `dismiss` already-dismissed | Idempotent — returns `alreadyDismissed: true` |
| `dismiss` non-existent | `not_found` |
| `dismiss` matched schedule | Allowed — sets `dismissedAt`. Status derivation always prefers `matchedTxId` over `dismissedAt` (per §3.2 table order), so the schedule keeps `resolved-matched` status. The `dismissedAt` value persists harmlessly. No error. |
| `remove` happy | Hard delete |
| `remove` non-existent | Returns `{ removed: false }` (idempotent), not error |

### 8.2 Match function unit tests

`apps/api/tests/schedules.match.test.ts`:

| Case | Setup | Assertion |
|---|---|---|
| Schedule date today, no tx | Schedule today, no tx anywhere | `matchedTxId` stays NULL, schedule counted in unresolved |
| Schedule date today, matching tx today | Schedule today $300 Health, tx today Health $50 | matchedTxId = tx.id |
| Schedule date today, tx in different category | Schedule today Health, tx today Groceries | No match |
| Schedule date today, tx on different day | Schedule today Health, tx yesterday Health | No match |
| Schedule date today, tx removed | Schedule today Health, tx today Health removedAt=now() | No match |
| Schedule date today, tx exists in workspace B | Schedule WS A, tx WS B | No match — cross-workspace isolation |
| Two schedules same day same category, one tx | Two schedules, one tx in category | First schedule matches, second stays unresolved |
| Idempotent — schedule already matched | Schedule with matchedTxId set | Match function leaves it alone |
| Idempotent — schedule already dismissed | Schedule with dismissedAt set | Match function ignores it |
| Schedule date in future | Schedule 7 days from now | Skipped (date > today filter) |
| Schedule split-tx category | Schedule Health today, tx today with allocations [Health $60, Other $40] | Matched (allocation predicate) |

### 8.3 Budget aggregation tests

Extend `apps/api/tests/budgets.service.test.ts`:

| Case | Setup | Assertion |
|---|---|---|
| `planned` for category with one upcoming schedule | Budget X, schedule for X 7d from now $100 | `planned === "100.00"` |
| `planned` excludes past unresolved | Schedule 7d ago, no match, no dismiss | `planned === "0.00"` for that category |
| `planned` excludes matched | Schedule with matchedTxId set | `planned === "0.00"` |
| `planned` excludes dismissed | Schedule with dismissedAt set | `planned === "0.00"` |
| `planned` sums multiple upcoming schedules | Two upcoming schedules in same category | `planned === sum` |
| `plannedPct` calculation | budget $200, planned $50 | `plannedPct === 25` |
| `remaining` includes planned | budget $200, spent $80, planned $50 | `remaining === "70.00"` |
| Period boundary | Schedule date = period.lt | Excluded (strict less-than) |
| Period boundary 2 | Schedule date = period.gte (today) | Included |

### 8.4 Cron job tests

`apps/api/tests/cron.scheduled-spend-match.test.ts`:

| Case | Assertion |
|---|---|
| Cron runs on workspace with no schedules | No DB writes, returns `{ matched: 0, unresolved: 0 }` |
| Cron matches a single schedule | matchedTxId set, returns `{ matched: 1, unresolved: 0 }` |
| Cron leaves unresolved | matchedTxId stays NULL, returns `{ matched: 0, unresolved: 1 }` |
| Concurrent run safety | Two concurrent calls — workspace lock serializes; second call sees first's work, no double-match |
| Multiple workspaces | Iterates all active workspaces independently |

### 8.5 HTTP route tests

`apps/api/tests/schedules.route.test.ts`:
- POST happy 201
- POST 400 invalid_body / invalid_amount / invalid_date
- POST 404 category_not_found
- POST 401 / 403 / workspace_mismatch
- GET happy with status filter
- DISMISS happy + idempotent + 404
- DELETE happy + idempotent + 404 / 401 / 403

### 8.6 Chat tool tests

One test file per new tool. Standard pattern from existing chat tool tests — confirm intent path (for write tools) + service is invoked + result shape.

### 8.7 Smoke

`docs/superpowers/smoke-tests/2026-05-20-plan-1c-scheduled-spend.md`:
1. Add schedule via HTTP → 201
2. List → schedule appears with `status: upcoming`
3. Add transaction matching the schedule's category on the scheduled date
4. Run cron manually (`pnpm api:dev` env or direct invoke) → schedule's `matchedTxId` set
5. List → schedule shows `status: resolved-matched`
6. Dismiss a different unresolved past schedule → status flips to `resolved-dismissed`
7. Budget compare endpoint shows `planned` for upcoming schedules
8. Past unresolved schedule does NOT inflate `planned`
9. Delete a schedule → 200, gone from list

---

## 9. Reviewer checklist

- [ ] New `ScheduledSpend` model + back-relations + 3 indexes
- [ ] Migration is purely additive — no risk to existing data
- [ ] All write services use `withWorkspaceLock`
- [ ] Category lookup re-checked inside lock (archivedAt invalidation) — same pattern as `manual-categorize` post-round-3
- [ ] Auto-match cron filters `scheduledDate <= today AND matchedTxId IS NULL AND dismissedAt IS NULL`
- [ ] Match query uses `allocations: { some: { categoryId } }` predicate (split tx aware)
- [ ] Match query filters `removedAt IS NULL` on the tx
- [ ] Multiple schedules same day same category: each matched independently, first-wins on shared tx
- [ ] `compareSpendingVsBudget` adds `planned` field — sums upcoming schedules only (today's date and forward), within period
- [ ] Past unresolved schedules NOT counted in `planned`
- [ ] `compare-spending-vs-budget` chat tool response schema updated
- [ ] No PATCH endpoint (YAGNI)
- [ ] No HTTP audit log (deferred to `1C-audit-http`)
- [ ] Chat tools registered in `chat/tools/index.ts`
- [ ] HTTP routes registered in `server.ts`
- [ ] Strict Decimal equality on amount validation
- [ ] Date stored as Postgres `DATE` (no timezone), parsed strict YYYY-MM-DD
- [ ] Idempotent dismiss + idempotent-ish remove (returns `removed: false` rather than 404 on non-existent)
- [ ] `listUnresolvedSchedules` chat tool exists as a clean entry for the Phase 2 daily-brief plan
