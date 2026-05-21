# Codex CLI Review: Billing — Stripe Integration (Lite + Pro)

Date: 2026-05-21

Reviewed branch: `worktree-billing-stripe`
Spec under review: `docs/superpowers/specs/2026-05-21-billing-stripe-design.md`

Reviewer: `codex review` CLI (non-interactive), invoked from the worktree.

## Invocation

```bash
codex review --base main --title "Billing — Stripe Integration (Lite + Pro)"
```

Full pass-1 log archived at `/tmp/codex-billing-review.log`.
Full pass-2 log archived at `/tmp/codex-billing-pass2.log`.
Full pass-3 log archived at `/tmp/codex-billing-pass3.log`.
Full pass-4 log archived at `/tmp/codex-billing-pass4.log`.
Full pass-5 log archived at `/tmp/codex-billing-pass5.log`.
Full pass-6 log archived at `/tmp/codex-billing-pass6.log`.
Full pass-7 log archived at `/tmp/codex-billing-pass7.log`.

## Pass 1 — Findings

Four issues found, all in the spec.

### R1 [P1] — SubscriptionStatus enum incomplete

`SubscriptionStatus` only listed 5 statuses but Stripe sends 8. Receiving `unpaid` / `paused` / `incomplete_expired` would fail Prisma enum validation, drop the webhook write, and leave the previous `active`/`past_due` row in place — silently keeping a user on paid tier after the sub effectively died.

**Fix (commit a107e46):** Mirror Stripe's full status set in the enum. Document which three (`trialing` / `active` / `past_due`) count as active for EffectiveTier; the other five are inactive. Update the `@fina/shared` type literal to match.

### R2 [P2] — `/billing/sync` no-op on first Checkout return

The early-return `if (!user.stripeCustomerId) return` short-circuited exactly when the sync was needed: on a user's first Checkout, `stripeCustomerId` is still null until `checkout.session.completed` processes. Combined with a `success_url` that didn't carry the Session ID, the API had no way to recover from a delayed webhook.

**Fix (commit a2dcd6c):** `success_url` now includes `{CHECKOUT_SESSION_ID}`. `/billing/sync` accepts an optional `sessionId` body field; when present, the API retrieves the Session with subscription expanded, verifies `client_reference_id` matches the caller's `user.id` (defence in depth), and upserts customer + subscription even when `stripeCustomerId` is still null. `@fina/shared` adds a `SyncBody` zod schema.

### R3 [P2] — `trial_end` 48-hour minimum guard

Stripe Checkout requires `subscription_data.trial_end` to be ≥48h in the future. The original pseudocode unconditionally passed `trialEndsAt` whenever it was after `now`. A user upgrading inside the last 48h of their local trial would hit a Stripe creation error — Upgrade button just wouldn't work.

**Fix (commit 08b2d5a):** Pulled trial-end decision into a `useTrialEnd()` helper that returns `false` when remaining trial is under 48h. In that case the call omits `trial_end` and Stripe bills immediately — acceptable because the user is explicitly converting and the lost value is at most ~2 days. Added a regression test case.

### R4 [P2] — `MeDTO.tier` wire shape

The MeDTO extension example showed `tier: EffectiveTier`, but the existing wire shape is `tier: Tier` (plain string). Shipping the change would have broken every existing consumer.

**Fix (commit e82b231):** Restored `tier: Tier`. The spec only ever needed to ADD a field, not replace one. The UI infers source ("trial" vs "paid" vs "default") from the combination of `trial.active` and the new `subscription` field — same information, no wire change. `EffectiveTier` remains an internal server-side type.

## Pass 2 — Verification

After R1-R4 fixes:

> The change only adds a design document and does not modify executable code or tests. I found no discrete, actionable bug introduced by this patch.

## Pass 3 — Additional finding

### R5 [P2] — Webhook handlers must be order-independent

Stripe webhook delivery is not ordered. With the spec's previous wording:

- `subscription.updated` could land before `subscription.created` → update-only handler had no row to update → state change lost.
- A stale `subscription.created` retry could land AFTER a newer `subscription.updated` → handler with payload-only data would overwrite the row with stale state.

