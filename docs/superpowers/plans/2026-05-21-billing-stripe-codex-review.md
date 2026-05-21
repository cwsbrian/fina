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

```bash
codex review --base main --title "Billing Stripe spec — pass 2 after R1-R4 fixes"
```

> The change only adds a design document and does not modify executable code or tests. I found no discrete, actionable bug introduced by this patch.

## Status

Spec is review-clean. Ready to proceed to implementation plan.

Resulting commits on `worktree-billing-stripe`:

```
e82b231 docs(plan billing-stripe): codex R4 P2 — preserve MeDTO.tier wire shape
08b2d5a docs(plan billing-stripe): codex R3 P2 — 48h trial_end minimum guard
a2dcd6c docs(plan billing-stripe): codex R2 P2 — make /billing/sync work on first Checkout
a107e46 docs(plan billing-stripe): codex R1 P1 — full Stripe status enum
722a46b docs(spec): design for Stripe billing (Lite + Pro)
```
