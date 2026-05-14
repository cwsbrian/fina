# Plan 1D-tier-enforcement — Plaid connection limits + trial expiry cleanup (design)

**Date:** 2026-05-14
**Builds on:** Plan 1B-plaid-foundation (exchange endpoint, removeItemStrict), Plan 1B-cron (daily-refresh, checkBackgroundSyncGate), Plan 1C-item-webhooks (disconnected status)
**Status:** design / pre-implementation

---

## 1. Goal

Two related changes:

1. **Exchange limit check** — enforce `plaidItemLimit` at the Plaid Link and exchange endpoints so Free users can't connect, Lite users cap at 2, Pro users cap at 5.
2. **Trial expiry cleanup** — during `runDailyRefresh`, detect users whose trial has expired and call `removeItemForBilling` on their active Plaid items to stop Plaid's recurring per-Item billing (~$0.25 CAD/item/month).

## 2. Tier limits

| Tier | `plaidItemLimit` |
|---|---|
| Free (expired trial / no subscription) | 0 |
| Lite ($7/month) | 2 |
| Pro ($15/month) | 5 |

These limits are enforced at connection time (exchange endpoint) and enforced passively at daily-refresh (removes items when tier drops to Free).

Note: `Tier = "free" | "lite" | "pro"` and the `tierAtLeast` helper already exist in `libs/shared/src/tier.ts`. `computeEffectiveTier` currently only returns `"pro"` (trial active) or `"free"` (expired/no trial). `"lite"` tier is reserved for future paid subscriptions and not implemented in this plan.

## 3. Scope

### In

- `plaidItemLimit: number` added to `EffectiveTier` type in `libs/shared/src/tier.ts`.
- `computeEffectiveTier` in `apps/api/src/auth/tier.ts` returns `plaidItemLimit` (5 for trial/pro, 0 for free, 2 for lite when it exists).
- `POST /workspaces/:id/plaid/link-token` — rejects if `plaidItemLimit === 0`.
- `POST /workspaces/:id/plaid/exchange` — rejects if `plaidItemLimit === 0` OR `currentCount >= plaidItemLimit`.
- New `removeItemForBilling(env, workspaceId, plaidItemId)` in `apps/api/src/plaid/items.ts` — calls Plaid `/item/remove`, sets `plaid_items.status = 'disconnected'`, preserves all data.
- Step 0 prepended to `runDailyRefresh` — finds active items whose workspace owner has an expired trial and calls `removeItemForBilling` on each.
- New error codes `upgrade_required` (already exists) and `plaid_item_limit_reached` (new).
- Tests for all new paths.

### Out

- Lite/Pro paid subscriptions (no billing columns yet — Lite limit is wired in `computeEffectiveTier` for when subscriptions land).
- Notifying users on trial expiry (push/email — owned by 1E-morning-ritual).
- UI badges for disconnected items (owned by mobile app).
- Hard-deleting orphaned transactions or bank accounts on expiry (data is preserved).

## 4. Architecture

### 4.1 `EffectiveTier` type change (`libs/shared/src/tier.ts`)

```ts
export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
  plaidItemLimit: number;   // NEW — 0 = no Plaid, 2 = Lite, 5 = Pro
};
```

### 4.2 `computeEffectiveTier` change (`apps/api/src/auth/tier.ts`)

```ts
export function computeEffectiveTier(user: {
  trialEndsAt: Date | null;
}): EffectiveTier {
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: 5,    // Pro limit during trial
    };
  }
  // Future: check paid subscription column here → return tier:"lite", plaidItemLimit:2
  //                                            or tier:"pro",  plaidItemLimit:5
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: 0,    // No Plaid on free tier
  };
}
```

The Lite branch (`plaidItemLimit: 2`) is not reachable today (no subscription column) but is documented here so implementers don't hard-code 5 in callers — always read from `t.plaidItemLimit`.

### 4.3 Exchange endpoint changes (`apps/api/src/routes/plaid.ts`)

Both endpoints use the same shared helper — count is checked for both:

```ts
async function checkPlaidItemLimit(
  userId: string,
  workspaceId: string,
): Promise<{ error: string } | null> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit === 0) return { error: "upgrade_required" };

  const count = await prisma.plaidItem.count({
    where: { workspaceId, status: { not: "disconnected" } },
  });
  if (count >= t.plaidItemLimit) return { error: "plaid_item_limit_reached" };
  return null;
}
```

Replace `await requireProTier(ctx.session.userId)` calls in both endpoints with:

```ts
const limitErr = await checkPlaidItemLimit(ctx.session.userId, params.id);
if (limitErr) return reply.code(402).send(limitErr);
```

**Why the same check for both endpoints:** Checking count at link-token gives early feedback — a user with 5/5 Pro items doesn't go through the full bank-auth flow only to be rejected at exchange. Exchange remains the authoritative gate (race between link-token and exchange is accepted; exchange re-checks). Both checks use the same count query for consistency.

