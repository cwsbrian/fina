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
| Auto-match scope | **One-to-one**: each schedule consumes at most ONE tx. Within a workspace+date+category, schedule order is `scheduledDate asc, createdAt asc, id asc`; tx order is `occurredAt asc, id asc`. Already-consumed tx ids are excluded from later schedules' candidate pool. |
| Cron schedule | Concrete cron string `"5 9 * * *"` (09:05 UTC) — runs 5 minutes after the existing daily Plaid refresh at `"0 9 * * *"` (`apps/api/src/cron/scheduler.ts`). Scheduler entries are independent `new Cron("expr")` registrations, NOT chained — the 5-minute offset is a best-effort ordering, not a guarantee. Budget aggregation uses anti-join semantics (§6.1) so today's flicker is impossible regardless of cron lag. |
| Timezone | Schedules store dates as Postgres `@db.Date` (wall-clock). "Today" comparisons are computed in the **workspace owner's user timezone** — resolved via the first owner-membership's `User.tz`. For budget aggregation, `today` uses the calling user's tz (matches the existing `compareSpendingVsBudgetService` pattern). |
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
| `matchedTxId IS NOT NULL AND matchedTx.removedAt IS NULL` | resolved-matched | counted in `spent` via the matched tx; NOT in `planned` |
| `matchedTxId IS NOT NULL AND matchedTx.removedAt IS NOT NULL` | unresolved (matched-tx-removed) | the soft-removed match invalidates the resolution. See §5.4 for the cleanup hook. Treated as unresolved until re-matched. |
| `dismissedAt IS NOT NULL` (and not matched) | resolved-dismissed | excluded from `planned` and from unresolved-list |
| Else, `scheduledDate > today` (strict future) | upcoming | counted in `planned` |
| Else, `scheduledDate = today` AND no tx exists on that date+category | upcoming-today | counted in `planned` (anti-join — see §6.1) |
| Else, `scheduledDate = today` AND tx exists on that date+category | provisional-matched | excluded from `planned` (tx already counted in `spent`); cron will set `matchedTxId` on next run |
| Else (`scheduledDate < today` and both null) | unresolved | NOT counted in `planned` — surface as prompt |

Past-unresolved rationale: counting an unresolved past schedule would inflate the current period's `planned` indefinitely. Better to surface it as a prompt and let the user act.

Today's anti-join rationale: prevents same-day double-counting between `spent` (real tx) and `planned` (schedule). Once the matching tx exists, the schedule is implicitly "covered" regardless of whether cron has run.

**Status filter values for `listScheduledSpends`**:
- `"upcoming"` — `upcoming OR upcoming-today` (excludes `provisional-matched`)
- `"unresolved"` — past unresolved + matched-tx-removed
- `"resolved-matched"` — matched + matchedTx still active
- `"resolved-dismissed"` — dismissed (and not matched)
- `"all"` — every schedule

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

**Reject dismiss on already-matched schedules**: if `matchedTxId IS NOT NULL` (and matchedTx is not soft-removed), return 400 `already_matched`. Rationale: setting `dismissedAt` on a matched schedule creates hidden state — derivation correctly prefers matched, but if the matched tx is later soft-removed (clearing matchedTxId via the §5.4 hook), the lingering `dismissedAt` causes the schedule to be incorrectly classified as `resolved-dismissed` instead of `unresolved`. Cleaner to reject dismiss outright.

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
- **`DELETE /workspaces/:id/schedules/:scheduleId`** — no body. Returns `{ removed: true }` on first call, `{ removed: false, alreadyRemoved: true }` if not found (idempotent — same pattern as `removeTransactionService`). No 404 on missing id.

No PATCH endpoint (per YAGNI decision).

