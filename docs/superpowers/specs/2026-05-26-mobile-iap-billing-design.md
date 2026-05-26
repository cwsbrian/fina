# Mobile IAP Billing — Design

**Status:** Draft for review
**Date:** 2026-05-26
**Reference:** `docs/superpowers/specs/2026-05-07-fina-design.md §13.7` (IAP + Web hybrid)
**Builds on:** Stripe billing (shipped) — `apps/api/src/routes/billing.ts`, `apps/api/src/stripe/sync-sub.ts`, `apps/api/src/routes/billing-webhook.ts`

---

## 1. Goal

Let mobile users subscribe to Lite or Pro through Apple App Store / Google Play in-app purchase, with the same source-of-truth (`subscriptions` table) and the same effective-tier resolution as Stripe web subs. Mirror the Stripe pattern: client-driven purchase, server-driven status sync via webhooks, restore button for cross-device continuity.

**Non-goals (v1):**
- Annual plans (deferred to v1.5+ per design §13.7).
- Family Sharing / shared subscriptions across Apple ID household.
- Promo codes / offer codes (Apple `Promotional Offers`).
- Server-side notification *retry/queue* — first delivery handled live, store retries on 5xx.
- Migration tooling for users who switch from Stripe → IAP (manual support task).

## 2. Architecture (one paragraph)

Mobile calls `react-native-iap` to fetch products + initiate purchase. On success, the SDK returns a platform receipt; the app POSTs it to `POST /billing/iap/checkout` with `{platform, productId, transactionId, purchaseToken?}`. The API validates the receipt against Apple App Store Server API or Google Play Developer API, then upserts a `Subscription` row keyed on `(source, sourceSubscriptionId)` — identical pattern to `syncSubscriptionFromStripe`. Apple ASSN V2 and Google Real-Time Developer Notifications hit `POST /webhooks/iap/apple` and `POST /webhooks/iap/google` for renewals/cancellations/refunds — both verify signatures, dedup via `WebhookEvent`, then re-fetch + upsert. The mobile More tab continues to show the Subscription group only when `subscription === null` or `source ∈ {iap_apple, iap_google}` (already shipped).

## 3. Shared library touchpoints (`@fina/shared`)

Per the **Shared lib first** principle, all new wire types live in `libs/shared/src/` before any consumer code is written.

**New files (following existing schemas/ vs dto/ vs errors.ts convention):**

