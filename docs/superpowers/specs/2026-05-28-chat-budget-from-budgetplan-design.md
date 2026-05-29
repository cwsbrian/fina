# Chat budget tools sourced from BudgetPlan — design

**Date:** 2026-05-28
**Status:** Approved for planning
**Branch:** continues `feat/chat-read-tool-cards`

## Problem

The chat `getBudget` and `compareSpendingVsBudget` tools read the **legacy
per-category `Budget` table** (`budgets`), but the app's real budget feature
— the Home "MAY SPENDING $8,264 of $9,000" card and the `/budget` screen —
is backed by **`BudgetPlan`** (`budget_plans`): a monthly total cap plus an
optional per-category split (`categoryAllocations`), surfaced by
`GET /workspaces/:id/budget-plans/current`.

Result: a user with a real $9,000 plan (with category caps on Dining,
Shopping, etc.) asks "show me my budget" in chat and gets "You don't have any
budgets set up yet" — because the legacy `Budget` table is empty. The
`budget_list` card shipped earlier in this branch faithfully renders
`getBudget`'s output, but the output is from the wrong source.

## Goal

Repoint both chat budget tools at `BudgetPlan` (the same source the Home/Budget
screens use), so chat reflects the user's actual budget. Make the chat
`budget_list` card tappable → navigate to the `/budget` screen for full detail.
This **supersedes** the committed Task 1a/1b (getBudget/budget_list,
`spentByCategoryForPeriod`) from this branch.

## Shared library touchpoints

### Existing `@fina/shared` exports this spec USES
- `PresentationBlock` `budget_list` / `recap` members.
- `Cadence`/category-chip shapes (unchanged).

### Shared additions this spec CREATES
- `libs/shared/src/dto/chat.ts` — add an **optional** `headline` to the
  `budget_list` block (backward-compatible):
  ```ts
  budget_list += headline?: {
    cap: string;        // total plan amount, decimal string
    spent: string;      // total spent this month
    left: string;       // cap - spent
    bar_pct: number;    // spent/cap*100 (clamped by renderer)
    scheduled?: string; // optional "+ scheduled this month" total
  }
  ```
  No other shared shape changes. No new error codes/endpoints.

## Architecture

### Single source — `budgetPlanSnapshot`
Add to `apps/api/src/budget-plans/service.ts`:
```ts
budgetPlanSnapshot(workspaceId, year, month) → {
  totalAmount: string;
  totalSpent: string;
  totalScheduled: string;
  categories: Array<{
    categoryId: string;
    categoryName: string;
    allocated: string | null;   // cap from plan.categoryAllocations, null = "no cap set"
    spent: string;
    scheduled: string;
  }>;
}
```
Built by merging `getOrSnapshotMonthBudget` (plan: total + `categoryAllocations`),
`monthlySpendByCategory`, `monthlyTotalSpend`, `monthlyScheduledByCategory`,
`monthlyScheduledTotal` — all already in `budget-plans/service.ts` and already
used by the `/budget-plans/current` route. The `categories` array is the union
of categories that have an allocation (cap) and/or spend this month.

Both chat tools consume this helper. Period mapping: the chat `period` enum
(`this_month` / `last_month` / `next_month`) maps to a calendar year/month
using the **same UTC `currentYM` basis** as `budget-plans/current` (so chat and
Home agree). `this_month` = current UTC year/month; `last_month`/`next_month` =
±1 month.

### getBudget → budget_list (+ headline, tappable)
- LLM-facing return becomes a BudgetPlan summary (total, spent, per-category
  cap/spent) instead of legacy `Budget` rows.
- Block `budget_list`:
  - `headline`: `{ cap, spent, left: cap-spent, bar_pct: spent/cap*100, scheduled: totalScheduled }`.
  - `rows`: **capped categories only** (those with a non-null `allocated`),
    sorted over-budget/closest-to-limit first, truncated to a small N (e.g. 5);
    each row `{ id: categoryId, category:{name,color,icon}, amount: allocated,
    spent, bar_pct, over: spent>allocated }`.
  - `footer`: when rows are truncated or uncapped-with-spend categories exist,
    e.g. "Top 5 of 8 · tap for full budget".
  - Emitted whenever a plan exists (totalAmount > 0). If no plan at all, return
    no block and let the LLM say there's no budget yet.
- `category_name`/`category_id` arg: filter rows to that category's allocation
  if provided (headline still totals).
- Currency: workspace currency.

### compareSpendingVsBudget → recap (from BudgetPlan)
- Keep the existing `recap` card; change only the source to `budgetPlanSnapshot`.
- Headline: total cap vs total spent, with a pace delta (`todayPct` = day-of-
  month / days-in-month; status on-pace/over-pace as today).
- Rows: capped categories — `spent` vs `allocated`, with `scheduled` as the
  projection (replaces the old bespoke planned-schedule anti-join) and pace.
- **Removed:** the bespoke planned-schedule anti-join in
  `compareSpendingVsBudgetService`; the `spentByCategoryForPeriod` helper +
  its test (added in Task 1a) — now unused.
- For a total-only plan (no `categoryAllocations`): rows empty, headline only.

### Mobile — BudgetListBlock
- Render the optional `headline` (large spent number, "of {cap}", "{left} left",
  percent, progress bar) above the existing category rows — visually mirroring
  Home's SpendCard.
- Wrap the whole card in a `Pressable` → `router.push("/budget")` (identical to
  `apps/mobile/src/home/SpendCard.tsx`). Add a subtle chevron/affordance.
- Existing `recap` renderer already handles compareSpendingVsBudget's card — no
  change there beyond data.

## Error handling
- No plan / zero total → getBudget returns no block; LLM gives a short "set up a
  budget" reply.
- Period with no snapshot → `getOrSnapshotMonthBudget` snapshots from default;
  if no default either, treated as no plan.
- Navigation is best-effort (router.push); no data dependency.

## Testing
Integration tests (real DB):
- `budgetPlanSnapshot`: with category split (caps + spend + scheduled merged
  correctly), and total-only (empty categories, totals correct).
- `getBudget`: plan with caps → `budget_list` with headline (cap/spent/left/
  bar) and capped-category rows (over flag correct); total-only → headline only;
  no plan → no block.
- `compareSpendingVsBudget`: recap headline totals + pace; capped-category rows;
  total-only → headline only; regression vs prior per-category behavior is
  intentionally replaced (update existing test).
- Confirm `spentByCategoryForPeriod` + its test are removed and nothing else
  imports it.

Mobile: `pnpm exec nx typecheck mobile` clean (only pre-existing restore.tsx /
iap/client.ts errors). Manual: "show me my budget" → headline card matching
Home, tap → `/budget`.

## Out of scope
- Goals-reserved amount in the chat headline (Budget screen shows it; chat
  keeps to cap/spent/left/scheduled).
- Uncapped-with-spend category rows in chat (summarized in footer; full list on
  the `/budget` screen).
- Web renderer; `setBudget` and the legacy `Budget` table (left as-is for any
  non-chat consumers).
