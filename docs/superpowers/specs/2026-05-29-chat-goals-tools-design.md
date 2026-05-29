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
2. `goal_detail` — `{ type; id; title; saved; target; bar_pct; currency?; due_label; days_left?; note?; allocations?: Array<{ category:{name;color?;icon?}; monthly: string; rationale?: string } >; strategy_note?: string }`
3. `goal_form_card` — `{ type; question; intent_id; defaults: { title?; target_amount?: string; due_date?: string }; currency?; mode?: "add" | "update" }`

Amounts are decimal strings; dates `YYYY-MM-DD`. New error code `goal_not_found` added to `API_ERROR_CODES` if not already present. No new REST endpoints (chat tools call the goals service directly).

## Architecture

### Extract a goals service (DRY)
Goal create/patch/archive logic currently lives **inline in `routes/goals.ts`**.
Extract `apps/api/src/goals/service.ts`:
- `listGoalsWithSavings(workspaceId)` → goals (not archived) each with computed `savedAmount` (reuse `computeGoalSavings`).
- `getGoalWithSavings(workspaceId, goalId)` → one goal + allocations + computed saved, or null.
- `createGoalService(workspaceId, input)` → create (validated via `CreateGoalBody`), through `withWorkspaceLock` (consistency with other writers).
- `patchGoalService(workspaceId, goalId, input)` → PATCH fields incl. `archived`.
Repoint `routes/goals.ts` to the service (behavior-preserving; covered by existing goals route tests). Chat tools call the same service — no logic duplication.

### Tools
- `listGoals` → `listGoalsWithSavings` → `goals_list` block (empty → no block, LLM says "no goals yet").
- `getGoalDetails` → resolve goal by id OR by title (case-insensitive, single-match like findTransactions; ambiguous → list) → `goal_detail` block with allocations + a `note` explaining savings accrue from under-budget behavior in the listed categories.
- `presentGoalForm` → create an `addGoal` (or `updateGoal`) form intent (`skipStrictValidate`) prefilled from the user's message / existing goal → `goal_form_card`.
- `addGoal` / `updateGoal` / `archiveGoal` → confirmable writers calling the service; server-templated confirmation messages (extend `confirmationFor` in `intents/service.ts` + register in `CONFIRMABLE_TOOLS` + `AUDIT_WRITE_TOOLS`).

### Mobile
- `GoalsListBlock`, `GoalDetailBlock`, `GoalFormBlock` in `apps/mobile/src/chat/blocks/`, reusing `_primitives` (BlockCard/Header/Footer/Empty, CategoryIcon, currencySymbol, withAlpha) + progress-bar pattern.
- `goals_list` / `goal_detail` cards tappable → `router.push("/goals")` / `router.push("/goals/{id}")` with a chevron (consistent with budget/category cards).
- `GoalFormBlock` mirrors `RecurringFormBlock` (title/amount/date inputs + submit/cancel → `onSubmitForm`).
- Wire all three into `PresentationBlock.tsx` (exhaustive never-cast) + `isCardBlock`.

### Prompt (turn.ts)
Add keyword routing: "goal / 목표 / 저축 목표" → listGoals; "X 목표 자세히" → getGoalDetails; "목표 만들어/추가" → presentGoalForm; edit → presentConfirmCard→updateGoal; archive → presentConfirmCard→archiveGoal. Note savings are automatic (don't promise a manual deposit).

## Error handling
- Goal not found (by id or title) → `goal_not_found`; for title with multiple matches, listGoals-style ambiguity (return the list, never "which one?").
- No goals → listGoals returns no block; LLM gives a short "set up a goal" reply.
- dueDate < 1 month (per `CreateGoalBody` rule) → validation error surfaced as `invalid_body`; the form should pre-fill a valid default and the LLM explains the min-1-month rule.

## Testing
Integration tests (real DB) per tool:
- `listGoals` → goals_list with computed savings + D-day.
- `getGoalDetails` → goal_detail incl. allocations; by-title single match → detail, ambiguous → list.
- `addGoal` (via consume) → goal created with correct fields; min-due-date enforced.
- `updateGoal` → fields patched; `archiveGoal` → archived (excluded from listGoals).
- `goals/service` extraction: existing goals route tests still pass (behavior-preserving).
Mobile: `pnpm exec nx typecheck mobile` clean (only pre-existing restore.tsx / iap/client.ts).

## Out of scope
- Strategy generation in chat (heavy LLM; via `/goals/:id` screen).
- Manual savedAmount edits (computed, not manual).
- GoalAllocation editing from chat (part of strategy, screen-only).
- Web renderer.