Error mapping:
| Status | Code | Cause |
|---|---|---|
| 400 | `invalid_body` | Zod parse failure |
| 400 | `invalid_amount` / `invalid_date` / `invalid_note` | Validator failures |
| 400 | `already_matched` | dismiss attempted on a schedule with active matchedTxId |
| 400 | `workspace_mismatch` | path `:id` != session workspace |
| 403 | `insufficient_role` | viewer trying to write |
| 404 | `not_found` | schedule id not in workspace (POST dismiss only — DELETE is idempotent) OR `category_not_found` for non-existent/archived category on POST create |

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
1. Resolve workspace owner's `User.tz` → compute `today` in that tz.
2. Open `withWorkspaceLock(workspaceId, async (tx) => {...})`.
3. Inside the lock, query unresolved schedules with deterministic ordering:
   ```ts
   const candidates = await tx.scheduledSpend.findMany({
     where: {
       workspaceId,
       matchedTxId: null,
       dismissedAt: null,
       scheduledDate: { lte: today },  // past-or-today
     },
     orderBy: [
       { scheduledDate: "asc" },
       { createdAt: "asc" },
       { id: "asc" },  // tiebreaker for createdAt ties
     ],
   });
   ```
4. Maintain a `usedTxIds: Set<string>` across the inner loop to enforce one-to-one (a tx can match at most one schedule per cron run):
   ```ts
   const usedTxIds = new Set<string>();
   for (const candidate of candidates) {
     const dayStart = ... // start of candidate.scheduledDate in workspace tz
     const nextDayStart = ... // dayStart + 1 day
     const match = await tx.transaction.findFirst({
       where: {
         workspaceId,
         removedAt: null,
         occurredAt: { gte: dayStart, lt: nextDayStart },
         allocations: { some: { categoryId: candidate.categoryId } },
         id: { notIn: Array.from(usedTxIds) },  // exclude already-consumed tx
       },
       orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
       select: { id: true },
     });
     if (match) {
       await tx.scheduledSpend.update({
         where: { id: candidate.id },
         data: { matchedTxId: match.id },
       });
       usedTxIds.add(match.id);
     }
   }
   ```
5. Schedules with no match remain `matchedTxId: null` — picked up by daily-brief later.

The `usedTxIds.notIn` clause ensures that on a day where the user has fewer matching tx than schedules, only the first N schedules (in order above) match; the rest stay unresolved. Each subsequent cron run can pick up new tx without revisiting already-matched schedules (those are filtered out by `matchedTxId: null`).

### 5.3 Edge cases

- **Multiple schedules same date+category, one tx**: per §5.2's `usedTxIds.notIn` clause, only the first schedule (by `scheduledDate asc, createdAt asc, id asc`) matches; the rest stay unresolved. User can dismiss extras or they surface in the brief.
- **Multiple schedules same date+category, multiple tx**: schedules consume tx 1:1 in the deterministic order. Extras (on either side) remain unresolved.
- **Tx HARD-deleted after match**: `onDelete: SetNull` on the FK clears `matchedTxId` automatically. The schedule goes back to unresolved state and resurfaces in the next brief.
- **Tx SOFT-removed after match** (`removedAt = now()`): the FK doesn't fire. See §5.4 for the explicit cleanup hook.
- **Schedule scheduledDate in the future**: skipped by the cron query (filter is `lte: today`). Counted in `planned` via §6.1.

### 5.4 Cleanup hook on tx soft-removal

When a transaction is soft-removed via `removeTransactionService` (`apps/api/src/transactions/remove.ts`) OR via Plaid's `markRemoved` (`apps/api/src/plaid/sync.ts:markRemoved`), the schedule's `matchedTxId` becomes stale — it points to a tx that is no longer counted in `spent`.

**Fix**: both code paths, inside the existing workspace lock callback, clear `matchedTxId` on any schedule referencing the removed tx:

```ts
// In removeTransactionService and markRemoved, after setting tx.removedAt:
await tx.scheduledSpend.updateMany({
  where: { matchedTxId: txId },
  data: { matchedTxId: null },
});
```

Effect: the schedule reverts to unresolved state. On the next cron run, the match scan re-evaluates and finds a NEW tx (if any) or leaves it unresolved.

**Alternative considered**: derive resolved state at read time as `matchedTxId != null AND matchedTx.removedAt IS NULL` (no cleanup hook needed). Rejected because:
1. Every list/budget/brief query would need to join `matchedTx` and check `removedAt`, increasing query cost.
2. The match cron would need to re-evaluate already-matched schedules to catch resurrections — currently it skips `matchedTxId: null` only.

The cleanup-hook approach keeps reads simple (status derivation is two boolean column checks) and lets the cron skip resolved schedules.

---

## 6. Budget aggregation changes

### 6.1 `compareSpendingVsBudgetService` extension

