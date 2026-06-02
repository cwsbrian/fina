# User Plaid Reconciliation Design

## Goal

Keep Plaid production billing aligned with each user's subscription tier. Plaid connections must be reconciled by the user who created the connection, not by workspace, because the subscription and cost responsibility belong to the user.

## Policy

- Plaid limits are user-scoped through `PlaidItem.connectedBy`.
- Pro users keep their first 5 non-disconnected Plaid Items.
- Lite users keep their first 1 non-disconnected Plaid Item.
- Free, canceled, unpaid, or otherwise inactive users keep 0 Plaid Items.
- Update the canonical shared source of truth to match this policy:
  `TIER_LIMITS.lite.plaidItems = 1`. All API checks, `/me` responses, pricing
  copy, and tests must derive from that value.
- The items kept are selected by `createdAt ASC`, so the earliest registered connections survive downgrades.
- `active`, `error`, and `relink_required` count against the limit because they can still represent active Plaid-side Items.
- `disconnected` does not count.
- If `connectedBy` is null, the item has no cost owner and should be disconnected by reconciliation.
- If `connectedBy` no longer has membership in the item's workspace, the item is
  invalid and should be disconnected for billing. Ownership is not transferred
  automatically. A remaining workspace member can reconnect the bank under
  their own user account if they want to keep it live.

Subscription status mapping:

| State | Plaid Item limit |
| --- | --- |
| Active product trial (`User.trialEndsAt > now`) | Pro limit, unless a paid tier with higher precedence is introduced later |
| `trialing` subscription | Subscription tier limit |
| `active` subscription | Subscription tier limit |
| `past_due` subscription | Subscription tier limit during payment retry grace |
| `canceled`, `unpaid`, `incomplete`, `incomplete_expired`, `paused` | 0 |
| No active trial and no active subscription | 0 |

## Architecture

Add a single service function:

```ts
reconcilePlaidItemsForUser(env, userId)
```

The function calculates `effectiveTier(userId)`, maps that to the user's Plaid Item limit, loads the user's non-disconnected Plaid Items ordered by creation time, and calls `removeItemForBilling` for every item beyond the limit.

Daily cron also handles orphaned Plaid Items with `connectedBy = null` through a separate orphan pass. Orphaned Items have no billable owner, so every non-disconnected orphan should be removed with `removeItemForBilling`.

The existing daily-refresh Step 0 workspace-owner trial cleanup must be removed
and replaced by this user-scoped reconciliation. No cleanup path should select
Plaid Items by workspace owner trial state, because shared workspaces can
contain Items connected by other users.

The same service should be used by:

- Stripe subscription sync after creating/updating/deleting a subscription row.
- IAP subscription sync after creating/updating/canceling a subscription row.
- Daily refresh cron as a safety reconciliation pass.

Every subscription mutation path must trigger reconciliation, including:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `/billing/sync`
- IAP checkout/restore sync
- Apple ASSN direct status updates such as family-sharing revocation
- Google RTDN direct status updates and linked purchase-token replacement

## Data Flow

1. User subscription changes through Stripe or IAP.
2. The subscription row is synced.
3. Reconciliation runs for that user.
4. Excess Plaid Items are removed from Plaid via `/item/remove`.
5. Local `plaid_items.status` becomes `disconnected`.
6. Historical accounts and transactions remain available for reporting.

Daily cron repeats this process for every user with active Plaid Items, then runs the orphan pass for null-owner rows.

Before daily Plaid reconciliation, cron runs a billing-state refresh for users
with non-disconnected Plaid Items:

- Stripe users with `stripeCustomerId`: list subscriptions with
  `stripe.subscriptions.list({ customer, status: "all" })` and run
  `syncSubscriptionFromStripe` for each returned subscription. The `status:
  "all"` filter is required so a missed cancellation webhook cannot leave a
  stale active local row.
- IAP users with active local rows: re-query Apple/Google status using the
  stored source subscription identifier or purchase token and update the local
  subscription row.
- Provider refresh failures are logged and retried on the next daily run. A
  transient provider failure must not disconnect a user's Plaid Items by itself.

This provider refresh is the daily safety net for missed subscription webhooks.

## API And UI

Every Plaid connection start and completion path should enforce the user's
total active Plaid Item count, not the workspace count. This includes:

- `POST /workspaces/:id/plaid/link-token`
- hosted-link completion paths
- `POST /workspaces/:id/plaid/exchange`

The completion path must recheck the limit even if link-token creation already
checked it, because a user can downgrade or connect another Item after receiving
a link token.

The user-wide count is:

