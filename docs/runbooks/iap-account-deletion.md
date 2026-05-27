# Runbook — IAP account deletion integration

**Audience:** future implementer of `DELETE /me` / account-deletion flow.

## Background

Fina mobile IAP webhooks consult `IapDeletedBinding` to recognize
notifications for users we've deleted. Without a tombstone, our
webhook 500s for 5 retries (per spec §5.3 step 4) before the per-
token retry-cap trips and stops the noise. The cap exists as a
safety net; the tombstone is the right answer.

## What the deletion flow MUST do

BEFORE removing the `User` row (or in the same transaction):

```ts
import { writeAccountDeletionTombstones } from "@fina/api/src/iap/account-deletion.js";

await writeAccountDeletionTombstones(userId);
// ... cancel any Stripe subs, null out PII fields per spec §12.1
//     retention guidance (6-year tax-retention exemption), etc.
// ... finally delete or tombstone the User row.
```

`writeAccountDeletionTombstones` is idempotent and no-ops for users
who never made an IAP purchase.

## What the deletion flow MUST NOT do

- Hard-delete `Subscription` rows for IAP-source subs. Spec §12.1
  requires PII-null + retain 6 years (CRA tax retention).
- Hard-delete the `User` row while IAP `Subscription` rows still
  reference it via `userId`. `Subscription.userId` has
  `onDelete: Cascade` in `prisma/schema.prisma` — deleting the
  User would drop the Subscription rows we just told you to retain.
  The deletion flow must instead: (a) null out PII on the User row
  + reassign Subscription.userId to a system "deleted users" sentinel,
  OR (b) keep the User row but mark it as deleted with a `deletedAt`
  column. Pick whichever fits the broader account-deletion design.
- Cancel the Apple/Google subscription server-side. We cannot; the
  user must do it via Apple Settings / Play Store. UI must surface
  a blocking banner.

## Verification

After deletion, simulate a renewal webhook for the deleted user:
the webhook handler should consult IapDeletedBinding, log
`unattributable_after_delete`, and return 200 immediately (no 500-
retry cascade).

## When this becomes self-service

If/when account deletion is exposed in the mobile UI:
- Block deletion if any active `iap_apple` / `iap_google` Subscription
  rows exist. Show "Cancel your subscription first" with a deep-link
  to the platform's subs UI (see Task 12 of the IAP plan for the
  iOS/Android deep-link patterns).
- Only proceed after the user confirms platform-native cancel.
