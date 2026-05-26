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

**No schema changes.** `enum SubscriptionSource { stripe iap_apple iap_google }` and `Subscription` model already support IAP (added in earlier plan as future-proofing). `Subscription.sourceCustomerId` will hold `appAccountToken` (iOS) or `obfuscatedAccountId` (Android) — both are UUIDs we generate per user to bind purchases to our `userId`.

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
```

All new vars optional (z.string().optional()) so dev/test envs without store credentials don't blow up. Use-site throws `HttpError(500, "iap_not_configured")` when consumer code runs without them.

### 5.2 Modules (`apps/api/src/iap/`)

- `apple-client.ts` — Calls App Store Server API `inApps/v1/transactions/{transactionId}` + `inApps/v1/subscriptions/{originalTransactionId}` with JWT auth (JWT signed each call, 5-min expiry, cached). Verifies `signedTransactionInfo` JWS using Apple's root certs.
- `google-client.ts` — Calls Google Play Developer API `purchases.subscriptionsv2.get(packageName, token)` with service-account auth (googleapis lib). Returns the v2 SubscriptionPurchaseV2 shape.
- `pricing-map.ts` — Maps `productId → tier` from `IAP_PRODUCT_IDS` (single import from @fina/shared).
- `sync-sub.ts` — Mirror of `apps/api/src/stripe/sync-sub.ts`. Signature: `syncSubscriptionFromIAP(env, args, userId, log)`. Takes either Apple (`{platform: "ios", originalTransactionId}`) or Google (`{platform: "android", productId, purchaseToken}`). Re-fetches from the store, normalizes status (see §5.4), upserts.
- `webhook-verify.ts` — Apple ASSN V2 JWS verification + Google RTDN OIDC token verification.

### 5.3 Routes

**`POST /billing/iap/checkout`** — Authenticated. Body: `IAPCheckoutBody`. Flow:
1. `requireSession`, load user.
2. Check `prisma.subscription.count` for active subs (matching `ACTIVE_SUBSCRIPTION_STATUSES`):
   - any active Stripe sub → 409 `already_subscribed_stripe`.
   - any active IAP sub → 409 `already_subscribed_iap`.
3. Call `syncSubscriptionFromIAP(env, {platform, productId, transactionToken}, userId)`.
4. If validation fails → 400 with the IAPErrorCode.
5. Return `buildMeBody(userId)` — same shape `/billing/sync` returns.

**`POST /billing/iap/restore`** — Authenticated. Body: `IAPRestoreBody`. Flow:
1. `requireSession`, load user.
2. For each purchase: call `syncSubscriptionFromIAP` with `userId`. Skip (log + continue) on individual failures so partial restores succeed.
3. Cross-source guard: if **any** purchase belongs to a different user (per `appAccountToken` / `obfuscatedAccountId` mismatch), return 403 `user_mismatch` for that one and continue with the rest.
4. Return `buildMeBody(userId)`.

**`POST /webhooks/iap/apple`** — Unauthenticated (signature-verified). Per ASSN V2:
1. Parse `signedPayload` (JWS). Verify with Apple's X5C cert chain → Apple root.
2. Extract `notificationUUID` → dedup against `WebhookEvent` (id = "apple:" + notificationUUID; source = "iap_apple").
3. Extract `signedTransactionInfo.originalTransactionId`.
4. Resolve userId via `Subscription.findFirst({ where: { source: "iap_apple", sourceSubscriptionId: originalTransactionId }})`. If unknown (first-purchase race), log + return 200 — the client-driven `/billing/iap/checkout` will create the row on retry.
5. Call `syncSubscriptionFromIAP({platform: "ios", originalTransactionId}, userId)`.
6. Record `WebhookEvent` after handler succeeds (same pattern as Stripe webhook).
7. On handler exception → 500 (Apple retries up to 5x over 3 days). On signature failure → 400 (no retry).

**`POST /webhooks/iap/google`** — Unauthenticated (Pub/Sub OIDC + signature). Per RTDN:
1. Verify OIDC bearer token in `Authorization` header. Audience must match `GOOGLE_PUBSUB_VERIFY_AUDIENCE`; issuer must be `https://accounts.google.com`; email must equal the configured Pub/Sub service account.
2. Pub/Sub envelope: `{message: {data: base64, messageId, ...}}`. Decode + parse the inner JSON: `{subscriptionNotification: {purchaseToken, subscriptionId, notificationType}}`.
3. Dedup via `WebhookEvent` (id = "google:" + messageId).
4. Resolve userId from `Subscription` row keyed on `(source: iap_google, sourceSubscriptionId: purchaseToken)`. If unknown → 200 + log (first-purchase race).
5. Call `syncSubscriptionFromIAP({platform: "android", productId: subscriptionId, purchaseToken}, userId)`.
6. Record `WebhookEvent` after handler succeeds. On handler exception → 500 (Pub/Sub retries per subscription's ack-deadline + retry policy).

### 5.4 Status mapping

Apple App Store Server API → `SubscriptionStatus`:
| ASSN/ASS API state | Our enum |
|---|---|
| `SUBSCRIBED` (no `expires_date` in past) | `active` |
| `SUBSCRIBED` + trial period | `trialing` |
| `BILLING_RETRY` / grace period | `past_due` |
| `EXPIRED` (voluntary or involuntary) | `canceled` |
| `REVOKED` (refunded) | `canceled` |
| `PAUSED` | `paused` |

Google `SubscriptionPurchaseV2.subscriptionState`:
| Google state | Our enum |
|---|---|
| `SUBSCRIPTION_STATE_ACTIVE` | `active` |
| `SUBSCRIPTION_STATE_IN_GRACE_PERIOD` | `past_due` |
| `SUBSCRIPTION_STATE_ON_HOLD` | `past_due` |
| `SUBSCRIPTION_STATE_PAUSED` | `paused` |
| `SUBSCRIPTION_STATE_EXPIRED` | `canceled` |
| `SUBSCRIPTION_STATE_CANCELED` (still in current period) | `active` + `cancelAtPeriodEnd = true` |
| `SUBSCRIPTION_STATE_PENDING` | `incomplete` |

`currentPeriodEnd`:
- Apple: `signedRenewalInfo.expiresDate` (ms epoch).
- Google: `lineItems[0].expiryTime` (ISO timestamp).

`pendingTier` / `pendingTierAt`: IAP v1 doesn't expose tier changes the way Stripe Subscription Schedules do (users cancel + buy a new product). Always `null` for `source !== "stripe"`.

`cancelAtPeriodEnd`:
- Apple: `signedRenewalInfo.autoRenewStatus === 0` AND `subscriptionStatus === SUBSCRIBED`.
- Google: explicit `subscriptionState === CANCELED`.

## 6. Apple-specific contract

- We require StoreKit 2 (iOS 15+, which `react-native-iap >= 12.x` supports natively). StoreKit 1 receipt-blob fallback is **out of scope** — the Expo dev client only supports devices new enough for StoreKit 2 anyway.
- Mobile derives `appAccountToken` deterministically from Fina `userId` via `uuidv5(userId, IAP_NAMESPACE)` where `IAP_NAMESPACE` is a hard-coded UUID constant in `@fina/shared/iap`. Deterministic derivation survives reinstalls without AsyncStorage state. Passed to `requestSubscription`. Server reads it from the verified transaction and stores it as `Subscription.sourceCustomerId`.
- For the App Store Server API JWT: we re-sign per call (5-min expiry) and cache in-memory for ~4 min. No persistence.
- Tax / VAT: Apple handles; we trust their `currency` field but display only the storefront's `localizedPrice` to the user.

## 7. Google-specific contract

- Mobile uses `obfuscatedAccountId` (Fina userId, hashed via SHA-256 hex, max 64 chars per Google's limit). Server reads it back from `purchases.subscriptionsv2.get` → stores as `sourceCustomerId`.
- We use Subscriptions v2 (not v1) — single base plan per product for v1.
- Pub/Sub topic: `projects/{gcp-project}/topics/fina-iap-rtdn`. Configured in Play Console → Monetization setup. Push subscription with OIDC auth → our `/webhooks/iap/google` URL.
- Service account permissions: `androidpublisher.subscriptions.get` only — least privilege.

## 8. Cross-source guard (Stripe ↔ IAP)

The existing `/billing/checkout` already 409s if any active sub exists. Symmetric guard in `/billing/iap/checkout` (§5.3 step 2). The remaining edge: **inbound webhook for a source while another source is also active** (rare — user paid both web + mobile within a small window). Resolution:

- Both subs are upserted normally. `buildMeBody` picks `pro > lite > first`, so the user sees their highest entitlement and isn't penalized.
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
2. Service account (Google Cloud → IAM → Service Accounts) → grant `androidpublisher.subscriptions.get`. Download JSON key.
3. GCP project → Pub/Sub → create topic `fina-iap-rtdn`, push subscription to `https://api.fina.app/webhooks/iap/google`, OIDC auth with the same service account email.
4. Play Console → Monetization setup → paste the topic name.

Both: store credentials in Vercel env vars before flipping to production envs in `apps/api/src/env.ts`.

## 12. Out of scope (explicit)

- Annual plans (v1.5+).
- Family Sharing.
- Promo offers / introductory offers configured via App Store Connect (we'll wire them in v1.5).
- Server-side reconciliation cron (only added if drift complaints surface).
- Cross-platform transfer (e.g., Apple → Google migration).
- Refund automation — refunds happen via Apple/Google; webhook flips `status=canceled` and that's enough for v1.
- Receipt audit logging beyond `WebhookEvent` dedup.
- StoreKit 1 fallback for iOS 14 and earlier.

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
