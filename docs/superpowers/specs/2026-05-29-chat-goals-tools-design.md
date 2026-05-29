# Chat goals tools — design

**Date:** 2026-05-29
**Status:** Approved for planning

## Goal

Give the chat assistant goals capabilities, matching how it already handles
budgets/recurring/transactions. Goals are a first-class app feature (Goals tab,
`/workspaces/:id/goals` REST API, `goals/savings.ts`, `goals/generate-strategy.ts`,
the `goal-milestones` push cron) but the chat assistant currently has **zero**
goals tools. Add read + core-write tools so users can view goals, see a goal's
detail/savings plan, create, edit, and archive goals from chat.

Key domain fact: a goal's **`savedAmount` is computed** (`computeGoalSavings` —
derived from staying under budget in the goal's allocated categories), NOT a
manual deposit. The GET DTO returns the computed value and ignores the stored
column. So there is **no manual "I saved $X" tool**; savings accrue automatically.
The LLM savings **strategy generation** (`generateAndStoreGoalStrategy`) stays out
of chat — it's a heavy server-side LLM call; chat cards tap through to `/goals/:id`
to generate/edit a strategy on the screen.

## Tools (5)

| Tool | Kind | UI |
|---|---|---|
| `listGoals` | read | `goals_list` card — title, saved/target, % bar, D-day |
| `getGoalDetails` | read | `goal_detail` card — progress + due/pace + per-category savings plan (allocations + rationale) |
| `presentGoalForm` | presenter | `goal_form_card` — title / target / due-date inputs (mirrors `presentRecurringForm`) |
| `addGoal` | write (confirmable) | form submit → create goal → "Added goal …" |
| `updateGoal` | write (confirmable) | edit title / targetAmount / dueDate (PATCH); gated by `presentConfirmCard` |
| `archiveGoal` | write (confirmable) | archive (PATCH `archived:true`); gated by `presentConfirmCard` |

**Tier gating (important):** goal **writes** are Pro-only — `routes/goals.ts`
gates POST/PATCH behind `effectiveTier(...).tier === "pro"` → `402 upgrade_required`.
So `addGoal`/`updateGoal`/`archiveGoal` must enforce the same gate (the goals
service checks `effectiveTier(ctx.userId)` and throws `upgrade_required` for
non-Pro). To avoid a fill-then-fail UX, `presentGoalForm` also checks tier
up-front and, for a non-Pro user, returns a short "goals are a Pro feature"
text instead of a form. Reads (`listGoals`/`getGoalDetails`) are open to all
tiers (GET goals is not tier-gated) — a downgraded user can still view goals.

Flows (same as budget/recurring):
- "내 목표 보여줘" → listGoals → goals_list
- "일본여행 목표 자세히" → getGoalDetails → goal_detail
- "여행자금 200만원 목표 만들어줘" → presentGoalForm → goal_form_card → submit → addGoal
- "그 목표 300만원으로 늘려줘" → presentConfirmCard → updateGoal
- "그 목표 보관해줘" → presentConfirmCard → archiveGoal
- strategy 생성 → goal_detail/goals_list 카드 탭 → `/goals/:id` 화면

## Shared library touchpoints

