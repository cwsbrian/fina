---
phase: user-plaid-reconciliation-plan
reviewed: 2026-06-02T05:07:44Z
depth: deep
files_reviewed: 7
files_reviewed_list:
  - docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md
  - docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md
  - apps/api/src/plaid/items.ts
  - apps/api/src/plaid/sync.ts
  - apps/api/src/routes/billing-iap.ts
  - apps/api/src/routes/billing-iap-webhook.ts
  - libs/shared/src/dto/plaid.ts
findings:
  critical: 4
  warning: 3
  info: 0
  total: 7
status: issues_found
---

# Phase user-plaid-reconciliation-plan: Code Review Report

**Reviewed:** 2026-06-02T05:07:44Z
**Depth:** deep
**Files Reviewed:** 7
**Status:** issues_found

## Summary

The plan is not production-ready. It covers the broad shape of the approved spec, but several steps are not executable as written or conflict with live code contracts. The main risks are missed IAP billing drift, untracked Plaid-side billable Items after failed cleanup, and race conditions between billing disconnect and transaction sync.

## Critical Issues

### CR-01: BLOCKER - Daily Refresh Explicitly Omits Required IAP Provider Refresh

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:915`

**Issue:** The approved spec requires daily cron to re-query Apple/Google status for IAP users before Plaid reconciliation (`docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:89`). The plan instead says "Do not add new IAP provider polling in this task" and only logs a skipped IAP refresh. That leaves missed Apple/Google cancellation or revocation events undetected, so inactive IAP users can keep billable Plaid Items indefinitely.

**Fix:** Add an IAP branch to `refreshBillingStateForUser` that finds active `iap_apple`/`iap_google` rows by `Subscription.source` and `sourceSubscriptionId` (`apps/api/prisma/schema.prisma:683`), re-queries the appropriate provider client, calls `syncSubscriptionFromIAP`, and only then reconciles. Add daily-refresh tests proving Apple and Google rows are refreshed before reconciliation and provider failures are logged without writing a synthetic canceled state.

### CR-02: BLOCKER - IAP Checkout/Restore Reconciliation Is Referenced But Omitted From Task Scope, Tests, And Commit

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:761`

**Issue:** The spec requires "IAP checkout/restore sync" to trigger reconciliation (`docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:66`). The live checkout/restore paths are in `apps/api/src/routes/billing-iap.ts:55` and `apps/api/src/routes/billing-iap.ts:105`, but Task 5's files list, tests list, and final `git add` omit both `apps/api/src/routes/billing-iap.ts` and `apps/api/tests/iap/billing-iap.routes.test.ts`. Step 5 mentions `billing-iap.ts` later, but a worker following the scoped file list/commit command can leave the checkout/restore implementation uncommitted and untested.

**Fix:** Add `apps/api/src/routes/billing-iap.ts` and `apps/api/tests/iap/billing-iap.routes.test.ts` to Task 5's Files/Test lists and the commit command. Require assertions that both `/billing/iap/checkout` and `/billing/iap/restore` call `reconcilePlaidItemsForUser(app.fina.env, userId)` after successful sync.

### CR-03: BLOCKER - Billing Disconnect Plan Drops The Plaid Row Lock Required By Sync

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:323`

**Issue:** The plan updates `removeItemForBilling` with a plain transaction that archives accounts and marks the Item disconnected, but it does not acquire `lockPlaidItem`. Live `syncTransactions` relies on the same row lock for page commits and final `status = "active"` writes (`apps/api/src/plaid/sync.ts:127`, `apps/api/src/plaid/sync.ts:153`). The current `removeItemForBilling` comment says no lock is acceptable only because it runs from daily-refresh Step 0 before sync (`apps/api/src/plaid/items.ts:143`); this plan moves billing disconnect into Stripe/IAP webhooks and `/billing/sync`, where sync can be in flight. A sync finalizer can race after billing disconnect and set the remotely removed Item back to `active`, leaving local billing state wrong and accounts archived under an active Item.

**Fix:** Change `removeItemForBilling` to use the same row-level lock contract as `removeItemStrict`: run the local archive/status update inside an interactive transaction that calls `lockPlaidItem(tx, plaidItemId)`, handle `SyncLockHeld` as a logged retryable reconciliation failure, and add a test where an in-flight sync lock prevents billing disconnect from corrupting status.

### CR-04: BLOCKER - Failed Final-Limit Cleanup Creates Untracked Billable Plaid Items

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:540`