**Why `status: { not: "disconnected" }` in the count:** items removed for billing or manually disconnected don't consume a limit slot. A re-subscribing user can reconnect the same bank without being blocked by their old disconnected entries.

### 4.4 `removeItemForBilling` (`apps/api/src/plaid/items.ts`)

```ts
/**
 * Billing-side disconnect: calls Plaid /item/remove to stop recurring
 * per-item charges, then sets status='disconnected' locally. Unlike
 * removeItemStrict, this preserves the plaid_items row and all associated
 * bank_accounts and transactions — data is kept for historical reference
 * and potential re-subscription.
 */
export async function removeItemForBilling(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<void> {
  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);

  try {
    await plaidClient(env).itemRemove({ access_token: accessToken });
  } catch (e) {
    if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
      // Already removed on Plaid's side — proceed with local cleanup.
    } else {
      throw e; // propagate; caller logs and continues to next item
    }
  }

  await prisma.plaidItem.update({
    where: { id: plaidItemId },
    data: { status: "disconnected", errorCode: null },
  });
}
```

**Partial-failure retry path:** If the Plaid call succeeds but the `prisma.plaidItem.update` fails (e.g., network blip), the item stays `active` locally but is invalid on Plaid's side. Tomorrow's Step 0 in daily-refresh selects it again (`status: "active"`, trial still expired), calls `removeItemForBilling`, which calls Plaid again. Plaid returns `ITEM_NOT_FOUND`; `isPlaidErrorCode` catches it and falls through to the `prisma.plaidItem.update`, which succeeds. The retry is self-healing — no manual intervention needed.

### 4.5 `runDailyRefresh` — Step 0 prepend (`apps/api/src/cron/jobs/daily-refresh.ts`)

Inserted **before** the existing active-items sync loop:

```ts
// ── Step 0: remove active items for users whose trial has expired ──────────
const expiredItems = await prisma.plaidItem.findMany({
  where: {
    status: "active",
    workspace: {
      memberships: {
        some: {
          role: "owner",
          user: { trialEndsAt: { lt: new Date() } },
        },
      },
    },
  },
  select: { id: true, workspaceId: true },
});

let billingRemoved = 0;
for (const item of expiredItems) {
  try {
    await removeItemForBilling(env, item.workspaceId, item.id);
    billingRemoved++;
  } catch (e) {
    console.error("daily-refresh: billing-remove failed", {
      itemId: item.id,
      err: sanitizePlaidError(e),
    });
    // Failures are non-fatal: item stays active but cron retries tomorrow.
  }
}
if (billingRemoved > 0 || expiredItems.length > 0) {
  console.info("daily-refresh: trial expiry cleanup", {
    found: expiredItems.length,
    removed: billingRemoved,
  });
}
// ── existing active-items sync loop follows (separate findMany call, so
//    items removed in Step 0 are already 'disconnected' and excluded) ────────
```

**Query design:** filters on `workspace.memberships` where `role = "owner"` — the workspace owner's trial determines whether the workspace has Plaid access. Memberships of other roles don't affect this. `trialEndsAt: { lt: now }` catches any expired trial regardless of `trialConsumed`.

**Step 0 ordering:** the active-items sync loop's `findMany` is a fresh Prisma query that runs after Step 0 completes. Items set to `disconnected` in Step 0 are excluded by the `status: "active"` filter in the sync loop's query — no snapshot issue.

**trialEndsAt IS NULL:** users with `trialEndsAt = null` have `NULL < now = NULL` in Postgres (not true), so they are correctly excluded from Step 0. They would have been blocked from connecting Plaid in the first place (link-token returns 402 for `plaidItemLimit === 0`), so no active items should exist for them. This assumption holds in normal operation; dev-seeded items with `trialEndsAt IS NULL` would not be removed by Step 0.

**Idempotent:** running twice on the same day is safe — items removed yesterday are now `status='disconnected'` and excluded from the `status: "active"` filter.

**Why `sanitizePlaidError`:** the Plaid SDK error may contain `access_token` in the axios request config — consistent with the existing practice in `webhook-backfill.ts`.

## 5. Error response reference

| Error code | HTTP | Trigger |
|---|---|---|
| `upgrade_required` | 402 | `plaidItemLimit === 0` (Free tier, no Plaid) |
| `plaid_item_limit_reached` | 402 | `currentCount >= plaidItemLimit` at exchange time |

Both existed or are new. `upgrade_required` is already returned by `requireProTier` — reusing it for consistency.

## 6. Concurrency

**Exchange race (two tabs connecting simultaneously):** both pass the `count < limit` check, both exchange. Net count = limit + 1. Acceptable at this scale (dogfood). A proper fix would be a DB-level lock or unique constraint on (workspaceId, status='active') count — deferred.

**Daily-refresh + user reconnecting simultaneously:** user reconnects at the same moment the cron removes their item. The exchange endpoint checks at the time of the exchange; if `removeItemForBilling` runs first, the new connection might succeed (count dropped by 1). If exchange runs first, the cron removes it afterward. Either way, data is consistent. Acceptable.

