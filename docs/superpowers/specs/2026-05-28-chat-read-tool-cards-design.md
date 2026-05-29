# Chat read-tool presentation cards — design

**Date:** 2026-05-28
**Status:** Approved for planning

## Goal

Give every chat read-tool that currently returns only plain text a
structured presentation card, matching the established pattern used by
`recap`, `transactions_list`, and `recurring_list`. Seven tools are
missing UI; this spec adds six new `PresentationBlock` types to cover
them (the two scheduled-spend list tools share one block).

Tools gaining a card:

| Tool | Block | Interaction |
|---|---|---|
| `getBudget` | `budget_list` | read-only + progress bar (spent/amount) |
| `listAccounts` | `accounts_list` | read-only (balance + connection badge) |
| `listScheduledSpends` | `scheduled_list` | read-only |
| `listUnresolvedSchedules` | `scheduled_list` | per-row `dismiss_intent` action |
| `detectRecurringMerchants` | `recurring_candidates` | per-row "Add" → prefilled form |
| `getTransactionDetails` | `transaction_detail` | read-only |
| `listCategories` | `category_list` | read-only (color chips) |

Write tools (`addRecurring`, `removeRecurring`, `removeAllRecurring`,
`add/dismiss/removeScheduledSpend`, `categorizeTransaction`,
`addTransactionNote`, `createCategory`, `setBudget`,
`mapMerchantToCategory`) already flow through `confirm_card` /
`recurring_form_card` + server-templated confirmation text and need no
new card.

## Shared library touchpoints

### Existing `@fina/shared` exports this spec USES

- `PresentationBlock` union (`libs/shared/src/dto/chat.ts`) — extended here.
- `Cadence` / `CADENCES`, `ScheduledSpendStatus` — row enums.
- Category chip shape (`{ name; color?; icon? }`) — mirrored from
  existing `transactions_list` / `recurring_list` rows.
- `createIntentService`, `consumeIntentService` (api `intents/service.ts`)
  — reused for the two interactive cards; no new endpoint.

### Shared additions this spec CREATES

Target file `libs/shared/src/dto/chat.ts`, added to the
`PresentationBlock` union:

