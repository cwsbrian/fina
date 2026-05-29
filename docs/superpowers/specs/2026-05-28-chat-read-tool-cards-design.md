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
2. `accounts_list` — `{ type; title; total_balance?; currency?; rows: Array<{ id; name; mask?; balance?; institution?; status? }>; footer? }`.
3. `scheduled_list` — `{ type; title; period_label?; total_count; currency?; rows: Array<{ id; name; amount; scheduled_date; status: ScheduledSpendStatus; category?; dismiss_intent? }>; footer? }`. Shared by listScheduledSpends + listUnresolvedSchedules.
4. `recurring_candidates` — `{ type; title; currency?; footer?; rows: Array<{ merchant; amount; cadence: Cadence; occurrences; add_form_intent; defaults:{ name; amount?; cadence?; next_occurrence_date? } }> }`.
5. `transaction_detail` — `{ type; id; merchant; amount; currency?; date_label; account?; category?; note?; pending?; allocations?: Array<{ category; amount }> }`.
6. `category_list` — `{ type; title; rows: Array<{ id; name; color?; icon? }>; footer? }`.

All amounts are decimal strings without currency symbols; dates are
`YYYY-MM-DD`; the renderer formats currency. **No new error codes, no
new API endpoints.**

## Architecture

Unchanged pipeline: a tool returns `{ ...data, block }`; `turn.ts`
attaches the block to the assistant message; mobile
`PresentationBlock.tsx` renders it exhaustively (never-cast guard
stays). Interactive cards embed a server-pre-created intent id and the
client consumes it via the existing `POST
/workspaces/:wsId/intents/:id/consume` route.

### Intent pre-creation (interactive cards)

- `detectRecurringMerchants`: for each candidate (≤10), create an
  addRecurring **form** intent via `createIntentService` with
  `skipStrictValidate: true` and prefilled args (reuse the helper used
  by `present-recurring-form.ts`). Embed the id as `add_form_intent`
  and the inferred values as `defaults`.
- `listUnresolvedSchedules`: for each schedule, create a
  `dismissScheduledSpend` intent and embed it as `dismiss_intent`.

Both tools become reads-with-intent-side-effects; intents expire after
the existing 1-hour TTL. This is acceptable and consistent with how
`presentRecurringForm` already works.

## Backend changes

| Tool | Change |
|---|---|
| `get-budget.ts` / `budgets/service.ts` | compute period spend per category (reuse `compareSpendingVsBudget` aggregation), derive `bar_pct` + `over`, return `budget_list` |
| `list-accounts.ts` | build `accounts_list` from existing rows; sum `total_balance` |
| `list-scheduled-spends.ts` | return `scheduled_list` (no dismiss_intent) |
| `list-unresolved-schedules.ts` | pre-create dismiss intents; return `scheduled_list` with `dismiss_intent` |
| `detect-recurring-merchants.ts` | pre-create form intents; return `recurring_candidates` |
| `get-transaction-details.ts` | return `transaction_detail` (account, category, note, allocations) |
| `list-categories.ts` | add `color`/`icon` to prisma select; return `category_list` |
| `chat/turn.ts` | system-prompt note: these tools render cards — write a one-line intro, do not re-list the data as text (same guidance as existing recap/list tools) |

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
  `add_form_intent`; consuming with overrides runs `addRecurring`.
- `getTransactionDetails` → `transaction_detail` including allocations.
- `listCategories` → `category_list` with color/icon.

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