### Existing `@fina/shared` exports this spec USES
- `CreateGoalBody`, `PatchGoalBody` (`schemas/goals.ts`) — request validation for addGoal/updateGoal (the chat tools' arg schemas import/mirror these so the same min-due-date + max-amount rules apply).
- Goal DTO (`dto/goals.ts`) — the goal wire shape (incl. computed `savedAmount` + `allocations`).
- `PresentationBlock`, category-chip shape, `Cadence`-style conventions.
- `createIntentService` / `consumeIntentService` (intents) — the form + confirm flow (addGoal/updateGoal/archiveGoal are confirmable).

### Shared additions this spec CREATES
`libs/shared/src/dto/chat.ts` — three new `PresentationBlock` members:
1. `goals_list` — `{ type; title; currency?; rows: Array<{ id; title; saved; target; bar_pct; over?; due_label; icon?; color? }>; footer? }`
2. `goal_detail` — `{ type; id; title; saved; target; bar_pct; currency?; due_label; days_left?; note?; allocations?: Array<{ category:{name;color?;icon?}; monthly: string; rationale?: string } >; strategy_note?: string }`. **`note`** = a tool-templated constant explaining savings accrue automatically from staying under budget in the listed categories (NOT from data). **`strategy_note`** = `Goal.strategy?.notice` only (that field is set only when the LLM strategy generation failed; usually absent) — do not expect a positive plan sentence here.
3. `goal_form_card` — `{ type; question; intent_id; defaults: { title?; target_amount?: string; due_date?: string }; currency?; mode?: "add" | "update" }`. `target_amount` is a decimal **string** for display; the stored intent arg is the **number** `parseFloat(target_amount)` (mirror `present-recurring-form.ts` which stores `parseFloat(amount)` while the block default is a string). `due_date` default must be `≥ minDueDateOneMonthUTC()` — see Error handling.

Amounts are decimal strings; dates `YYYY-MM-DD`. **New error code `goal_not_found`** added to `API_ERROR_CODES` (it is NOT present today; the existing route returns the generic `not_found` and KEEPS doing so — chat tools throw `goal_not_found`, so the route's HTTP code is unchanged and its tests still pass). `upgrade_required` already exists in `API_ERROR_CODES` (reused for the Pro gate). No new REST endpoints (chat tools call the goals service directly).

## Architecture

### Extract a goals service (DRY)
Goal create/patch/archive logic currently lives **inline in `routes/goals.ts`**.
Extract `apps/api/src/goals/service.ts`:
- `listGoalsWithSavings(workspaceId)` → goals (`archivedAt: null`) each with computed `savedAmount` (reuse `computeGoalSavings`). **Perf note:** `computeGoalSavings` is called once per goal and each call re-reads all workspace allocations + the default plan + a `budgetPlan.findUnique` per month — i.e. ~`G×(3+M)` queries. This matches the existing REST route (no worse than today); a batched version (load shared reads once) is a possible later optimization, NOT required here. Acknowledge, don't pretend it's free.
- `getGoalWithSavings(workspaceId, goalId)` → one goal + allocations + computed saved, or null.
- `createGoalService(workspaceId, userId, input)` and `patchGoalService(workspaceId, userId, goalId, input)` → **enforce the Pro-tier gate** (`effectiveTier(userId)` → throw `upgrade_required` if not Pro), then create / PATCH (incl. `archived → archivedAt`). The current POST does **NOT** use `withWorkspaceLock`, so the extracted service does NOT add it — keeping the extraction behavior-preserving. (Goal writes aren't currency-sensitive like budget/tx writes, so the lock isn't needed.)
Repoint `routes/goals.ts` to the service (behavior-preserving; covered by existing goals route tests — they still see `not_found`/`upgrade_required` HTTP codes). Chat tools call the same service — no logic duplication. The fire-and-forget `generateAndStoreGoalStrategy` on create stays in the route layer (chat create does not auto-generate a strategy).

### Tools
- `listGoals` → `listGoalsWithSavings` → `goals_list` block (empty → no block, LLM says "no goals yet").
- `getGoalDetails` → args `{ goal_id?: string; title?: string }` (exactly one). **Title resolution is a NEW helper** (findTransactions resolves by merchant substring + count, not title — do not assume it's reusable): case-insensitive match on `Goal.title` within the workspace, `archivedAt: null`; 0 matches → throw `goal_not_found`; exactly 1 → `goal_detail`; >1 → return `{ ambiguous: true }` so the LLM calls `listGoals` to show the picker (never ask "which one?"). → `goal_detail` block with allocations + the static `note` (savings-accrue explainer) + `strategy_note` from `strategy?.notice`.
- `presentGoalForm` → args `{ title?; target_amount?; due_date?; goal_id? }` (goal_id present = edit/update mode). Checks Pro tier first (non-Pro → short "Pro feature" text, no form). Creates an `addGoal` (mode "add") or `updateGoal` (mode "update", carrying `goal_id`) form intent (`skipStrictValidate`) prefilled from the user message / existing goal; **due_date default = the inferred date clamped to `≥ minDueDateOneMonthUTC()`, else `minDueDateOneMonthUTC()`**; stores `targetAmount` as a number (`parseFloat`). → `goal_form_card`.
- `addGoal` / `updateGoal` / `archiveGoal` → confirmable writers calling the service. `addGoal` args mirror `CreateGoalBody` (incl. the `DueDateMinOneMonth` refine — re-validated at consume). `updateGoal`/`archiveGoal` args carry `{ goal_id: string, ... }` (the LLM passes the id from a prior `goals_list`/`goal_detail` block, or resolves via the title helper). Register all three in `CONFIRMABLE_TOOLS` (`intents/service.ts`) + `AUDIT_WRITE_TOOLS` + **`TARGET_TYPE_MAP` (`goal`) + an `extractTargetId` branch** (`r.goal?.id`) in `audit/service.ts` + a `confirmationFor` case each. Server-templated confirmation messages.

### Mobile
- `GoalsListBlock`, `GoalDetailBlock`, `GoalFormBlock` in `apps/mobile/src/chat/blocks/`, reusing `_primitives` (BlockCard/Header/Footer/Empty, CategoryIcon, currencySymbol, withAlpha) + progress-bar pattern.
- `goals_list` / `goal_detail` cards tappable → `router.push("/goals")` / `router.push("/goals/{id}")` with a chevron (consistent with budget/category cards).
- `GoalFormBlock` mirrors `RecurringFormBlock` (title/amount/date inputs + submit/cancel → `onSubmitForm`).
- Wire all three into `PresentationBlock.tsx` (exhaustive never-cast) + `isCardBlock`.

### Prompt (turn.ts)
Add keyword routing: "goal / 목표 / 저축 목표" → listGoals; "X 목표 자세히" → getGoalDetails; "목표 만들어/추가" → presentGoalForm; edit → presentConfirmCard→updateGoal; archive → presentConfirmCard→archiveGoal. Note savings are automatic (don't promise a manual deposit).

## Error handling
- Goal not found (by id, or title 0-match) → `goal_not_found`. Title >1 match → `{ ambiguous: true }` → LLM shows `listGoals` (never "which one?").
- **Non-Pro user on a write** (`addGoal`/`updateGoal`/`archiveGoal`, and `presentGoalForm`) → `upgrade_required`; chat replies with a short "goals are a Pro feature — upgrade to create/edit goals" (KR/EN). `presentGoalForm` short-circuits to this text instead of rendering a form.
- No goals → listGoals returns no block; LLM gives a short "set up a goal" reply.
- **dueDate < 1 month**: `CreateGoalBody`'s `DueDateMinOneMonth` refine rejects at consume (`invalid_body`). `presentGoalForm` MUST prefill `due_date ≥ minDueDateOneMonthUTC()` (clamp an inferred-too-soon date up to that floor; use the exported helper from `schemas/goals.ts`) so the happy-path submit never fails. The form's date picker also enforces the same floor.

## Testing
Integration tests (real DB) per tool:
- `listGoals` → goals_list with computed savings + D-day.
- `getGoalDetails` → goal_detail incl. allocations; by-title single match → detail, ambiguous → list.
- `addGoal` (via consume) → goal created with correct fields; min-due-date enforced (a too-soon date rejects with `invalid_body`); a Pro user succeeds.
- `getGoalDetails` by title: single match → detail; >1 → `{ ambiguous: true }`; 0 → `goal_not_found`; archived goals not matched.
- **Tier gate**: a non-Pro user calling `addGoal`/`updateGoal`/`archiveGoal` (or `presentGoalForm`) gets `upgrade_required`; a Pro user succeeds. (Use the test helpers' tier setup.)
- `updateGoal` → fields patched; `archiveGoal` → archived (excluded from listGoals).
- `goals/service` extraction: existing goals route tests still pass (behavior-preserving — same `not_found`/`upgrade_required` codes, no new lock).
Mobile: `pnpm exec nx typecheck mobile` clean (only pre-existing restore.tsx / iap/client.ts).

## Out of scope
- Strategy generation in chat (heavy LLM; via `/goals/:id` screen).
- Manual savedAmount edits (computed, not manual).
- GoalAllocation editing from chat (part of strategy, screen-only).
- Web renderer.