1. `budget_list` — `{ type; title; period_label?; currency?; rows: Array<{ id; category:{name;color?;icon?}; amount; spent; bar_pct; over? }>; footer? }`. Motivation: getBudget card; consumed by mobile now, web later.
2. `accounts_list` — `{ type; title; total_balance?; currency?; rows: Array<{ id; name; balance?; institution?; status?: PlaidItemStatus | null }>; footer? }`. `status` reuses the existing `PlaidItemStatus` union (`active | error | relink_required | disconnected`, `null` for manual/CSV accounts with no Plaid item) — NOT a hand-rolled 3-value enum. No `mask` field (the Account row doesn't expose one). `total_balance` is emitted **only when all rows share one currency**; omitted otherwise (summing mixed currencies is wrong).
3. `scheduled_list` — `{ type; title; period_label?; total_count; currency?; rows: Array<{ id; name; amount; scheduled_date; status: ScheduledSpendStatus; category?; dismiss_intent? }>; footer? }`. Shared by listScheduledSpends + listUnresolvedSchedules. `name` = the schedule's `note` if present, else its category name (schedules have no dedicated name field). `listUnresolvedSchedules` rows hardcode `status: "unresolved"` (that tool omits a status field; all its rows are unresolved by definition).
4. `recurring_candidates` — `{ type; title; currency?; footer?; rows: Array<{ merchant; amount; cadence: Cadence; occurrences; add_form_intent; defaults:{ name; amount?; cadence?; next_occurrence_date? } }> }`. `merchant` comes from the candidate's `displayName` (latest raw merchant), not `merchantNormalized`. **Candidates whose detected cadence is `"irregular"` are excluded from the card** — `detectRecurringMerchants` emits `weekly|biweekly|monthly|irregular`, and only the first three map to `Cadence`; `irregular` can't seed a valid `addRecurring`. `defaults.next_occurrence_date` is **derived** server-side as `lastSeenAt + one cadence interval` (the tool has no native next-date); the user can still adjust it in the form.
5. `transaction_detail` — `{ type; id; merchant; amount; currency?; date_label; account?; category?; note?; pending?; allocations?: Array<{ category: {name;color?;icon?}; amount }> }`. Each allocation carries the full category chip (name/color/icon), not a bare id — the tool currently drops the per-allocation category relation and must surface it.
6. `category_list` — `{ type; title; rows: Array<{ id; name; color?; icon? }>; footer? }`.

All amounts are decimal strings without currency symbols; dates are
`YYYY-MM-DD`; the renderer formats currency. **No new error codes, no
new API endpoints.**

## Architecture

Unchanged pipeline: a tool returns `{ ...data, block }`;
`collectPresentationBlocks` in `turn.ts` walks the tool calls, pulls
`result.output.block`, and returns them in a `presentationBlocks` array
parallel to the assistant text (the block is NOT merged into the
assistant text message — implementers should follow
`collectPresentationBlocks`, not assume message-merging). Mobile
`PresentationBlock.tsx` renders each block exhaustively (never-cast
guard stays). Interactive cards embed a server-pre-created intent id and
the client consumes it via the existing `POST
/workspaces/:wsId/intents/:id/consume` route.

### Intent pre-creation (interactive cards)

- `detectRecurringMerchants`: for each non-irregular candidate (≤10),
  create an addRecurring **form** intent via `createIntentService` with
  `skipStrictValidate: true` (required fields like `next_occurrence_date`
  are filled at submit time) and prefilled args (reuse the helper used
  by `present-recurring-form.ts`). Embed the id as `add_form_intent` and
  the inferred values as `defaults`.
- `listUnresolvedSchedules`: for each schedule, create a
  `dismissScheduledSpend` intent **with full args** (`{ schedule_id }`
  is known, so NO `skipStrictValidate` — unlike the recurring form
  intent) and embed it as `dismiss_intent`.

Both `addRecurring` and `dismissScheduledSpend` are in
`CONFIRMABLE_TOOLS`, so `createIntentService` won't reject them.

**Tradeoff (bloat) — accepted, with a sweeper.** These two read tools
gain an intent-creation side-effect. Each call creates up to `limit`
intents (detect: default 10, hard cap 25) / one per unresolved
schedule. The daily brief does NOT call these tools (it imports only
`periods.ts`), so the brief is unaffected; the only source is the LLM
calling them in a chat turn, possibly more than once. There is **no
existing `ActionIntent` sweeper**, so expired/unconsumed rows would
accumulate forever. This spec adds a small cron sweep
(`prisma.actionIntent.deleteMany({ where: { consumedAt: null,
expiresAt: { lt: now } } })`) to bound the table. Lazy-on-tap creation
was considered but rejected: it needs a new client-facing create-intent
surface and a 2-round-trip submit, where the embedded-id pattern matches
the existing `confirm_card` / `recurring_form_card` flow exactly.

## Backend changes

| Tool | Change |
|---|---|
| `budgets/service.ts` | extract a `spentByCategory(ctx, period, categoryId?)` helper out of the spend aggregation currently inlined in `compareSpendingVsBudgetService` (it's tangled with planned/pace logic and has no category filter today). The helper takes the **period enum** (not a bare `periodStart` — the periodStart-only call path has no period end and can't compute spend). Both `compareSpendingVsBudget` and `getBudget` consume it. |
| `get-budget.ts` | add `color`/`icon` to the category select (currently `{id,name}` only); call `spentByCategory` for the same period; derive `bar_pct` (`spent/amount*100`) + `over` (`spent>amount`); return `budget_list` |
| `list-accounts.ts` | build `accounts_list` from existing rows; map the existing `plaidItemStatus` (5-value incl. `null`) straight into `status`; emit `total_balance` only if all rows share one currency |
| `list-scheduled-spends.ts` | return `scheduled_list` (no dismiss_intent) |
| `list-unresolved-schedules.ts` | pre-create dismiss intents (full args, no skipStrictValidate); return `scheduled_list` with `dismiss_intent` and hardcoded `status:"unresolved"` |
| `detect-recurring-merchants.ts` | drop `irregular` candidates; derive `next_occurrence_date = lastSeenAt + cadence interval`; pre-create addRecurring form intents (`skipStrictValidate`); return `recurring_candidates` using `displayName` for `merchant` |
| `get-transaction-details.ts` | surface the per-allocation category relation (name/color/icon — currently only `categoryId` is mapped out); return `transaction_detail` |
| `list-categories.ts` | add `color`/`icon` to prisma select; return `category_list` |
| `chat/turn.ts` | (a) the generic "Card / text split" rule already covers "don't enumerate when a block is returned", so NO new per-tool narration guidance is needed — confirm the six tools inherit it. (b) **Reconcile the getBudget vs compareSpendingVsBudget split**: the existing prompt (turn.ts ~136-138) says getBudget is only for the configured number and to use compareSpendingVsBudget for usage. Since `budget_list` now shows spend + progress, update that line so getBudget = "show my budgets / how am I doing", compareSpendingVsBudget = explicit period-to-period or pace narrative. |
| `cron/jobs/` | add an `ActionIntent` expiry sweep (deletes `consumedAt:null, expiresAt<now`) — no sweeper exists today |

## Mobile renderer changes

- New components in `apps/mobile/src/chat/blocks/`: `BudgetListBlock`,
  `AccountsListBlock`, `ScheduledListBlock`, `RecurringCandidatesBlock`,
  `TransactionDetailBlock`, `CategoryListBlock`. Reuse `_primitives.tsx`
  + design tokens; match `recurring_list` / `transactions_list` styling.
- `PresentationBlock.tsx`: six new branches; never-cast retained.
- Interactive wiring (reuses existing ThreadView callbacks):
  - `RecurringCandidatesBlock`: "Add" tap expands that row into the
    existing `RecurringFormBlock` bound to `add_form_intent` +
    `defaults`; submit goes through the existing `onSubmitForm`
    (`submitFormIntent`).
  - `ScheduledListBlock`: "Dismiss" tap on an unresolved row calls
    `onSubmitForm(dismiss_intent, {})`; row is removed via the existing
    `dismissedIntents` set, server posts the confirmation message.
  - `PresentationBlock` forwards `onSubmitForm` / dismiss handlers to
    both interactive blocks.

## Error handling

- Empty result sets render a friendly empty-state card (not blank, not
  the never-cast pill).
- Expired/consumed intents (>1h-old candidate or unresolved card) →
  consume returns `intent_gone`; the client surfaces a short inline
  message, same as the existing form/confirm path.
- Unknown future block types still hit the never-cast debug pill.

## Testing

Integration tests (`apps/api/tests/`, real DB) assert each tool returns
the expected `block` shape:

- `getBudget` → `budget_list` with correct `spent` and `bar_pct`,
  `over: true` when spent exceeds amount.
- `listAccounts` → `accounts_list`; disconnected Plaid item → `status`
  reflects it.
- `listScheduledSpends` → `scheduled_list`, no `dismiss_intent`.
- `listUnresolvedSchedules` → `scheduled_list` with a valid
  `dismiss_intent` per row; consuming it runs `dismissScheduledSpend`.
- `detectRecurringMerchants` → `recurring_candidates` with a valid
  `add_form_intent`; `irregular` candidates are excluded; each row has a
  derived `next_occurrence_date`; consuming with the user's date
  override runs `addRecurring` successfully.
- `getTransactionDetails` → `transaction_detail`; allocations carry
  category name/color/icon, not just an id.
- `listCategories` → `category_list` with color/icon.
- `spentByCategory` helper returns the same per-category totals that
  `compareSpendingVsBudget` produced before extraction (regression).
- `ActionIntent` sweep deletes expired unconsumed rows and leaves
  consumed/active ones untouched.

### Manual scenarios (after completion)

| # | Input | Expected |
|---|---|---|
| 1 | "내 예산 보여줘" | `budget_list` with progress bars; over-budget category flagged |
| 2 | "내 계좌들" | `accounts_list` with balances + connection badge |
| 3 | "예정된 지출" | read-only `scheduled_list` |
| 4 | "기한 지난 예정지출" | `scheduled_list` with Dismiss → confirmation + row disappears |
| 5 | "구독 같은 거 찾아줘" | `recurring_candidates` → Add → prefilled form → submit → "Added X" |
| 6 | "이 거래 자세히" | `transaction_detail` with account/category/allocations |
| 7 | "카테고리 목록" | `category_list` color chips |
| 8 | (regression) existing recap/tx/recurring/confirm/form cards | still render; no "Unsupported message type" |
| 9 | (edge) zero rows | friendly empty card, not blank |
| 10 | (edge) tap Add on a >1h-old candidate card | `intent_gone` handled gracefully |

## Out of scope

- Web renderer (shapes are shared; web cards are a later mirror).
- Account-card CTAs (Plaid reconnect) and transaction-detail edit
  actions — read-only for now.
- Confidence scoring UI on recurring candidates beyond `occurrences`.