**Issue:** The exchange plan performs Plaid token exchange and `accountsGet` before the user lock, then on final limit failure tries `itemRemove` and returns 402 (`docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:557`). If that cleanup call fails, no local `PlaidItem` row is created, so daily reconciliation cannot retry removal. This is a production billing leak: a concurrent Lite exchange can create a Plaid-side Item after the user has hit their limit, fail cleanup during a transient Plaid/network error, and leave Fina with no token row to remove later.

**Fix:** Add a durable cleanup path for post-exchange failures: either persist a disconnected/pending-removal row with encrypted access token and a retryable cleanup status before returning, or add a dedicated cleanup queue/table. Tests must simulate `itemRemove` failure after final limit rejection and prove the Plaid-side token is retained for retry without granting an active connection.

## Warnings

### WR-01: WARNING - Reconnect Dedupe Ignores The Existing Merchant Normalization Pipeline Required By Spec

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:1043`

**Issue:** The spec requires same normalized merchant using the existing merchant normalization pipeline (`docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:167`). The plan instead matches `merchantRaw` exactly and says the current sync has no local normalizer (`docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:1065`), but the live code has `normalizeMerchant` and `categorizeNewTransactions` stores `merchantNormalized` (`apps/api/src/categorize/normalize.ts:23`, `apps/api/src/categorize/service.ts:78`). This will miss legitimate conservative reconnect matches whenever Plaid changes store suffixes, cities, or casing.

**Fix:** Import/use `normalizeMerchant` in the dedupe helper. Match against `existing.merchantNormalized ?? normalizeMerchant(existing.merchantRaw)` and `normalizeMerchant(t.merchant_name ?? t.name ?? "Unknown")`, while keeping the exact account/date/amount/source predicates.

### WR-02: WARNING - API Ownership Fields Are Planned As Local Web Types Instead Of Shared DTO Changes

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:1134`

**Issue:** The plan adds `connectedByUserId` and `connectedByName` to a Banks page type, but the live component aliases `PlaidItemView = PlaidItemDTO` from `@fina/shared` (`apps/web/src/app/(app)/settings/banks/_components/connected-banks-list.tsx:145`). The shared DTO currently lacks these fields (`libs/shared/src/dto/plaid.ts:5`). This violates the repo rule that API response shapes consumed by frontend live in `@fina/shared`, and it can produce type drift between web/mobile consumers.

**Fix:** Add the ownership fields to `libs/shared/src/dto/plaid.ts`, update the API route to return that DTO shape, and add `libs/shared/src/dto/plaid.ts` to Task 7's files and commit.

### WR-03: WARNING - Reconciliation Tests Miss Tier And Status Cases Required By The Spec

**File:** `docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md:210`

**Issue:** The planned reconciliation tests cover Lite keeping one, cross-member ownership, invalid membership, and orphans. They do not test Pro keeping first 5, free/canceled users disconnecting all owned Items, or `error`/`relink_required` statuses counting against the limit, all of which are explicit spec requirements (`docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:17`, `docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:220`, `docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md:222`).

**Fix:** Add reconciliation service tests for Pro six-item ordering, active subscription cancellation/free user zero-limit disconnect, and billable statuses `active`, `error`, and `relink_required` all being included while `disconnected` is excluded.

---

_Reviewed: 2026-06-02T05:07:44Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: deep_
