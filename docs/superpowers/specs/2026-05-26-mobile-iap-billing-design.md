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

**New files:**

- `libs/shared/src/iap/productIds.ts` — single source of truth for product SKUs.
  ```ts
  export const IAP_PRODUCT_IDS = {
    lite_monthly: { tier: "lite",  billingPeriod: "monthly" },
    pro_monthly:  { tier: "pro",   billingPeriod: "monthly" },
  } as const;
  export type IAPProductId = keyof typeof IAP_PRODUCT_IDS;
  ```
- `libs/shared/src/dto/iap.ts` — DTOs + zod schemas for the IAP endpoints.
  ```ts
  export const IAPPlatform = z.enum(["ios", "android"]);
  export const IAPCheckoutBody = z.object({
    platform: IAPPlatform,
    productId: z.enum(["lite_monthly", "pro_monthly"]),
    // iOS: signedTransaction JWS string (StoreKit 2) OR legacy receipt
    // Android: purchaseToken
    transactionToken: z.string().min(1),
  });
  export const IAPRestoreBody = z.object({
    platform: IAPPlatform,
    purchases: z.array(z.object({
      productId: z.enum(["lite_monthly", "pro_monthly"]),
      transactionToken: z.string().min(1),
    })).min(1).max(20),
  });
  ```
- `libs/shared/src/dto/iap-errors.ts` — new error codes.
  ```ts
  export type IAPErrorCode =
    | "invalid_receipt"
    | "expired_receipt"
    | "product_mismatch"      // productId doesn't match validated receipt
    | "already_subscribed_stripe"   // user has active Stripe sub
    | "already_subscribed_iap"      // user already has active IAP sub (same source)
    | "user_mismatch"         // receipt belongs to another userId
    | "platform_unavailable"; // App Store / Play returned 5xx
  ```

**Subscription ID contract:**
- Apple: `Subscription.sourceSubscriptionId = originalTransactionId` ALWAYS. Never `transactionId` (which rotates per renewal). `originalTransactionId` is stable across renewals and is the subscription identity. The checkout route, the webhook handler, and `syncSubscriptionFromIAP` must all normalize to `originalTransactionId` before upserting — otherwise checkout-route and webhook target different rows and we get duplicate `Subscription` records per user.
- Google: `Subscription.sourceSubscriptionId = purchaseToken`. But the v2 response may carry `linkedPurchaseToken` after an in-Play tier change — see §7 for the chain-rewrite handling.

**Schema additions to `User` (one migration):**

```prisma
model User {
  // ...existing fields...
  iapAppleAccountToken    String?  @unique   // uuidv5(userId, IAP_NAMESPACE) — written on first successful Apple checkout
  iapGoogleObfuscatedId   String?  @unique   // sha256(userId) hex — written on first successful Google checkout
}
```

These columns are the **reverse-lookup binding** used by the webhook handlers to attribute a fresh purchase to a userId when the `Subscription` row doesn't exist yet (first-purchase race or Android resubscribe-after-expiry). They are written by `/billing/iap/checkout` after the verified-transaction check passes. Webhook does `prisma.user.findUnique({ where: { iapAppleAccountToken: ... } })` (or the Google equivalent) and creates the missing `Subscription` row in-place. Without this binding, an event whose corresponding checkout never lands (mobile crash, network mid-flight) drops on the floor permanently and the user is charged with no Fina record.

`Subscription.sourceCustomerId` continues to hold the same `appAccountToken` / `obfuscatedAccountId` per-row for forensic/dedup convenience; the `User.iap*` columns are the canonical user→token binding.

## 4. Mobile library + config

**Library:** `react-native-iap` (community standard; works under EAS Build with a config plugin shipped by the package). Rejected alternatives:
- `expo-in-app-purchases` — deprecated by Expo.
- `expo-iap` — newer fork, smaller community, less battle-tested.

