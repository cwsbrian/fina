# User Plaid Reconciliation Design

## Goal

Keep Plaid production billing aligned with each user's subscription tier. Plaid connections must be reconciled by the user who created the connection, not by workspace, because the subscription and cost responsibility belong to the user.

## Policy

- Plaid limits are user-scoped through `PlaidItem.connectedBy`.
- Pro users keep their first 5 non-disconnected Plaid Items.
- Lite users keep their first 1 non-disconnected Plaid Item.
- Free, canceled, unpaid, or otherwise inactive users keep 0 Plaid Items.
- The items kept are selected by `createdAt ASC`, so the earliest registered connections survive downgrades.
- `active`, `error`, and `relink_required` count against the limit because they can still represent active Plaid-side Items.
- `disconnected` does not count.
- If `connectedBy` is null, the item has no cost owner and should be disconnected by reconciliation.

## Architecture

Add a single service function:

```ts
reconcilePlaidItemsForUser(env, userId)
```

The function calculates `effectiveTier(userId)`, maps that to the user's Plaid Item limit, loads the user's non-disconnected Plaid Items ordered by creation time, and calls `removeItemForBilling` for every item beyond the limit.

Daily cron also handles orphaned Plaid Items with `connectedBy = null` through a separate orphan pass. Orphaned Items have no billable owner, so every non-disconnected orphan should be removed with `removeItemForBilling`.

The same service should be used by:

- Stripe subscription sync after creating/updating/deleting a subscription row.
- IAP subscription sync after creating/updating/canceling a subscription row.
- Daily refresh cron as a safety reconciliation pass.

## Data Flow

1. User subscription changes through Stripe or IAP.
2. The subscription row is synced.
3. Reconciliation runs for that user.
4. Excess Plaid Items are removed from Plaid via `/item/remove`.
5. Local `plaid_items.status` becomes `disconnected`.
6. Historical accounts and transactions remain available for reporting.

Daily cron repeats this process for every user with active Plaid Items, then runs the orphan pass for null-owner rows.

## API And UI

`POST /workspaces/:id/plaid/link-token` should enforce the user's total active Plaid Item count, not the workspace count.

Banks UI can still show all workspace connections that the viewer is allowed to see, but it should distinguish ownership when possible:

- Connected by current user
- Connected by another workspace member
- Disconnected historical connection

This avoids confusing workspace visibility with billing responsibility.

## Sync Rules

Manual and background Plaid sync should be allowed for users with `plaidItemLimit > 0`, not only for Pro users. This lets Lite users keep and sync their one allowed connection.

Disconnected Items must not be synced.

## Duplicate Transaction Handling

Existing transaction sync already dedupes by `(workspaceId, plaidTransactionId)` and updates existing rows when the same Plaid transaction is replayed. This should remain the primary dedupe path.

Add tests for reconnect scenarios where an item was disconnected for billing and later reconnected. If Plaid emits different transaction IDs after reconnect, add a conservative secondary dedupe strategy based on account, date, amount, and merchant. Do not merge transactions unless the match is strong enough to avoid hiding legitimate duplicate charges.

## Error Handling

- `removeItemForBilling` failures should be logged and retried by the next daily cron.
- `ITEM_NOT_FOUND` from Plaid should still mark the local item as `disconnected`.
- Reconciliation should continue processing other items when one item fails.
- Stripe and IAP webhook handlers should not fail the entire webhook solely because one Plaid removal fails; they should log the reconciliation failure and rely on daily retry.

## Testing

Add tests for:

- Lite limit is 1.
- Pro keeps first 5 items by `createdAt`.
- Lite keeps first item by `createdAt`.
- Free/canceled user disconnects all user-owned items.
- Items owned by another workspace member are not counted against the current user.
- `connectedBy = null` items are disconnected by daily reconciliation.
- Link-token creation uses user-wide count.
- Lite users can sync their one active item.
- Stripe sync triggers reconciliation.
- IAP sync triggers reconciliation.
- Transaction replay does not create duplicates.

## Acceptance Criteria

- A Pro to Lite downgrade leaves only the user's earliest active Plaid Item connected.
- A Lite to Free or canceled transition disconnects all Plaid Items owned by that user.
- Other workspace members' Plaid Items are not affected by a user's downgrade.
- Daily cron corrects drift if webhook reconciliation failed.
- Historical account and transaction data remain visible where appropriate.
