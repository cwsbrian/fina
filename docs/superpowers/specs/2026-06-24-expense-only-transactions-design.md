# Expense-Only Transactions Design

## Context

Fina's core job is to help a user stay under a monthly expense budget. Bank feeds contain negative or non-spending activity that should not count against that budget, especially credit card payments, transfers between the user's own accounts, and investment transfers.

A bank-side credit card payment usually reflects paying off earlier card spending, not new spending in the payment month. The product should make those payment and transfer records easy to audit without treating them as budget spending by default.

## Product Rule

The app is expense-first. Default budget surfaces show only transactions that affect the expense budget.

Transactions can be either:

- `expense`: included in the monthly budget and normal transaction lists.
- `excluded`: kept for audit and correction, but hidden from normal expense views and excluded from budget totals.

The UI should not introduce another primary financial mode. Users only need to know whether a transaction affects the budget.

## Recommended Approach

Add a transaction-level budget impact flag:

```ts
budgetImpact: "expense" | "excluded"
budgetImpactSource: "auto" | "user"
```

This is simpler than controlling budget inclusion through categories because one category can contain both true spending and non-budget movement depending on the bank feed. It is also safer than permanently hiding non-budget transactions, because the user needs one place to inspect and restore incorrectly excluded rows.

Migration behavior:

- Add the fields with a safe default of `budgetImpact = "expense"` and `budgetImpactSource = "auto"`.
- Run the same classifier against existing Plaid-backed transactions after the migration.
- Leave uncertain existing rows as `expense`; the excluded screen and transaction detail can correct them manually.

## Initial Classification

New synced transactions should default to:

- `expense` when the transaction is an outgoing purchase-like amount.
- `excluded` when the transaction is a credit card payment, own-account transfer, investment movement, or other non-budget activity.

The initial auto rules should be conservative:

- Clear depository-side credit card payments become `excluded` by default because payment date usually does not equal expense month.
- Investment transfers become `excluded`.
- Internal account-to-account movement becomes `excluded` when both sides can be identified by connected accounts, amount, nearby date, or bank-specific `TFR-TO` / `TFR-FR` style names.
- Outgoing E-Transfers stay `expense` by default. They are too ambiguous to auto-exclude from Plaid category alone.
- ATM withdrawals, mortgage payments, loan payments, BNPL, and bank fees stay `expense`.
- Unknown outgoing activity stays `expense` so real spending is less likely to disappear.

Manual user changes always win over future auto classification. Plaid sync may recompute `budgetImpact` only while `budgetImpactSource = "auto"`. Pending-to-posted promotion, modified transactions, reconnect dedupe, and replay updates must preserve `user` overrides.

Internal transfer matching can run after sync as a reconciliation pass. Until a match is found, unknown outgoing activity remains `expense`.

## User Experience

Normal app views show budget expenses only:

- Home totals and recent activity.
- Activity tab.
- Budget and analysis aggregates.

The app adds a separate `Excluded transactions` screen. It lists excluded records and allows the user to add a transaction back to the budget.

Normal transaction rows and transaction detail expose `Exclude from budget` for expense rows. Excluded rows expose `Add to budget`.

Entry points:

- Activity tab: add a slim list utility row near the scheduled/upcoming row.
- More tab: add an `Excluded transactions` item near other planning tools.

Copy should stay expense-focused:

- Screen title: `Excluded transactions`
- Subtitle: `Card payments, transfers, and other non-budget activity`
- Empty state: `Nothing excluded`
- Restore action: `Add to budget`
- Expense action: `Exclude from budget`

## Data Flow

1. Plaid sync stores every transaction for audit.
2. The sync/categorization layer assigns `budgetImpact` unless the user already overrode it.
3. Transaction list and budget aggregate APIs filter to `budgetImpact = "expense"` by default.
4. The excluded screen requests `budgetImpact = "excluded"`.
5. Toggling a transaction updates `budgetImpact` and sets `budgetImpactSource = "user"`.

The implementation should use one shared budget-visible predicate for every spending calculation, not just the transaction list. Required call sites include:

- Transaction list APIs.
- Budget plan totals and category summaries.
- Analysis totals and charts.
- Goal and forecast spending calculations.
- Chat spending summaries.

The transaction update endpoint accepts `budgetImpact` and returns it in the transaction DTO.

## Production Categorization Note

The local production-key test showed a categorization failure unrelated to Plaid sync: DeepSeek rejected JSON mode because the categorize prompt did not include the word `json`. A later production fix should make categorization resumable for existing uncategorized transactions, but the expense/excluded model should not depend on that fix.

## Local Validation

After implementation, validate locally with the production Plaid keys already configured:

- Connect checking and, when available, credit card accounts.
- Confirm checking-side credit card payments land in `Excluded transactions` even if the card account is not connected.
- Confirm actual credit card purchases remain budget expenses when card accounts are connected.
- Confirm manual `Add to budget` and `Exclude from budget` survive refresh and later sync.
- Confirm Home and Activity do not show excluded records in their default views.

## Out Of Scope

- Building a full ledger view for every bank movement.
- Making category-level budget inclusion rules.
- Allocating unconnected card payments back to the original purchase month.
- Reworking the unrelated uncategorized production backfill script.