**App config (`apps/mobile/app.json`):**
- iOS: `usesAppleSignIn` not required, but `expo.ios.bundleIdentifier` must match the Apple bundle ID configured in App Store Connect.
- Android: add `"BILLING"` permission via the config plugin (auto-injected).
- EAS profile: build with `eas build --profile production` after adding the StoreKit configuration for sandbox testing.

**Mobile units:**
- `apps/mobile/src/iap/client.ts` — thin wrapper around `react-native-iap` (init, getSubscriptions, requestSubscription, getAvailablePurchases, finishTransaction). All async-safe with `useEffect` cleanup.
- `apps/mobile/src/iap/types.ts` — re-exports `IAPProductId` + a `LocalProduct` shape (productId + tier + storefront localizedPrice + localizedTitle from the store, not from server).
- `apps/mobile/app/plan/index.tsx` — Plan picker screen: lists Lite/Pro from `getSubscriptions`, shows store-localized price, "Subscribe" button per product.
- `apps/mobile/app/plan/restore.tsx` — Restore Purchases screen with a single button + status text. Also reachable as a row in More → Subscription.
- `apps/mobile/src/api/billing.ts` — typed wrappers for the two new endpoints (`postIAPCheckout`, `postIAPRestore`).

**Subscription group in More tab:**
- Add a "Restore purchases" row below "Manage billing" (visible only when `billingOwnedByMobile`).
- "Manage billing" row deep-links to the platform's native subscription management (`https://apps.apple.com/account/subscriptions` for iOS, `https://play.google.com/store/account/subscriptions?package=...&sku=...` for Android). Per Apple guidelines we cannot host an in-app cancel UI for IAP subs.
- "Plan" row routes to `/plan` (picker) when `subscription === null`, otherwise to a read-only plan summary screen.

## 5. Backend additions

### 5.1 Env vars (`apps/api/src/env.ts`)

```
APPLE_BUNDLE_ID                 # com.fina.app — must match Xcode bundle id
APPLE_ASC_ISSUER_ID             # App Store Connect API issuer UUID
APPLE_ASC_KEY_ID                # ASC API key ID
APPLE_ASC_PRIVATE_KEY           # PEM string (base64-decoded at boot)
APPLE_ENV                       # sandbox | production
GOOGLE_PACKAGE_NAME             # app.fina (Play Console package name)
GOOGLE_SERVICE_ACCOUNT_JSON     # full JSON blob (single-line, escaped) for Play Developer API
GOOGLE_PUBSUB_VERIFY_AUDIENCE   # the audience claim we expect in Google's OIDC JWT (set when subscribing to Pub/Sub)
GOOGLE_PUBSUB_VERIFY_EMAIL      # the service account email we expect as `email` claim in the OIDC token
GOOGLE_PUBSUB_SUBSCRIPTION_NAME # full Pub/Sub subscription name (projects/.../subscriptions/...) — verified in the envelope to defend against a misconfigured second push pointing at our URL
```

All new vars optional (z.string().optional()) so dev/test envs without store credentials don't blow up. Use-site throws `HttpError(503, "iap_not_configured")` when consumer code runs without them (503 — service-not-configured semantics, not a generic 500).

