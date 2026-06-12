# Billing Recovery Unification Design

## Goal

Unify subscription recovery across Apple IAP, Google Play IAP, and Stripe so the app has one lock/recover flow regardless of billing source.

Today, native IAP mismatch handling works for Apple and largely has the Android server primitives, but the user-facing model is still named around IAP. Stripe has a server-side `/billing/sync` flow, mostly used by the web settings page, but it is not represented as a mobile recovery action. This design makes the recovery state source-agnostic while keeping provider-specific recovery actions.

## User Experience

When the account plan and provider state disagree, the app locks paid usage and routes the user to the Plan screen.

The Plan screen shows one recovery panel with source-specific action text:

- Apple IAP: `Restore purchases`
- Google Play IAP: `Restore purchases`
- Stripe: `Sync billing`

After the user taps the recovery action, the app refreshes `/me`.

- If recovery clears the lock, the app returns to Home.
- If recovery does not clear the lock, the app stays locked and shows the recovery panel.
- If the provider sync fails, the app keeps the existing lock and surfaces a retryable error.

## Server Contract

Add a source-agnostic recovery shape to `MeDTO`:

```ts
billingRecovery: {
  locked: boolean;
  reason: "plan_mismatch" | null;
  source: "iap_apple" | "iap_google" | "stripe" | null;
  action: "restore_iap" | "sync_stripe" | null;
  lastCheckedAt: string | null;
}
```

For compatibility during rollout, the existing `iapIntegrity` field can remain in `MeDTO`. Mobile code should move lock decisions to `billingRecovery.locked`, while existing IAP integrity helpers can continue to feed the recovery state internally.

## Provider Behavior

Apple and Google recovery use the current native restore flow:

- Read current native purchases or entitlements from the device.
- POST them to `/billing/iap/restore`.
- Server verifies receipts/tokens with Apple or Google.
- Server updates the subscription row and clears `User.isPlanMismatch` on a successful sync.

Stripe recovery uses server-side sync:

- Mobile POSTs `/billing/sync` with no `sessionId`.
- Server lists the authenticated user's Stripe subscriptions through `stripeCustomerId`.
- Server re-fetches each subscription from Stripe and upserts the DB row.
- Server returns the latest `MeDTO`.

Stripe recovery does not require Apple/Google password prompts or device receipt access because Stripe is fully server-side.

## Lock Rules

`User.isPlanMismatch` remains the durable lock flag for known mismatches. `/me` must return `billingRecovery.locked=true` whenever that flag is true.

Recovery source/action should come from the current primary subscription source when available:

- `iap_apple` -> `restore_iap`
- `iap_google` -> `restore_iap`
- `stripe` -> `sync_stripe`

If no source can be determined, keep the user locked and return `action=null` so the UI can show a generic support/retry message instead of a misleading provider action.

Future complimentary/admin grants are not mismatch sources. If an active grant becomes the effective entitlement, it must not require restore or Stripe sync.

## Mobile Changes

Mobile should replace direct lock checks against `me.iapIntegrity.isPlanMismatch` with `me.billingRecovery.locked`.

The Plan screen should dispatch recovery through one function:

- `restore_iap`: call the existing native restore function.
- `sync_stripe`: call a new mobile billing client wrapper for `POST /billing/sync`.

The successful recovery condition is always the same: refetch or receive `MeDTO`, then proceed only when `billingRecovery.locked` is false.

## Testing

API tests should cover:

- `/me` returns `billingRecovery.locked=false` for normal accounts.
- Apple mismatch maps to `restore_iap`.
- Google mismatch maps to `restore_iap`.
- Stripe mismatch maps to `sync_stripe`.
- `/billing/sync` can clear a Stripe mismatch when Stripe state and DB converge.

Mobile-focused tests or lightweight component assertions should cover:

- Home routes locked users to Plan using `billingRecovery.locked`.
- Plan screen shows restore copy for IAP.
- Plan screen shows sync copy for Stripe.
- Successful recovery returns to Home.

Manual smoke test:

1. Force a user's plan mismatch in DB.
2. Confirm the app locks and shows the right provider recovery action.
3. Run the provider recovery action.
4. Confirm `/me` returns unlocked state and the app returns Home.