**Fix (commit 3a69bd0):** Every subscription-touching handler (`checkout.session.completed`, `subscription.created` / `.updated` / `.deleted`) now re-fetches the subscription from Stripe via `stripe.subscriptions.retrieve` and UPSERTs. The event payload identifies WHICH sub changed; current state comes from the API. This is Stripe's documented best practice ("use webhook as notification, read state from API"). Pulled into a `syncSubscriptionFromStripe(subId, userId)` helper. Added two regression test cases for out-of-order delivery.

## Pass 4 — Verification

After R5 fix:

> The diff only adds design/review documentation and does not modify executable code, schemas, or tests. I found no discrete introduced issue that would break existing behavior.

## Pass 5 — Clean

No new codex findings. While reading codex's context dump I noticed a cross-file consistency issue codex couldn't flag (no code in the diff): the spec was introducing a new `WEB_BASE_URL` env var when `WEB_APP_URL` already exists in `apps/api/.env` for invite-link generation. Filed as self-discovered R6.

### R6 [self-discovered] — Reuse existing `WEB_APP_URL`

Two env vars for the same URL would be a foot-gun in prod (forget to set one → redirects to localhost). Replaced `WEB_BASE_URL` with `WEB_APP_URL` throughout the spec. Env addition list drops from 5 to 4 (Stripe-only). Fix in commit `ed4d466`.

## Pass 6 — Additional findings

### R7 [P1] — Persist Stripe Customer before first Checkout

For a first-time upgrade, the spec passed `customer_email` (no customer ID) to Stripe Checkout. If the user hits Upgrade in two tabs before either webhook lands, Stripe creates TWO distinct Customer records — one per Checkout — and both subscribe. The webhook stores only the latest `customerId` on `User.stripeCustomerId`; the other customer (and its subscription) becomes orphaned. Portal only sees the stored one. User is double-billed and can't manage one of the subs via the app.

**Fix (commit 4151518):** `ensureStripeCustomer(user)` runs BEFORE Checkout. Creates Stripe Customer if needed, persists `customerId` on the User row, then returns it. Checkout always passes `customer:` (never `customer_email`). Both concurrent Checkouts now use the same Customer → same subscription path → Portal-manageable. Idempotency key `customer-create-<userId>` makes the Stripe create itself safe to retry across DB-write failures (Stripe returns the same record for repeat calls with the same key).

### R8 [P2] — `MeDTO.subscription` must carry active subs only

The decision matrix said "canceled → Free, no Manage CTA", but the rule "UI infers paid source from `subscription !== null`" would classify a user with a stale `status: canceled` row as paid — because we retain canceled rows for history.

**Fix (commit 3aaf7cb):** Made the rule explicit. `MeDTO.subscription` returns the user's ACTIVE subscription (`status ∈ {trialing, active, past_due}`) or `null`. Canceled / unpaid / incomplete / incomplete_expired / paused rows are retained in DB but excluded from `MeDTO`. UI gets exactly one source of truth that already reflects the right active/inactive split. Documented the multi-active-sub tie-break (highest tier wins, matching EffectiveTier precedence) — rare but deterministic.

## Pass 7 — Verification

After R7 + R8 fixes:

> The diff only adds design/review documentation and does not modify executable code, schemas, or tests. I found no discrete introduced issue that would break existing behavior.

## Status

Spec is review-clean across three rounds (Pass 2 + Pass 4 + Pass 5 + Pass 7). Ready to proceed to implementation plan.

Resulting commits on `worktree-billing-stripe`:

```
3aaf7cb docs(plan billing-stripe): codex R8 P2 — MeDTO.subscription carries active subs only
4151518 docs(plan billing-stripe): codex R7 P1 — persist Stripe customer before Checkout
ed4d466 docs(plan billing-stripe): self-discovered R6 — reuse existing WEB_APP_URL
3a69bd0 docs(plan billing-stripe): codex R5 P2 — order-independent webhook handlers
e82b231 docs(plan billing-stripe): codex R4 P2 — preserve MeDTO.tier wire shape
08b2d5a docs(plan billing-stripe): codex R3 P2 — 48h trial_end minimum guard
a2dcd6c docs(plan billing-stripe): codex R2 P2 — make /billing/sync work on first Checkout
a107e46 docs(plan billing-stripe): codex R1 P1 — full Stripe status enum
722a46b docs(spec): design for Stripe billing (Lite + Pro)
```