**Boot-time validation + log redaction (required):**
- On boot, validate the shape of every IAP secret: `APPLE_ASC_PRIVATE_KEY` must contain `BEGIN PRIVATE KEY`; `GOOGLE_SERVICE_ACCOUNT_JSON` must JSON-parse and contain `client_email` + `private_key` keys. Fail loud at startup, not at first webhook.
- `GOOGLE_SERVICE_ACCOUNT_JSON` is accepted in either form: a single-line JSON string OR a base64-encoded JSON string. The loader tries base64-decode first (Vercel's 4 KB per-var limit is tight for raw JSON, base64 is safer). Document the canonical form as base64 in the env example.
- Extend the Pino logger `redact` config to cover: `APPLE_ASC_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, every nested `*.private_key`, `purchaseToken`, `signedTransactionInfo`, and `appAccountToken`. Without redaction, a stray `app.log.error({ env }, ...)` leaks long-lived store credentials to the log aggregator.
- Never serialize `app.fina.env` whole. If we ever need to print env for diagnostics, route it through a `redactEnv()` helper that strips the IAP secrets explicitly.

### 5.2 Modules (`apps/api/src/iap/`)

- `apple-client.ts` — Calls App Store Server API `inApps/v1/transactions/{transactionId}` + `inApps/v1/subscriptions/{originalTransactionId}` with JWT auth (JWT signed each call, 5-min expiry, cached). Exposes `verifyAndDecodeTransaction(jws): VerifiedAppleTransaction` which **fails closed** unless ALL of the following hold (the JWS body is decoded only after the cert chain verifies):
  1. JWS header `alg === "ES256"` (never `none`, never HS256, never RS256).
  2. The X5C cert chain terminates at Apple's WWDR root, **pinned by SPKI SHA-256 hash in code** (no runtime fetch).
  3. `bundleId === env.APPLE_BUNDLE_ID` — rejects valid JWS from any other app.
  4. `environment === env.APPLE_ENV` ("Production" or "Sandbox") — rejects sandbox JWS in prod (the "free Pro" exploit).
  5. `signedDate` within last 10 minutes for ASC-API responses; within last 1 hour for ASSN webhook payloads — bounds replay of captured/stored payloads.
  6. `appAccountToken` is present (not `undefined`). Without it we cannot bind to a Fina user, so reject — never bind to "whoever's session POSTed".
- `google-client.ts` — Calls Google Play Developer API `purchases.subscriptionsv2.get(packageName, token)` with service-account auth (googleapis lib). Returns the v2 SubscriptionPurchaseV2 shape. **Also calls `purchases.subscriptionsv2.acknowledge` after every successful upsert when the validated `acknowledgementState === ACKNOWLEDGEMENT_STATE_PENDING`** — Google auto-refunds and revokes the purchase if not acknowledged within 3 days. The call is idempotent so we run it on every sync (initial + webhook). Acknowledge failure is non-fatal (logged + retried on next webhook), but acknowledge MUST run **after** the local upsert lands so we never acknowledge a purchase we couldn't record.
- `pricing-map.ts` — Maps `productId → tier` from `IAP_PRODUCT_IDS` (single import from @fina/shared).
- `sync-sub.ts` — Mirror of `apps/api/src/stripe/sync-sub.ts`. Signature: `syncSubscriptionFromIAP(env, args, userId, log)`. Takes either Apple (`{platform: "ios", originalTransactionId}`) or Google (`{platform: "android", productId, purchaseToken}`). Re-fetches from the store, normalizes status (see §5.4), upserts.
- `webhook-verify.ts` — Apple ASSN V2 JWS verification + Google RTDN OIDC token verification.

### 5.3 Routes

**`POST /billing/iap/checkout`** — Authenticated. Body: `IAPCheckoutBody`. Flow:
1. `requireSession`, load user.
2. Check `prisma.subscription.count` for active subs (matching `ACTIVE_SUBSCRIPTION_STATUSES`):
   - any active Stripe sub → 409 `already_subscribed_stripe`.
   - any active IAP sub → 409 `already_subscribed_iap`.
3. Call `syncSubscriptionFromIAP({platform, productId, transactionToken, userId, expectedAppAccountToken: uuidv5(userId, IAP_NAMESPACE), expectedObfuscatedAccountId: sha256(userId)})`. The sync function MUST 403 `user_mismatch` if the verified transaction's `appAccountToken` (iOS) or `obfuscatedAccountId` (Android) does NOT equal the expected value derived from the caller's session — this is the attacker-binds-someone-else's-receipt defense. The check is mandatory, not optional.
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
   3. Still unknown → return **500** (NOT 200). Apple retries up to 5x over 3 days, giving `/billing/iap/checkout` time to land. Returning 200-and-drop silently loses the user's purchase forever if their client never reconnects. Cap log noise via per-`appAccountToken` counter.
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
   3. Still unknown → return **500** (NOT 200). Pub/Sub retries per the subscription's retry policy. Cap log noise via per-`obfuscatedExternalAccountId` counter.
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
- **Deterministic source preference in `buildMeBody`** (`apps/api/src/routes/billing.ts:23-68`): when multiple active subs exist, pick by `(tier === "pro") > (tier === "lite")` first, then break ties by `source === "stripe" > "iap_apple" > "iap_google"`, then by `createdAt ASC`. The naive `find(pro) ?? activeSubs[0]` falls back to `currentPeriodEnd`-ordered first row — that's mid-month-flippable and breaks the `billingOwnedByMobile` gate in `more.tsx`. Stripe-first tiebreak means a user who has both keeps the web Stripe UX they originally signed up under.
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
- `routes/billing-iap.integration.test.ts` (lives under `apps/api/test/`) — Full Fastify inject with mocked store clients. Covers: checkout 409 when Stripe active, restore partial success, webhook dedup, webhook unknown originalTransactionId path.

**Manual (sandbox):**
- iOS: Apple sandbox tester accounts (App Store Connect → Users and Access → Sandbox Testers). One per env; tests can be reset.
- Android: License-test accounts (Play Console → Setup → License testing). Free trial cycle compresses to minutes in test mode.
- Both: webhook tunneling via Tailscale Funnel (same setup as Plaid).

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

Both: store credentials in Vercel env vars before flipping to production envs in `apps/api/src/env.ts`.

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

## 12.1 Account deletion + GDPR

IAP subs **cannot** be canceled server-side — only the user via Apple Settings or Google Play. The existing account-deletion flow (if/when added) must, BEFORE confirming deletion:

1. Check if any active `iap_apple` / `iap_google` Subscription rows exist.
2. If so, show a blocking banner: "Cancel your subscription in [Apple Settings / Google Play] first. We can't cancel it for you." Deep-link to the platform's subscription UI.
3. Only after the user confirms ("I've canceled — delete anyway") do we proceed with row deletion. We null out `Subscription.sourceCustomerId` and drop the row; the user keeps paying Apple/Google until they actually cancel.

This is a UX contract for the account-deletion flow (whenever that's built), not a v1 IAP feature. Documented here so the IAP and account-deletion teams don't ship in isolation.

## 13. Open decisions (default = listed first)

None. All major decisions resolved during brainstorming. Sync strategy = webhook + restore (user confirmed).

---

## 14. Plan slice (preview of writing-plans output)

This spec slices into roughly 10 tasks. Order matters because of the shared-lib-first rule. The actual plan with code blocks lives in the next step.

1. `@fina/shared` IAP types + DTOs (productIds, IAPCheckoutBody, IAPRestoreBody, IAPErrorCode).
2. API env vars + `iap-not-configured` guard.
3. `iap/pricing-map.ts` + tests.
4. `iap/apple-client.ts` + tests (JWT signing, status mapping).
5. `iap/google-client.ts` + tests (service-account auth, status mapping).
6. `iap/sync-sub.ts` + tests (upsert, status mapping, cross-source 409 helper).
7. `iap/webhook-verify.ts` + tests (Apple JWS, Google OIDC).
8. Routes: `/billing/iap/checkout`, `/billing/iap/restore` + integration tests.
9. Webhook routes: `/webhooks/iap/apple`, `/webhooks/iap/google` + integration tests.
10. Mobile: `react-native-iap` install + config plugin, `src/iap/client.ts`, `src/api/billing.ts` IAP methods.
11. Mobile UI: `/plan` picker, `/plan/restore`, More tab Restore row.
12. End-to-end smoke (sandbox) — checklist in plan, not code.