## 7. Testing

### 7.1 `plaid.tier.test.ts` — extend or create `auth.tier.test.ts`

- `computeEffectiveTier({ trialEndsAt: future })` → `plaidItemLimit: 5`
- `computeEffectiveTier({ trialEndsAt: past })` → `plaidItemLimit: 0`
- `computeEffectiveTier({ trialEndsAt: null })` → `plaidItemLimit: 0`

### 7.2 `plaid.routes.test.ts` — extend exchange + link-token tests

Mock `effectiveTier` for each tier scenario (both link-token and exchange now run the full limit check):

- Free user → link-token → 402 `upgrade_required`
- Free user → exchange → 402 `upgrade_required`
- Pro user at limit (5 active items) → link-token → 402 `plaid_item_limit_reached`
- Pro user at limit (5 active items) → exchange → 402 `plaid_item_limit_reached`
- Pro user below limit (4 active items) → link-token → 200
- Pro user below limit (4 active items) → exchange → 200
- Disconnected items don't count toward limit (3 active + 2 disconnected → exchange allowed for Pro)

### 7.3 `plaid.items.test.ts` — `removeItemForBilling`

Real DB + mocked Plaid:

- Normal path: Plaid mock succeeds → `status='disconnected'`, row preserved, transactions preserved
- ITEM_NOT_FOUND: Plaid mock throws ITEM_NOT_FOUND → still sets `status='disconnected'` (graceful)
- Other Plaid error: throws → caller handles

### 7.4 `cron.daily-refresh.test.ts` — Step 0

Mock `removeItemForBilling` via `vi.mock("../src/plaid/items.js", ...)` (same pattern as existing `vi.mock("../src/plaid/sync.js", ...)`):

- Active item whose workspace has an owner membership with `trialEndsAt < now` → `removeItemForBilling` called
- Active item whose workspace has an owner membership with `trialEndsAt > now` (trial active) → NOT removed
- Active item whose workspace has **no owner membership at all** (owner left the workspace) → NOT targeted by query (no matching `memberships.some({ role: "owner" })` row)
- Active item with `connectedBy = null` (pre-dates tracking) — note: `connectedBy` is irrelevant; the query joins through the workspace owner membership, not through `connectedBy`
- `removeItemForBilling` throws for one item → others continue, error logged

## 8. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | Lite tier limit wiring | `plaidItemLimit: 2` branch in `computeEffectiveTier` is intentionally unreachable today (no subscription column). When Plan 1G-billing ships, it adds the subscription check there. No other file needs to change. |
| 2 | Exchange race (concurrent connections) | Accepted at dogfood scale. DB-level enforcement deferred. |
| 3 | What happens if billing removal fails? | Item stays `active`, Plaid keeps billing for that month. Cron retries tomorrow. Logged at error level. |
| 4 | Workspace with multiple members — which user's trial? | Workspace owner's trial determines Plaid access. Other members (editor/viewer) do not affect this. |
| 5 | `requireProTier` — still needed? | After this plan, both callers of `requireProTier` in `plaid.ts` are replaced. `requireProTier` remains for other routes (e.g., `/categories` rate limits if any). No removal. |
| 6 | `checkPlaidItemLimit` visibility | Defined as a module-local async function in `plaid.ts`. Not exported — only the two Plaid endpoints use it. |
| 7 | Workspace owner controls Plaid access for all members | The workspace owner's trial/subscription determines whether the workspace has Plaid access. If the owner's trial expires, ALL workspace members lose live Plaid sync — even editors on active trials. This is a known limitation at current dogfood scale (workspaces are effectively single-user). When workspace-level billing lands, this model must be revisited. |
| 8 | Concurrent exchange race accepted | Two simultaneous exchanges can both pass the count check and create count+1 items. Acceptable at dogfood scale. Proper fix is a serializable transaction or advisory lock; deferred to billing plan. |
| 9 | `removeItemForBilling` partial failure | If Plaid remove succeeds but DB update fails, item stays `active` locally. Next day's Step 0 retries: calls `/item/remove` → gets `ITEM_NOT_FOUND` → falls through → DB update succeeds. Self-healing, no manual intervention. |

---

## 9. Acceptance criteria

- [ ] `EffectiveTier.plaidItemLimit` is typed in `libs/shared/src/tier.ts`.
- [ ] Trial-active user gets `plaidItemLimit: 5`; expired gets `plaidItemLimit: 0`.
- [ ] Free user POST `/plaid/link-token` → 402 `upgrade_required`.
- [ ] Pro user at 5 active items → POST `/plaid/exchange` → 402 `plaid_item_limit_reached`.
- [ ] Pro user at 4 active items → POST `/plaid/exchange` → 200 (allowed).
- [ ] `removeItemForBilling` calls Plaid `/item/remove`, sets `status='disconnected'`, preserves row + transactions.
- [ ] `runDailyRefresh` removes active items for expired-trial workspace owners; idempotent.
- [ ] All existing 273 API tests continue to pass.