- `libs/shared/src/iap/productIds.ts` — single source of truth for product SKUs. `billingPeriod` deliberately omitted from the constant until annual lands (v1.5); when added, store it on `Subscription.billingPeriod` directly per the existing column.
  ```ts
  export const IAP_PRODUCT_IDS = {
    lite_monthly: { tier: "lite" },
    pro_monthly:  { tier: "pro" },
  } as const;
  export type IAPProductId = keyof typeof IAP_PRODUCT_IDS;
  ```
  This is the **only** IAP pricing-map. `apps/api/src/iap/` imports it directly — no second `pricing-map.ts` file (the Stripe pattern has one because Stripe price IDs come from env vars; IAP product IDs are app-shared constants, so the env indirection isn't needed).

- `libs/shared/src/schemas/iap.ts` — zod request body schemas (mirrors `schemas/billing.ts` placement, NOT `dto/`).
  ```ts
  export const IAPPlatform = z.enum(["ios", "android"]);
  export const IAPCheckoutBody = z.object({
    platform: IAPPlatform,
    productId: z.enum(["lite_monthly", "pro_monthly"]),
    // iOS: signedTransaction JWS string (StoreKit 2, ~2-3 KB).
    // Android: purchaseToken (short opaque string).
    receipt: z.string().min(1).describe("iOS: signedTransaction JWS string; Android: purchaseToken"),
  });
  export const IAPRestoreBody = z.object({
    platform: IAPPlatform,
    purchases: z.array(z.object({
      productId: z.enum(["lite_monthly", "pro_monthly"]),
      receipt: z.string().min(1),
    })).min(1).max(20),
  });
  ```
  Field renamed `transactionToken` → `receipt` — industry term, less misleading than "token" for the 2-3 KB JWS.

- **No separate `iap-errors.ts` file.** Append IAP codes to the existing `ApiErrorCode` union in `libs/shared/src/errors.ts` (`API_ERROR_CODES` array). New codes: `invalid_receipt`, `expired_receipt`, `product_mismatch`, `already_subscribed_stripe`, `already_subscribed_iap`, `user_mismatch`, `platform_unavailable`, `iap_not_configured`. Frontend exhaustive switches now narrow over the full union without a separate import path.

**Subscription ID contract:**
- Apple: `Subscription.sourceSubscriptionId = originalTransactionId` ALWAYS. Never `transactionId` (which rotates per renewal). `originalTransactionId` is stable across renewals and is the subscription identity. The checkout route, the webhook handler, and `syncSubscriptionFromIAP` must all normalize to `originalTransactionId` before upserting — otherwise checkout-route and webhook target different rows and we get duplicate `Subscription` records per user.
- Google: `Subscription.sourceSubscriptionId = purchaseToken`. But the v2 response may carry `linkedPurchaseToken` after an in-Play tier change — see §7 for the chain-rewrite handling.

**Schema additions to `User`, `Subscription`, and new `IapDeletedBinding` model (one migration):**

```prisma
model User {
  // ...existing fields...
  iapAppleAccountToken    String?  @unique   // uuidv5(userId, IAP_NAMESPACE) — written on first successful Apple checkout
  iapGoogleObfuscatedId   String?  @unique   // sha256(userId) hex — written on first successful Google checkout
}

model Subscription {
  // ...existing fields...
  /// "Production" | "Sandbox" — derived from verified transaction's
  /// `environment` (Apple) or sandbox flag in v2 response (Google).
  /// Defaults to "Production" for existing Stripe rows on migration.
  /// `buildMeBody` / `effectiveTier` filter out rows whose environment
  /// doesn't match the runtime APPLE_ENV / GOOGLE env to prevent stale
  /// sandbox rows from granting prod entitlement.
  environment             String   @default("Production")
}

/// Tombstone for IAP bindings whose `User` row was deleted. Webhook
/// handlers consult this to stop retrying notifications for purchases
/// that will never resolve to a Fina user. Forensic-only — never read
/// by `/me` or any user-facing route.
model IapDeletedBinding {
  id        String   @id @default(cuid())
  source    String   // "iap_apple" | "iap_google"
  /// sha256(appAccountToken) for Apple, sha256(obfuscatedExternalAccountId)
  /// for Google. We hash before storing so the deleted-user identifier
  /// itself is not recoverable from this table.
  tokenHash String
  /// Original userId (also hashed if any retention concern). Useful for
  /// audit/support replay. Optional.
  userIdHash String?
  deletedAt DateTime @default(now())

  @@unique([source, tokenHash])
  @@map("iap_deleted_bindings")
}
```

The `User.iap*` columns are the **reverse-lookup binding** used by webhook handlers as the *fallback* path when the `Subscription` row doesn't yet exist (first-purchase race, Android resubscribe-after-expiry). The webhook's primary path is the `Subscription` lookup by `sourceSubscriptionId`; the binding lookup runs second. Full resolution order is the 4-step ladder defined in §5.3: (1) `Subscription` lookup, (2) `User.iap*` binding lookup, (3) `IapDeletedBinding` tombstone (200, stop retrying), (4) 500 with retry-cap. Without the binding column, a webhook whose corresponding checkout never lands (mobile crash, network mid-flight) drops permanently and the user is charged with no Fina record. Without the tombstone, a webhook for a deleted user 500s forever.

**These binding tokens are identifiers, not authenticators.** The security boundary is the verified Apple JWS / verified Google Pub/Sub signature — not the secrecy of `IAP_NAMESPACE`. Source-code disclosure of `IAP_NAMESPACE` does not weaken the design: an attacker who can compute `uuidv5(userId, IAP_NAMESPACE)` for an arbitrary userId still cannot forge a signed transaction carrying that token. The token only binds an *already-authenticated* purchase to a Fina user.

**Account-deletion writes the tombstone before dropping the User row** (see §12.1) — that's what gives webhooks a way to say "the user is gone, stop retrying" without 500-forever.

`Subscription.sourceCustomerId` continues to hold the same `appAccountToken` / `obfuscatedAccountId` per-row for forensic/dedup convenience; the `User.iap*` columns are the canonical user→token binding.

## 4. Mobile library + config

**Library:** `react-native-iap` (community standard; works under EAS Build with a config plugin shipped by the package). Rejected alternatives:
- `expo-in-app-purchases` — deprecated by Expo.
- `expo-iap` — newer fork, smaller community, less battle-tested.

**⚠ Dev workflow break — Expo Go cannot exercise IAP.** `react-native-iap` is a native module requiring a custom dev client (`expo prebuild` or `eas build --profile development`). The current Fina mobile dev workflow runs Expo Go over Tailscale (per `project_mobile_dev_network.md`). Implications:
- The plan picker screen can be loaded under Expo Go for layout work, but `getSubscriptions` will throw "module not linked" and the empty-state fallback will render.
- Purchase flows can ONLY be tested via the dev client / TestFlight / Play internal track.
- Every developer who needs to exercise IAP must `eas build --profile development` once to get a custom dev client, then load that build instead of Expo Go.
- This is loud in the spec because the workflow surprise is real — silent feature gating in Expo Go is the most expected failure mode.

**App config (`apps/mobile/app.json`):**
- iOS: `usesAppleSignIn` not required, but `expo.ios.bundleIdentifier` must match the Apple bundle ID configured in App Store Connect.
- Android: add `"BILLING"` permission via the config plugin (auto-injected).
- EAS profile: build with `eas build --profile production` for store submission, `eas build --profile development` for IAP-capable dev client.

**Mobile units:**
- `apps/mobile/src/iap/client.ts` — thin wrapper around `react-native-iap` (init, getSubscriptions, requestSubscription, getAvailablePurchases, finishTransaction). All async-safe with `useEffect` cleanup.
- `apps/mobile/src/iap/types.ts` — re-exports `IAPProductId` + a `LocalProduct` shape (productId + tier + storefront localizedPrice + localizedTitle from the store, not from server).
- `apps/mobile/app/plan/index.tsx` — Plan picker screen. Lists Lite/Pro from `getSubscriptions`, shows store-localized price, "Subscribe" button per product. **Empty-state fallback:** if `getSubscriptions` returns `[]` (misconfigured ASC/Play products, sandbox tester not signed in, Expo Go runtime, network failure), render an inline "Subscriptions aren't available right now — try again later" message rather than a blank screen. Do **not** add a web Stripe link on iOS — this is an Apple App Review Guideline 3.1.1 violation (in-app subscriptions cannot link to external payment flows on iOS).
- `apps/mobile/app/plan/restore.tsx` — Restore Purchases screen with a single button + status text.
- `apps/mobile/src/api/billing.ts` — typed wrappers for the two new endpoints (`postIAPCheckout`, `postIAPRestore`).

**Restore Purchases discoverability (Apple guideline 3.1.1):**
- A "Restore purchases" button MUST appear on the plan picker screen (`/plan`) regardless of subscription state — new mobile users reinstalling who had a prior purchase land here, not in More tab. This is the placement Apple's reviewers actually check.
- The same row also appears in More → Subscription when `billingOwnedByMobile` (already in §4 — preserved).

**Subscription group in More tab:**
- Add a "Restore purchases" row below "Manage billing" (visible only when `billingOwnedByMobile`).
- "Manage billing" row deep-links to the platform's native subscription management. iOS: `https://apps.apple.com/account/subscriptions`. Android: `https://play.google.com/store/account/subscriptions?package=...&sku=<currentProductId>` where `currentProductId` is derived from `me.subscription.tier` via the inverse of `IAP_PRODUCT_IDS` — hard-coding the wrong sku 404s the deep link. Per Apple guidelines we cannot host an in-app cancel UI for IAP subs.
- "Plan" row routes to `/plan` (picker) when `subscription === null`, otherwise to a read-only plan summary screen.

## 5. Backend additions

### 5.1 Env vars (`apps/api/src/env.ts`)

```
APPLE_BUNDLE_ID                 # com.fina.app — must match Xcode bundle id
APPLE_ASC_ISSUER_ID             # App Store Connect API issuer UUID
APPLE_ASC_KEY_ID                # ASC API key ID
APPLE_ASC_PRIVATE_KEY           # PEM string (base64-decoded at boot)
APPLE_ENV                       # sandbox | production — routes apple-client between api.storekit-itc.apple.com (sandbox) and api.storekit.itunes.apple.com (prod). MUST also match the `environment` claim in verified JWS (see §5.2 check #4).
GOOGLE_PACKAGE_NAME             # app.fina (Play Console package name)
GOOGLE_SERVICE_ACCOUNT_JSON     # full JSON blob (single-line, escaped) for Play Developer API
GOOGLE_PUBSUB_VERIFY_AUDIENCE   # the audience claim we expect in Google's OIDC JWT (set when subscribing to Pub/Sub)
GOOGLE_PUBSUB_VERIFY_EMAIL      # the service account email we expect as `email` claim in the OIDC token
GOOGLE_PUBSUB_SUBSCRIPTION_NAME # full Pub/Sub subscription name (projects/.../subscriptions/...) — verified in the envelope to defend against a misconfigured second push pointing at our URL
```

All new vars optional (z.string().optional()) so dev/test envs without store credentials don't blow up. Use-site throws `HttpError(503, "iap_not_configured")` when consumer code runs without them (503 — service-not-configured semantics, not a generic 500).

**Boot-time validation + log redaction (required):**
- On boot, validate the shape of every IAP secret: `APPLE_ASC_PRIVATE_KEY` must contain `BEGIN PRIVATE KEY`; `GOOGLE_SERVICE_ACCOUNT_JSON` must JSON-parse and contain `client_email` + `private_key` keys. Fail loud at startup, not at first webhook.
- **Boot-time validation errors MUST NOT contain any portion of the env value** — not even a prefix. `throw new Error("APPLE_ASC_PRIVATE_KEY shape invalid")` is fine; `throw new Error(\`APPLE_ASC_PRIVATE_KEY shape invalid: ${value.slice(0,32)}…\`)` leaks the .p8 prefix to container logs via stderr (Pino's redact config does NOT apply to raw stderr writes). The validator should name the env var by key only and route any diagnostic detail through a `redactEnv()` helper that strips secrets.
- `GOOGLE_SERVICE_ACCOUNT_JSON` is accepted in either form: a single-line JSON string OR a base64-encoded JSON string. The loader tries base64-decode first (Vercel's 4 KB per-var limit is tight for raw JSON, base64 is safer). Document the canonical form as base64 in the env example.
- Extend the Pino logger `redact` config to cover: `APPLE_ASC_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, every nested `*.private_key`, `purchaseToken`, `signedTransactionInfo`, and `appAccountToken`. Without redaction, a stray `app.log.error({ env }, ...)` leaks long-lived store credentials to the log aggregator.
- Never serialize `app.fina.env` whole. If we ever need to print env for diagnostics, route it through a `redactEnv()` helper that strips the IAP secrets explicitly.

### 5.2 Modules (`apps/api/src/iap/`)

- `apple-client.ts` — Calls App Store Server API `inApps/v1/transactions/{transactionId}` + `inApps/v1/subscriptions/{originalTransactionId}` with JWT auth (JWT signed each call, 5-min expiry, cached). Exposes `verifyAndDecodeTransaction(jws): VerifiedAppleTransaction` which **fails closed** unless ALL of the following hold (the JWS body is decoded only after the cert chain verifies):
  1. JWS header `alg === "ES256"` (never `none`, never HS256, never RS256).
  2. The X5C cert chain terminates at Apple's WWDR root, **pinned by SPKI SHA-256 hash in code** (no runtime fetch).
  3. `bundleId === env.APPLE_BUNDLE_ID` — rejects valid JWS from any other app.
  4. `environment === env.APPLE_ENV` ("Production" or "Sandbox") — rejects sandbox JWS in prod (the "free Pro" exploit).
  5. `signedDate` within last 10 minutes for ASC-API responses; within last 1 hour for ASSN webhook payloads — bounds replay of captured/stored payloads. (ASSN window is longer than ASC-API because Apple's ASSN delivery can re-emit on retry with the originally-signed payload, so the legitimate delivery window is wider; both windows are far tighter than Apple's 5-day retry ceiling, so a captured-and-replayed payload ages out well before the retry budget exhausts.)
  6. `appAccountToken` is present (not `undefined`). Without it we cannot bind to a Fina user, so reject — never bind to "whoever's session POSTed".
- `google-client.ts` — Calls Google Play Developer API `purchases.subscriptionsv2.get(packageName, token)` with service-account auth (googleapis lib). Returns the v2 SubscriptionPurchaseV2 shape. **Also calls `purchases.subscriptionsv2.acknowledge` after every successful upsert when the validated `acknowledgementState === ACKNOWLEDGEMENT_STATE_PENDING`** — Google auto-refunds and revokes the purchase if not acknowledged within 3 days. The call is idempotent so we run it on every sync (initial + webhook). Acknowledge failure is non-fatal (logged + retried on next webhook), but acknowledge MUST run **after** the local upsert lands so we never acknowledge a purchase we couldn't record.
- `pricing-map.ts` — Maps `productId → tier` from `IAP_PRODUCT_IDS` (single import from @fina/shared).
- `sync-sub.ts` — Mirror of `apps/api/src/stripe/sync-sub.ts`. Signature: `syncSubscriptionFromIAP(env, args, log)` where `args` is one flat discriminated-union object. Apple shape: `{platform: "ios", originalTransactionId, userId, expectedAppAccountToken?, productId?}`. Google shape: `{platform: "android", purchaseToken, productId, userId, expectedObfuscatedAccountId?}`. The `expected*` field is optional: when supplied (checkout/restore paths), the function 403s `user_mismatch` on disagreement; when absent (webhook path), it skips the check per §12.3 trust-chain rationale. Re-fetches from the store, normalizes status (see §5.4), upserts.
- `webhook-verify.ts` — Apple ASSN V2 JWS verification + Google RTDN OIDC token verification.

### 5.3 Routes

**`POST /billing/iap/checkout`** — Authenticated. Body: `IAPCheckoutBody`. Flow:
1. `requireSession`, load user.
2. Check `prisma.subscription.count` for active subs (matching `ACTIVE_SUBSCRIPTION_STATUSES`):
   - any active Stripe sub → 409 `already_subscribed_stripe`.
   - any active IAP sub → 409 `already_subscribed_iap`.
3. Call `syncSubscriptionFromIAP({platform, productId, receipt, userId, expectedAppAccountToken: uuidv5(userId, IAP_NAMESPACE), expectedObfuscatedAccountId: sha256(userId)})`. The sync function MUST 403 `user_mismatch` if the verified transaction's `appAccountToken` (iOS) or `obfuscatedAccountId` (Android) does NOT equal the expected value derived from the caller's session — this is the attacker-binds-someone-else's-receipt defense. The check is mandatory, not optional.
4. On first successful checkout, write `User.iapAppleAccountToken` / `User.iapGoogleObfuscatedId` so subsequent webhooks can reverse-resolve userId. Subsequent checkouts re-derive the same value (deterministic) and either match the existing binding or 403.
5. Validation failure → 400 with the IAPErrorCode.
6. Tier resolution: `syncSubscriptionFromIAP` derives `tier` solely from the verified transaction's `productId` via the shared pricing map. The request body's `productId` is used only for telemetry / `product_mismatch` 400 if it disagrees — the server NEVER trusts client-side productId for write decisions.
7. Return `buildMeBody(userId)` — same shape `/billing/sync` returns.

**`POST /billing/iap/restore`** — Authenticated. Body: `IAPRestoreBody`. Flow:
1. `requireSession`, load user.
2. For each purchase: call `syncSubscriptionFromIAP` with the same expected-token args as `/billing/iap/checkout` step 3. Skip (log + continue) on individual failures so partial restores succeed.
3. Cross-source guard: a verified transaction with NO `appAccountToken` (Apple) or NO `obfuscatedAccountId` (Google) is treated as `user_mismatch` — never bind ambiguous purchases. The same applies if the present-but-mismatched token doesn't match `uuidv5(callerUserId, IAP_NAMESPACE)` / `sha256(callerUserId)`. Both cases continue (skip this one, process the rest).
4. Mobile client MUST pre-filter `getAvailablePurchases` to `productId IN IAP_PRODUCT_IDS` and dedup on `originalTransactionId` before POSTing, so the 20-item cap is exercised only on legitimate Fina purchases.
5. Return `buildMeBody(userId)`.

Both webhook routes use a per-plugin `addContentTypeParser` with `parseAs: "buffer"`, scoped to the plugin's encapsulation context (mirror of `apps/api/src/routes/billing-webhook.ts:11`). Without raw bytes, Fastify re-serializes the body and JWS / Pub/Sub signature verification fails.

**`POST /webhooks/iap/apple`** — Unauthenticated (signature-verified). Per ASSN V2:
1. Parse `signedPayload` (JWS). Verify via `apple-client.verifyAndDecodeTransaction` — all six checks in §5.2 apply (alg pinning, SPKI-pinned root, bundleId, environment, signedDate ≤ 1h, appAccountToken presence).
2. Extract `notificationUUID` → dedup against `WebhookEvent` (id = "apple:" + notificationUUID; source = "iap_apple").
3. Extract `signedTransactionInfo.originalTransactionId`.
4. Resolve userId, in order:
   1. `Subscription.findFirst({ where: { source: "iap_apple", sourceSubscriptionId: originalTransactionId }})` → existing sub, use its `userId`.
   2. Fallback: the verified JWS carries `appAccountToken`. `User.findUnique({ where: { iapAppleAccountToken: appAccountToken }})` → matched user, create the missing `Subscription` row here (covers webhook-before-checkout race and pure-resubscribe-from-Settings).
   3. Tombstone check: `IapDeletedBinding.findUnique({ where: { tokenHash: sha256(appAccountToken), source: "iap_apple" }})` → known-deleted user. Record a forensic `WebhookEvent` (source: `iap_apple`, type: `unattributable_after_delete`) carrying `appAccountToken` + `productId` + `notificationType`, and return **200** (stop retrying — the user is gone, no point hammering us).
   4. Still unknown → return **500**. Apple retries up to 5x over 3 days, giving `/billing/iap/checkout` time to land. Cap by per-`appAccountToken` counter: after the 5th retry-induced 500 within 3 days, write a forensic `WebhookEvent` (type: `unattributable_giveup`) and start returning **200** to prevent indefinite log spam. The counter also caps an attacker hand-replaying captured payloads within the 1-hour signature window — at normal Apple volume this never trips.
5. Call `syncSubscriptionFromIAP({platform: "ios", originalTransactionId, userId})`.
6. Record `WebhookEvent` after handler succeeds (same pattern as Stripe webhook).
7. On handler exception → 500. On signature failure → 400 (no retry).

**`POST /webhooks/iap/google`** — Unauthenticated (Pub/Sub OIDC + signature). Per RTDN:
1. Verify OIDC bearer token in `Authorization` header:
   - Audience exactly equals `env.GOOGLE_PUBSUB_VERIFY_AUDIENCE`.
   - Issuer exactly equals `https://accounts.google.com`.
   - `email` AND `azp` claims both equal `env.GOOGLE_PUBSUB_VERIFY_EMAIL` (belt-and-suspenders against `email`-only confused-deputy).
   - `exp` enforced with 0s clock skew tolerance — leaked-after-`exp` tokens must fail.
2. Pub/Sub envelope: `{message: {data: base64, messageId, ...}, subscription: "projects/.../subscriptions/..."}`. Verify `body.subscription === env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME` to defend against a misconfigured second push subscription pointing at our URL. Decode + parse the inner JSON: `{subscriptionNotification: {purchaseToken, subscriptionId, notificationType}}`. **Ignore** non-`subscriptionNotification` envelopes (`oneTimeProductNotification`, `testNotification`) — log + 200.
3. Dedup via `WebhookEvent` (id = "google:" + messageId).
4. Resolve userId, in order:
   1. `Subscription.findFirst({ where: { source: "iap_google", sourceSubscriptionId: purchaseToken }})` → existing sub, use its `userId`. Also try the `linkedPurchaseToken` if present (handles in-Play tier change crossing events).
   2. Fallback: fetch the v2 purchase via `purchases.subscriptionsv2.get`, read `externalAccountIdentifiers.obfuscatedExternalAccountId`. `User.findUnique({ where: { iapGoogleObfuscatedId: ... }})` → matched user, create the missing `Subscription` row here (covers webhook-before-checkout race AND Android resubscribe-after-expiry, which always issues a brand-new purchaseToken).
   3. Tombstone check: `IapDeletedBinding.findUnique({ where: { tokenHash: obfuscatedExternalAccountId, source: "iap_google" }})` → known-deleted user. Record `WebhookEvent` (type: `unattributable_after_delete`), return **200**.
   4. Still unknown → return **500**. Pub/Sub retries per the subscription's retry policy. Cap by per-`obfuscatedExternalAccountId` counter: after 5 retries write `unattributable_giveup` and start returning 200.
5. Call `syncSubscriptionFromIAP({platform: "android", productId: subscriptionId, purchaseToken, userId})`.
6. Record `WebhookEvent` after handler succeeds. On handler exception → 500 (Pub/Sub retries per subscription's ack-deadline + retry policy).

### 5.4 Status mapping

Apple App Store Server API → `SubscriptionStatus`:
| ASSN/ASS API state | Our enum |
|---|---|
| `SUBSCRIBED` (no `expires_date` in past) | `active` |
| `SUBSCRIBED` + trial period OR `offerType=1` (introductory) | `trialing` |
| `BILLING_RETRY` / grace period | `past_due` |
| `EXPIRED` (voluntary or involuntary) | `canceled` |
| `REVOKED` (refunded) | `canceled` |
| `PAUSED` | `paused` |

If `signedRenewalInfo.offerType != null` and we don't recognize it (future Apple addition), fail closed: treat as `trialing` rather than `active` so we never grant paid entitlement based on an unrecognized offer.

Google `SubscriptionPurchaseV2.subscriptionState`:
| Google state | Our enum |
|---|---|
| `SUBSCRIPTION_STATE_ACTIVE` | `active` |
| `SUBSCRIPTION_STATE_ACTIVE` + `lineItems[].offerDetails.basePlanId` indicates intro/trial | `trialing` |
| `SUBSCRIPTION_STATE_IN_GRACE_PERIOD` | `past_due` (entitlement retained, ≤14d) |
| `SUBSCRIPTION_STATE_ON_HOLD` | `past_due` (entitlement retained, ≤30d) — see product decision below |
| `SUBSCRIPTION_STATE_PAUSED` | `paused` |
| `SUBSCRIPTION_STATE_EXPIRED` | `canceled` |
| `SUBSCRIPTION_STATE_CANCELED` AND `expiryTime > now` | `active` + `cancelAtPeriodEnd = true` |
| `SUBSCRIPTION_STATE_CANCELED` AND `expiryTime <= now` | `canceled` (late-arriving event, period already over) |
| `SUBSCRIPTION_STATE_PENDING` | `incomplete` |

**Product decision (documented):** We honor entitlement for the entire Play `ON_HOLD` window (up to 30 days) and the full Apple `BILLING_RETRY` window. Rationale: Stripe's `past_due` Smart Retries treats users as active during retry, so source parity. If retention data shows abuse, we'll flip `ON_HOLD → unpaid` in v1.5 and revoke immediately.

`currentPeriodEnd`:
- Apple: `signedRenewalInfo.expiresDate` (ms epoch).
- Google: `lineItems[0].expiryTime` (ISO timestamp).

`pendingTier` / `pendingTierAt`:
- IAP v1 product choice: we don't offer in-app tier changes (user must cancel + re-purchase). Always `null` for `source !== "stripe"`.
- This is a product choice, NOT a platform limitation. Google Play Billing v6+ supports deferred upgrades via `SubscriptionUpdateParams` with `DEFERRED` replacement mode (the v2 response surfaces this via `lineItems[]` showing current + upcoming items). Apple expresses upgrade-within-group via `signedRenewalInfo.autoRenewProductId` differing from `signedTransactionInfo.productId`.
- v1.5 will populate `pendingTier` from both sources when we wire in-app upgrade flows.

`cancelAtPeriodEnd`:
- Apple: `signedRenewalInfo.autoRenewStatus === 0` AND `subscriptionStatus === SUBSCRIBED`.
- Google: explicit `subscriptionState === CANCELED` AND `expiryTime > now`.

**`cancellationReason` (NEW column, v1.5):** Apple distinguishes voluntary vs involuntary cancellation via `signedRenewalInfo.expirationIntent` (1=voluntary, 2=billing error, 3=price increase declined, 4=product unavailable). v1 collapses both flavors to `canceled` and loses this distinction. v1.5 will add a nullable `Subscription.cancellationReason` text column to support "your card failed, here's a one-tap return link" emails. **Out of scope for v1**, documented here so the future change is anticipated.

## 6. Apple-specific contract

- We require StoreKit 2 (iOS 15+, which `react-native-iap >= 12.x` supports natively). StoreKit 1 receipt-blob fallback is **out of scope** — the Expo dev client only supports devices new enough for StoreKit 2 anyway.
- Mobile derives `appAccountToken` deterministically from Fina `userId` via `uuidv5(userId, IAP_NAMESPACE)` where `IAP_NAMESPACE` is a hard-coded UUID constant in `@fina/shared/iap`. Deterministic derivation survives reinstalls without AsyncStorage state. Passed to `requestSubscription`. Server reads it from the verified transaction and stores it as `Subscription.sourceCustomerId`.
- For the App Store Server API JWT: we re-sign per call (5-min expiry) and cache in-memory for ~4 min. No persistence.
- Tax / VAT: Apple handles; we trust their `currency` field but display only the storefront's `localizedPrice` to the user.
- **Family Sharing boundary** (Family Sharing is OOS in §12): `apple-client.ts` MUST ignore notifications with `notificationType=DID_CHANGE_RENEWAL_STATUS` `subtype=PRODUCT_NOT_FOR_SALE` (Family Sharing revocation). Treat like a regular `EXPIRED` (status → `canceled`). Do not crash on the subtype.
- **ASC API roundtrip is a deliberate choice, not redundancy.** StoreKit 2's JWS technically contains everything we need for first-purchase validation, and ASSN V2 webhooks carry fresh JWS for renewals — so we could skip the `inApps/v1/transactions` round-trip and validate JWS-only. We choose the round-trip because: (a) symmetry with Google (which has no JWS-only path), (b) the support-tool / refund-lookup case eventually needs ASC anyway, (c) it gives a server-side timestamp anchor independent of the client-supplied JWS. The cost is an extra ASC API call per checkout + per webhook — bounded, fine for v1.

## 7. Google-specific contract

- Mobile uses `obfuscatedAccountId` (Fina userId, hashed via SHA-256 hex, max 64 chars per Google's limit). Server reads it back from `purchases.subscriptionsv2.get` → stores as `sourceCustomerId`.
- We use Subscriptions v2 (not v1) — single base plan per product for v1.
- **`linkedPurchaseToken` chain handling.** When a user upgrades/downgrades inside Play (or our future in-app tier-change flow uses `SubscriptionUpdateParams`), Google issues a NEW `purchaseToken` and references the prior one via `linkedPurchaseToken` in the v2 response. Naive keying on `purchaseToken` would create a duplicate `Subscription` row and trip the active-sub 409 guard. `google-client.ts` MUST, before any insert, check for `linkedPurchaseToken` and rewrite the existing row via `prisma.subscription.update({ where: { source_sourceSubscriptionId: { source: "iap_google", sourceSubscriptionId: linkedPurchaseToken } }, data: { sourceSubscriptionId: newToken, ... }})`. If the linked row doesn't exist (out-of-order delivery), fall through to upsert under the new token and rely on the eventually-consistent reconciliation by the next sync.
- Pub/Sub topic: `projects/{gcp-project}/topics/fina-iap-rtdn`. Configured in Play Console → Monetization setup. Push subscription with OIDC auth → our `/webhooks/iap/google` URL.
- **Acknowledgment is mandatory.** Every new subscription purchase MUST be acknowledged within 3 days or Google auto-refunds. Our flow:
  1. Mobile calls `requestSubscription` → receives purchase callback → does NOT call `finishTransaction` yet.
  2. Mobile POSTs `/billing/iap/checkout` with the purchase token.
  3. Server validates, upserts `Subscription`, calls `purchases.subscriptionsv2.acknowledge`, returns 2xx.
  4. Mobile only then calls `react-native-iap.finishTransaction({ isConsumable: false })` (which is a no-op for already-acknowledged subs — the server-side acknowledge already cleared the window).
  5. Every webhook re-acknowledges if `acknowledgementState === ACKNOWLEDGEMENT_STATE_PENDING` — idempotent safety net.
- Service account permissions: `androidpublisher.subscriptions.get` **and** `androidpublisher.subscriptions.update` (the latter is required by the acknowledge call — `.get` alone is insufficient).

## 8. Cross-source guard (Stripe ↔ IAP)

The existing `/billing/checkout` already 409s if any active sub exists. Symmetric guard in `/billing/iap/checkout` (§5.3 step 2). The remaining edge: **inbound webhook for a source while another source is also active** (rare — user paid both web + mobile within a small window). Resolution:

- Both subs are upserted normally.
- **Sandbox-environment filter:** `buildMeBody` and `effectiveTier` MUST exclude `Subscription` rows whose `environment === "Sandbox"` when `env.APPLE_ENV === "production"` (and the symmetric Google case via `environment` field on the row). Rationale: a developer who tested IAP in sandbox using their real Fina account leaves an `active`-sandbox row that would otherwise grant Pro entitlement in prod after launch. The `Subscription.environment` column is populated from the verified transaction's `environment` claim on every upsert (Apple) or from the v2 response's `regionCode` / sandbox flag (Google — derive at sync time). Stale sandbox rows are NOT garbage-collected by v1; they're treated as inactive in prod. This adds a column to `Subscription` (text, default `"Production"` for backfill).
- **Deterministic source preference in `buildMeBody`** (`apps/api/src/routes/billing.ts:23-68`): when multiple active subs exist (after the sandbox filter), **Stripe always wins regardless of tier**. Ordering rule: `source === "stripe"` first (any tier), then `(tier === "pro") > (tier === "lite")`, then `source === "iap_apple" > "iap_google"`, then `createdAt ASC`. Rationale: a user who originally signed up via Stripe must keep their Stripe Portal cancellation path. A cross-tier collision (Stripe-lite + IAP-pro, the case round-1 raised) currently shows the user the higher tier they're paying for *and* preserves the Stripe Manage Billing button — at the cost of the IAP-pro entitlement appearing as "lite" in the DTO. v1 product decision: that's acceptable for the rare double-purchase window. Support resolves which side to keep.
- The naive `find(pro) ?? activeSubs[0]` falls back to `currentPeriodEnd`-ordered first row — that's mid-month-flippable and breaks the `billingOwnedByMobile` gate in `more.tsx`. Stripe-first preserves the web cancel path.
- We log a `multi_source_active` warning per user when both `stripe` and `iap_*` subs are simultaneously active. Support task to reach out + ask which to keep.
- We do **not** auto-cancel either side: that's Apple/Google's `auto_renew = false` flow + the user's own action.

## 9. Pricing parity

- Per design §13.7: web `$7 / $15 CAD`, IAP `$6.99 / $14.99 CAD` (Apple/Google's nearest price tier).
- `libs/shared/src/pricing.ts` keeps `lite.monthlyCAD = 7` for web display. We do **not** add IAP price constants — mobile reads `localizedPrice` from `getSubscriptions()` so each storefront shows its own currency/symbol.
- Reader-app compliance: web never references IAP pricing. Mobile never deep-links to the web Stripe checkout. The hide-billing logic in `more.tsx` already enforces this in the opposite direction (mobile users on Stripe see no IAP UI).

## 10. Testing strategy

**Unit tests (Vitest):**
- `iap/apple-client.test.ts` — Mock fetch, verify JWT generation, verify status mapping for every state.
- `iap/google-client.test.ts` — Mock googleapis, verify status mapping.
- `iap/sync-sub.test.ts` — End-to-end with mocked `apple-client` / `google-client`. Covers: new purchase upsert, renewal (extends `currentPeriodEnd`), cancellation, refund (status → canceled), tier mismatch (productId says lite, validated says pro → 400 product_mismatch), user mismatch.
- `iap/webhook-verify.test.ts` — Apple ASSN signature happy/sad paths, Google OIDC happy/sad paths.

**Integration tests:**
- `routes/billing-iap.integration.test.ts` (lives under `apps/api/test/`) — Full Fastify inject with mocked store clients. Covers: checkout 409 when Stripe active, restore partial success, webhook dedup, webhook 4-step userId resolution (Subscription hit / User-binding hit / tombstone-200 / 500-fallback-then-cap), Google acknowledge invoked on every sync, `linkedPurchaseToken` chain rewrite, sandbox-env row excluded from `buildMeBody`, Stripe-always-wins precedence in multi-source scenarios.

**Manual (sandbox):**
- iOS: Apple sandbox tester accounts (App Store Connect → Users and Access → Sandbox Testers). Each developer needs their **own** sandbox tester — login state caches per device and team-sharing is not supported. Tests can be reset from device Settings.
- Android: License-test accounts (Play Console → Setup → License testing). Free trial cycle compresses to minutes in test mode.
- Both: webhook tunneling via Tailscale Funnel (same setup as Plaid).
- Both: requires a dev client build, NOT Expo Go (see §4 warning).

## 11. Operational setup

This is a checklist for whoever ships, not a code task:

**Apple (App Store Connect):**
1. Create products: `lite_monthly` (Auto-Renewable Subscription, $6.99 CAD), `pro_monthly` ($14.99 CAD). Subscription group: "Fina".
2. ASC API key (Users and Access → Keys → "+"). Role: Admin. Download .p8 once.
3. App Store Server Notifications V2: paste prod + sandbox webhook URLs (`https://api.fina.app/webhooks/iap/apple`).
4. Bundle ID, products, prices, screenshots — handled outside this design.

**Google (Play Console):**
1. Create subscription products with the same IDs.
2. Service account (Google Cloud → IAM → Service Accounts) → grant `androidpublisher.subscriptions.get` **and** `androidpublisher.subscriptions.update` (acknowledge needs `.update`). Download JSON key.
3. GCP project → Pub/Sub → create topic `fina-iap-rtdn`, push subscription to `https://api.fina.app/webhooks/iap/google`, OIDC auth with the same service account email.
4. Play Console → Monetization setup → paste the topic name.

Both: store credentials in Vercel env vars before flipping to production envs in `apps/api/src/env.ts`. `GOOGLE_SERVICE_ACCOUNT_JSON` should be base64-encoded — raw JSON is ~2.5 KB which is tight against Vercel's 4 KB per-var limit.

**Launch gates (manual smoke):**
1. App Store Server Notifications V2 endpoint configured in ASC before first sandbox purchase — Apple does not back-fill historical notifications.
2. First sandbox purchase round-trips successfully: client `requestSubscription` → server `/billing/iap/checkout` 2xx → `finishTransaction` → ASSN V2 webhook hits us within 60s.
3. Android first sandbox purchase: same round-trip, plus verify `acknowledgementState` flips from `PENDING` to `ACKNOWLEDGED` in the next webhook within minutes.
4. Both: confirm a force-cancel from the platform UI flips our `Subscription.status` within 60s via webhook.

**Credential rotation (postlaunch runbook):**
- ASC API key: issue new → update env var → revoke old (3-step).
- Pub/Sub OIDC service account: same.
- Document in the team runbook; not in this spec.

## 12. Out of scope (explicit)

- Annual plans (v1.5+).
- Family Sharing (notifications ignored — see §6).
- Promo offers / introductory offers configured via App Store Connect (we'll wire them in v1.5; v1 fails closed to `trialing` if accidentally attached).
- Server-side reconciliation cron (only added if drift complaints surface).
- In-app tier change (upgrade / downgrade) — v1 requires cancel + re-purchase. Wiring `pendingTier` for IAP deferred to v1.5.
- Cross-platform transfer (e.g., Apple → Google migration).
- Refund automation — refunds happen via Apple/Google; webhook flips `status=canceled` and that's enough for v1.
- `cancellationReason` column (voluntary vs involuntary cancel) — v1.5.
- Receipt audit logging beyond `WebhookEvent` dedup.
- `WebhookEvent` retention policy (existing table has none; IAP roughly doubles inflow, retention cron added if growth requires).
- StoreKit 1 fallback for iOS 14 and earlier.

## 12.1 Account deletion + GDPR retention

IAP subs **cannot** be canceled server-side — only the user via Apple Settings or Google Play. The existing account-deletion flow (if/when added) must, BEFORE confirming deletion:

1. Check if any active `iap_apple` / `iap_google` Subscription rows exist.
2. If so, show a blocking banner: "Cancel your subscription in [Apple Settings / Google Play] first. We can't cancel it for you." Deep-link to the platform's subscription UI.
3. After the user confirms ("I've canceled — delete anyway"):
   - Write an `IapDeletedBinding` row for each `User.iapAppleAccountToken` / `User.iapGoogleObfuscatedId` present (so webhooks know to stop retrying — see §5.3 webhook step 4.3).
   - **Retain** the `Subscription` rows. Null out `Subscription.sourceCustomerId` and any future PII-bearing fields, but keep the row itself with `userId` set to a tombstone marker or reassigned to a system "deleted users" sentinel (Prisma onDelete: SetNull or a dedicated sentinel row — implementer's choice).
   - GDPR Art. 17(3)(b) tax-retention exemption applies: subscription billing records are kept for **6 years** for Canadian CRA compliance (and to support Apple/Google refund-dispute audits). Hard-delete only after the retention window expires.
   - The user keeps paying Apple/Google until they actually cancel — that's not our system to control.

## 12.2 Account merge / userId migration

If two Fina accounts merge or a user's `userId` changes (account migration, identity provider switch), the IAP bindings do NOT transfer automatically. `User.iapAppleAccountToken` and `User.iapGoogleObfuscatedId` are deterministically derived from the **old** userId — they cannot be re-derived for the new userId from the same Apple/Google receipts.

v1 policy: **manual support ticket only**. There is no automated migration path. The runbook step:

1. Move all `Subscription` rows from `oldUserId` to `newUserId` (UPDATE … SET userId).
2. Clear `User.iapAppleAccountToken` / `User.iapGoogleObfuscatedId` on `newUserId` (set to NULL — never copy old values).
3. Write `IapDeletedBinding` rows for the old token values so any in-flight webhook for the old userId resolves correctly (tombstone path → 200).
4. On the next mobile session for `newUserId`, the Restore flow will fail with `user_mismatch` because the receipts carry `uuidv5(oldUserId)`. Support escalates: either tell the user to wait for their existing sub to expire and re-subscribe, or coordinate with Apple/Google to refund + re-issue.

This is **explicitly out of scope** for v1 self-service. Documented here so the support team and any future merge implementation know the constraints.

## 12.3 Webhook trust-chain (clarification)

The `expectedAppAccountToken` / `expectedObfuscatedAccountId` enforcement lives in `/billing/iap/checkout` step 3 (and the symmetric `/billing/iap/restore`). The **webhook path** does NOT re-verify the binding against the resolved userId, because:

1. If userId came from `Subscription.sourceSubscriptionId` lookup (step 4.1), the binding was already verified when that row was created (in checkout).
2. If userId came from `User.iap*` binding lookup (step 4.2), the verified-JWS / verified-Pub/Sub `appAccountToken` / `obfuscatedExternalAccountId` literally IS the binding — re-comparing it to `uuidv5(userId)` would be a tautology.

So the webhook trust chain is: signature-verified payload → token-via-binding → resolved userId. The mandatory binding check at checkout is the single entry-gate that authenticates the user→token relationship; downstream syncs trust it.

## 13. Open decisions (default = listed first)

None. All major decisions resolved during brainstorming. Sync strategy = webhook + restore (user confirmed).

---

## 14. Plan slice (preview of writing-plans output)

This spec slices into ~13 tasks. Order matters because of the shared-lib-first rule. Tasks marked `‖` are independent of each other and may execute in parallel under subagent-driven-development. The actual plan with code blocks lives in the next step.

1. **`@fina/shared` additions** — `iap/productIds.ts`, `iap/namespace.ts` (`IAP_NAMESPACE` UUID constant used by both server and mobile for deterministic `appAccountToken` derivation — pure constant, no behavior), `schemas/iap.ts` (IAPCheckoutBody, IAPRestoreBody), append IAP codes to `errors.ts` (`ApiErrorCode` union). Update existing `buildMeBody` precedence rules type-side if needed.
2. **Prisma migration** — add `User.iapAppleAccountToken` (unique) + `User.iapGoogleObfuscatedId` (unique) + `Subscription.environment` (default `"Production"`) + `IapDeletedBinding` model. Single migration, no data backfill needed beyond the column default.
3. **API env vars + redact config** — extend `env.ts` with all `APPLE_*` / `GOOGLE_*` vars, accept base64 `GOOGLE_SERVICE_ACCOUNT_JSON`, boot-time shape validation, Pino redact rules. `iap_not_configured` 503 guard helper.
4. **`apps/api/src/iap/apple-client.ts` + tests** ‖ — JWT signing, ASC API calls, JWS verification (six checks: alg, SPKI-pinned root, bundleId, environment, signedDate, appAccountToken), status mapping, Family Sharing subtype handling. APPLE_ENV → URL routing.
5. **`apps/api/src/iap/google-client.ts` + tests** ‖ — service-account auth, `subscriptionsv2.get`, `subscriptionsv2.acknowledge`, `linkedPurchaseToken` chain rewrite, status mapping (including ON_HOLD product decision, CANCELED+expiryTime check, intro-offer fail-closed).
6. **`apps/api/src/iap/webhook-verify.ts` + tests** — Apple ASSN JWS verification harness (reuses #4's checks), Google OIDC verification (audience + issuer + email + azp + exp + Pub/Sub subscription name).
7. **`apps/api/src/iap/sync-sub.ts` + tests** — `syncSubscriptionFromIAP(env, args, log)` where `args` is the discriminated-union shape defined in §5.2. Depends on slices #4, #5, #6. Tier from verified-transaction productId only. `expected*` token-match check is mandatory when supplied (checkout/restore) and skipped when absent (webhook — see §12.3). On first success writes the `User.iap*` binding column and stamps `Subscription.environment`. Returns upserted row.
8. **`buildMeBody` precedence fix** ‖ — update `apps/api/src/routes/billing.ts:36-37` to use `(tier, source, createdAt)` ordering. Unit test multi-active scenarios.
9. **Routes: `/billing/iap/checkout`, `/billing/iap/restore`** ‖ — integration tests cover 409 (Stripe+IAP cross-source), 403 (token mismatch), restore partial success, `product_mismatch` 400, mandatory acknowledge on Google (integration test asserts it runs).
10. **Webhook routes: `/webhooks/iap/apple`, `/webhooks/iap/google`** ‖ — scoped raw-body parser. Integration tests cover: signature happy/sad, dedup, **four-step userId resolution** (Subscription → User binding → `IapDeletedBinding` tombstone → 500-with-retry-cap), Android resubscribe-after-expiry path, Family Sharing notification ignored, sandbox-env row filter, post-cap 200-with-forensic-event behavior.
11. **Mobile: `react-native-iap` install + config plugin** — `apps/mobile/src/iap/client.ts`, `apps/mobile/src/api/billing.ts`. Deterministic `appAccountToken` / `obfuscatedAccountId` derivation. `IAP_NAMESPACE` constant lives in `@fina/shared/iap`. Document Expo Go limitation in repo CLAUDE.md.
12. **Mobile UI** — `/plan` picker (with empty-state fallback + Restore button), `/plan/restore` screen, More tab Restore row (gated on `billingOwnedByMobile`), updated Manage Billing deep-link with current-product sku derivation.
13. **End-to-end sandbox smoke** — manual checklist (in plan, not code). Covers the four launch gates in §11 (ASSN V2 endpoint set before first purchase, iOS round-trip, Android acknowledge round-trip, force-cancel reflection). The credential-rotation runbook in §11 is NOT part of this slice.