`apps/api/src/budgets/service.ts:compareSpendingVsBudgetService` adds a parallel aggregation over `scheduled_spends` and emits a new `planned` field per category.

**Definition of `planned` for a budget category in a given period**:
- Sum of `amount` from `scheduled_spends` where:
  - `workspaceId = ctx.workspaceId`
  - `categoryId = budget.categoryId`
  - `scheduledDate >= today` (in calling user's tz) — only future/today schedules count
  - `scheduledDate >= period.gte AND scheduledDate < period.lt` — within the period
  - `matchedTxId IS NULL` — not already realized
  - `dismissedAt IS NULL` — not dismissed
  - **Anti-join**: NOT EXISTS a tx in the same workspace+category on `scheduledDate` (`Transaction.occurredAt::date = scheduledDate AND tx.workspaceId = X AND tx.removedAt IS NULL AND ≥1 allocation has matching categoryId AND ≥1 allocation has amount > 0`).

The anti-join eliminates same-day double-counting: a schedule for today whose matching tx exists (auto-categorized by Plaid sync) is excluded from `planned` regardless of whether the match cron has run yet. The schedule's amount only contributes to `planned` when there's NO real tx covering it.

**Prisma sketch**:
```ts
const schedulesPlanned = await prisma.scheduledSpend.findMany({
  where: {
    workspaceId,
    categoryId: { in: budgetCategoryIds },
    scheduledDate: { gte: today, gte: periodGte, lt: periodLt },
    matchedTxId: null,
    dismissedAt: null,
    NOT: {
      // anti-join: exclude schedules whose date+category already has a covering tx
      // Prisma can't express NOT EXISTS directly, so we do an explicit anti-join:
      // for each schedule, check there's no tx matching its day+category.
    },
  },
  select: { categoryId: true, amount: true, scheduledDate: true },
});
// ...then in JS, do per-schedule anti-join check via a single tx.transactionAllocation.findMany
// scoped to the days+categories of the candidate schedules, building a Set<`${date}|${categoryId}`>.
// Schedules whose day+category appears in the set are filtered out.
// Then group remaining schedules by categoryId and sum.
```

The anti-join is best implemented as a 2-query approach: (1) load candidate schedules, (2) load matching tx allocations for the same day+category set, (3) filter in JS. For the small N expected (active budget categories × period days), this is acceptable. Future optimization could push this into raw SQL `NOT EXISTS`.

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
| `apps/api/src/intents/service.ts` | MODIFY | Add `addScheduledSpend`, `dismissScheduledSpend`, `removeScheduledSpend` to the `CONFIRMABLE_TOOLS` const tuple (~line 23). The consume dispatch in `consumeIntentService` (~line 98) already routes by tool name — no separate dispatch table to update. |
| `apps/api/src/audit/service.ts` | MODIFY | Add the same 3 tools to `AUDIT_WRITE_TOOLS` set + `TARGET_TYPE_MAP` (`addScheduledSpend` → `"scheduled_spend"`, dismiss/remove same) + extend `extractTargetId` switch to return `result.schedule.id` for the new actions. |
| `apps/api/src/chat/tools/present-confirm-card.ts` | MODIFY | If the file enumerates confirmable tools in the LLM-facing description text, add the new 3. Verify by reading the file's existing pattern. |
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
| `dismiss` matched schedule | **400 `already_matched`** (per §4.1 update) |
| `remove` happy | Hard delete, returns `{ removed: true }` |
| `remove` non-existent | Idempotent — returns `{ removed: false, alreadyRemoved: true }`, NOT 404 |

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
| **One-to-one: 2 schedules, 1 tx, same date+category** | Two schedules same day+category, single tx | First schedule (by createdAt asc) matches; second stays unresolved |
| **One-to-one: 2 schedules, 2 tx, same date+category** | Two schedules + two tx in same day+category | Each schedule consumes distinct tx (by occurredAt asc, id asc) |
| **Soft-removal cleanup: matchedTxId cleared on tx soft-remove** | Schedule resolved via match, then `removeTransactionService` soft-removes the matched tx | Schedule's `matchedTxId` reverts to null via §5.4 cleanup hook |
| **Soft-removal cleanup: cron re-matches on next run** | After cleanup hook fires, next cron run finds new tx (or none) | matchedTxId set to new tx OR stays null |
| **Plaid markRemoved cleanup** | Schedule matched to a Plaid tx; markRemoved soft-removes it | Same as above — cleanup hook in markRemoved clears matchedTxId |

### 8.3 Budget aggregation tests

Extend `apps/api/tests/budgets.service.test.ts`:

| Case | Setup | Assertion |
|---|---|---|
| `planned` for category with one upcoming schedule | Budget X, schedule for X 7d from now $100 | `planned === "100.00"` |
| `planned` excludes past unresolved | Schedule 7d ago, no match, no dismiss | `planned === "0.00"` for that category |
| `planned` excludes matched | Schedule with matchedTxId set | `planned === "0.00"` |
| `planned` excludes dismissed | Schedule with dismissedAt set | `planned === "0.00"` |
| `planned` sums multiple upcoming schedules | Two upcoming schedules in same category | `planned === sum` |
| **`planned` anti-join: today's schedule with covering tx** | Schedule for today $100 in cat X, real tx today in cat X for $80 (matchedTxId NOT yet set by cron) | `planned === "0.00"` (anti-join filters it out before cron runs) |
| **`planned` anti-join: today's schedule with NO covering tx** | Schedule for today $100 in cat X, no tx today in cat X | `planned === "100.00"` |
| `plannedPct` calculation | budget $200, planned $50 | `plannedPct === 25` |
| `remaining` includes planned | budget $200, spent $80, planned $50 | `remaining === "70.00"` |
| Period boundary | Schedule date = period.lt | Excluded (strict less-than) |
| Period boundary 2 | Schedule date = period.gte (today) | Included if no covering tx, excluded if covering tx exists |

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
- [ ] Auto-match enforces ONE-to-ONE via `usedTxIds.notIn` clause across the inner loop (§5.2)
- [ ] Auto-match schedule order: `scheduledDate asc, createdAt asc, id asc`
- [ ] Auto-match tx order: `occurredAt asc, id asc`
- [ ] Cron uses **workspace owner's tz** to compute "today"; concrete cron string `"5 9 * * *"` registered as a separate scheduler entry
- [ ] Match query uses `allocations: { some: { categoryId } }` predicate (split tx aware)
- [ ] Match query filters `removedAt IS NULL` on the tx
- [ ] Soft-removal cleanup hook in `removeTransactionService` AND `plaid/sync.ts:markRemoved` clears `matchedTxId` on schedules referencing the removed tx (§5.4)
- [ ] `compareSpendingVsBudget` adds `planned` field — sums schedules where (matchedTxId NULL AND dismissedAt NULL AND scheduledDate >= today AND within period AND **NOT EXISTS covering tx** via anti-join)
- [ ] `planned` anti-join prevents same-day double-count between spent and planned
- [ ] Past unresolved schedules NOT counted in `planned`
- [ ] Both `CompareSpendingOutput` (budget service) AND `compare-spending-vs-budget` chat tool Result type extended with `planned: string` + `plannedPct: number`
- [ ] `dismissScheduledSpend` rejects on already-matched (active matchedTxId) with 400 `already_matched`
- [ ] No PATCH endpoint (YAGNI)
- [ ] No HTTP audit log per route — but the 3 new write tools ARE added to `AUDIT_WRITE_TOOLS` set + `TARGET_TYPE_MAP` + `extractTargetId` switch so chat-tool audit coverage matches existing patterns
- [ ] Chat tools registered in `chat/tools/index.ts`
- [ ] Confirmation: 3 new write tools added to `CONFIRMABLE_TOOLS` const tuple in `intents/service.ts`
- [ ] HTTP routes registered in `server.ts`
- [ ] Strict Decimal equality on amount validation
- [ ] Date stored as Postgres `DATE` (no timezone), parsed strict YYYY-MM-DD; "today" comparisons use workspace owner's tz (cron) or calling user's tz (budget aggregation)
- [ ] Idempotent dismiss returns `alreadyDismissed: true`; idempotent remove returns `removed: false, alreadyRemoved: true` (NOT 404)
- [ ] `listUnresolvedSchedules` chat tool exists as a clean entry for the Phase 2 daily-brief plan
- [ ] `listScheduledSpends` `status` filter values: `"upcoming" | "unresolved" | "resolved-matched" | "resolved-dismissed" | "all"`