```ts
where: {
  connectedBy: userId,
  status: { not: "disconnected" },
}
```

Connection completion must be serialized per user. Use a user-scoped database
lock or equivalent final-check transaction so concurrent exchanges across
different workspaces cannot exceed the user's Lite/Pro limit. The final check
and `PlaidItem` create must happen under the same user-scoped critical section.

Manual sync must replace the current Pro-only gate with an ownership-aware
Plaid access gate: the requester must own the Item through `connectedBy`, the
Item must not be `disconnected`, and `effectiveTier(userId).plaidItemLimit > 0`.
Background sync uses the same tier predicate for the Item owner.

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

Reconnect dedupe is intentionally conservative. Use the secondary path only when
the new Plaid account can be matched to exactly one historical disconnected
account in the same workspace by this account fingerprint:

- institution id
- account mask
- account type
- account subtype
- currency

If zero or multiple historical accounts match, skip secondary dedupe and rely
only on the primary Plaid transaction id.

For a uniquely matched account, a new Plaid transaction may update an existing
historical transaction only when all of these are true:

- same workspace
- same account fingerprint
- same occurrence date
- same absolute amount and sign
- same normalized merchant, using the existing merchant normalization pipeline
- existing row has `plaidTransactionId` from a disconnected historical Item
- existing row is not manually created

The update should attach the new `plaidItemId`, new account id, and new
`plaidTransactionId` to the existing row. If any field is ambiguous, insert a
new transaction instead; false negatives are safer than hiding legitimate
duplicate charges.

Secondary dedupe is limited to reconnect-after-billing-disconnect scenarios and
must be covered by tests before shipping.

## Membership Lifecycle

If a user leaves, is removed from, or loses membership in a workspace, every
non-disconnected Plaid Item in that workspace with `connectedBy` equal to that
user becomes invalid. Reconciliation disconnects those Items for billing and
preserves historical data. Remaining workspace members do not inherit billing
ownership automatically.

If the same user remains a workspace member but their role changes, ownership
stays with that user.

If the user is deleted and the FK sets `connectedBy` to null, the daily orphan
pass disconnects the Item.

## Historical Visibility

`removeItemForBilling` keeps historical data but should hide disconnected
accounts from normal active-account views. On billing disconnect:

- Plaid Item status becomes `disconnected`.
- Linked bank accounts should be marked `archivedAt = now` so `/accounts`
  excludes them by default.
- Transactions remain queryable for reports/history.
- Banks UI shows disconnected connections in a historical section when
  requested, not as active subscribed connections.
- Balances from disconnected accounts are stale and should not be displayed as
  current balances.

## Error Handling

- `removeItemForBilling` failures should be logged and retried by the next daily cron.
- `ITEM_NOT_FOUND` from Plaid should still mark the local item as `disconnected`.
- Reconciliation should continue processing other items when one item fails.
- Stripe and IAP webhook handlers should not fail the entire webhook solely because one Plaid removal fails; they should log the reconciliation failure and rely on daily retry.

## Testing

Add tests for:

- Lite limit is 1.
- `TIER_LIMITS.lite.plaidItems` is 1 and dependent pricing copy reflects it.
- Pro keeps first 5 items by `createdAt`.
- Lite keeps first item by `createdAt`.
- Free/canceled user disconnects all user-owned items.
- Items owned by another workspace member are not counted against the current user.
- `connectedBy = null` items are disconnected by daily reconciliation.
- Items whose `connectedBy` user no longer has workspace membership are disconnected.
- Link-token creation uses user-wide count.
- Exchange and hosted completion recheck the user-wide count.
- Concurrent exchanges for the same user cannot create more than the tier limit.
- Lite users can sync their one active item.
- Stripe sync triggers reconciliation.
- IAP sync triggers reconciliation.
- Direct IAP webhook status updates trigger reconciliation.
- Daily cron replaces workspace-owner trial cleanup with user-scoped reconciliation.
- Daily cron refreshes provider billing state before Plaid reconciliation.
- Transaction replay does not create duplicates.
- Reconnect secondary dedupe updates only strong account/transaction matches.
- Billing-disconnected bank accounts are hidden from active account views.

## Acceptance Criteria

- A Pro to Lite downgrade leaves only the user's earliest active Plaid Item connected.
- A Lite to Free or canceled transition disconnects all Plaid Items owned by that user.
- Other workspace members' Plaid Items are not affected by a user's downgrade.
- Daily cron corrects drift if webhook reconciliation failed.
- Historical transactions remain visible, while billing-disconnected accounts are not shown as active current-balance accounts.
