# Architecture Review — Mobile IAP Billing Design

**Reviewer role:** Architecture / design reviewer
**Spec under review:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
**Date:** 2026-05-26

---

## Summary

Overall the design is solid and well-grounded in the existing Stripe pattern. The "shared-lib-first" + `syncSubscriptionFromIAP` mirror of `syncSubscriptionFromStripe` is the right shape, the `Subscription` schema genuinely accommodates IAP without migration, and the cross-source guard story is plausible. There are, however, several real bugs in store-API contract details (Apple "originalTransactionId" vs "transactionId" semantics, Google `linkedPurchaseToken` upgrade/downgrade chain, RTDN payload shape), one underspecified consequence in §8, and a few NIT-level naming / placement issues. The decomposition into 12 slices is on the high end but not unreasonable. I recommend **APPROVE WITH CHANGES** — none of the findings invalidates the overall architecture, but the Apple/Google contract details should be tightened before code is written so we don't bake the bugs into tests.

---

## 1. Architecture soundness

### Data flow & upsert key
- **GOOD** — Keying the upsert on `(source, sourceSubscriptionId)` via the existing `@@unique([source, sourceSubscriptionId])` in `schema.prisma:705` matches Stripe's pattern exactly. Re-using `syncSubscriptionFromStripe`'s "always re-fetch from the store, never trust the webhook payload" rule (`sync-sub.ts:17-26`) is exactly the right choice for IAP because Apple/Google webhooks have weaker ordering guarantees than Stripe.

- **BUG (Apple): `sourceSubscriptionId` semantic is ambiguous.** Apple has two distinct IDs:
  - `transactionId` — unique per individual transaction (renewal, restore, refund all produce different ones).
  - `originalTransactionId` — the stable "subscription identity" that survives renewals.

  The spec mixes both. §3 mentions `transactionId` in `IAPCheckoutBody`. §5.3 step 4 (Apple webhook) correctly uses `originalTransactionId`. §6 doesn't say which one becomes `Subscription.sourceSubscriptionId`. **This needs an explicit statement: `sourceSubscriptionId = originalTransactionId` for Apple.** Otherwise the checkout-route upsert and the webhook upsert will target *different* rows and you'll get duplicate `Subscription` records per user.

  Suggestion: rename `IAPCheckoutBody.transactionId` (does not currently appear — body has `transactionToken`; OK) and have `apple-client.ts` always normalize to `originalTransactionId` before returning. Document this contract in §5.2 next to `apple-client.ts`.

- **BUG (Google): purchase-token upgrade/downgrade chain not handled.** When a Google user upgrades/downgrades through Play (`replaceWith`/proration flow), Google issues a **new `purchaseToken`** and references the previous one via `linkedPurchaseToken` in the v2 response. The spec keys `Subscription.sourceSubscriptionId` on `purchaseToken` (§5.3 step 4 of the google webhook), which means an in-Play tier change will create a *second* `Subscription` row rather than mutating the existing one. Both rows can be active simultaneously for several minutes (until the old one expires), and `buildMeBody` will then pick the highest, but `Subscription.count({where: active})` in the §5.3 step 2 409-guard will trip every time the user changes plan in Play.

  Suggestion in §5.2 `google-client.ts`: when the v2 response carries `linkedPurchaseToken`, do `prisma.subscription.update({ where: { source_sourceSubscriptionId: { source: "iap_google", sourceSubscriptionId: linkedPurchaseToken } }, data: { sourceSubscriptionId: newToken, ... }})`. Either that, or scope the active-sub check to `(source, userId, sourceCustomerId)` and let two rows coexist briefly. Either is fine, but it has to be called out explicitly. (Annual upgrade is OOS in v1, but **tier change Lite→Pro within IAP is not OOS** — actually the spec doesn't say. Probably worth a sentence.)

- **CONSIDER: `Subscription.billingPeriod` is hard-coded "monthly".** The Stripe `sync-sub.ts:98` already hard-codes "monthly". The IAP spec implicitly does too (single `*_monthly` SKU). Fine for v1, but the `pricing-map.ts` shape `{tier, billingPeriod}` invites confusion. Suggest dropping `billingPeriod` from `IAP_PRODUCT_IDS` until annual lands, or storing it explicitly into `Subscription.billingPeriod` so future annual SKUs don't need a schema migration to round-trip.

### Schema fit — `pendingTier`, `sourceCustomerId`
- **GOOD** — `sourceCustomerId` reuse for `appAccountToken` / `obfuscatedAccountId` is clean. The existing `String?` shape works.
- **GOOD** — `pendingTier` correctly stays `null` for IAP (§5.4). Stripe-specific Schedule logic in `syncSubscriptionFromStripe:54-80` is untouched.
- **CONSIDER** — Document that `Subscription.sourceCustomerId` is **non-unique** for IAP (multiple users could in principle generate the same `obfuscatedAccountId` if SHA-256 collided — won't, but the schema doesn't enforce). Stripe path already keeps this column non-unique because `User.stripeCustomerId` carries the unique constraint. No action required.

---

## 2. Coverage gaps

### Trials / introductory offers
- **CONSIDER** — §5.4 maps `SUBSCRIBED + trial` → `trialing`, which is correct, but introductory offers (Apple "Free trial" / "Pay as you go" / "Pay up front" offer types, Google "Free trial" / "Intro price") are listed OOS in §12. That's fine for v1, **but** Apple App Store Connect requires that ALL auto-renewable subs be set up with at least a base plan that may *optionally* include a free trial offer, and reviewers sometimes auto-attach a trial to the product. If we accidentally enable one in ASC, the spec says nothing about whether our code handles `SUBSCRIBED + offerType=introductory` correctly. **Recommend** explicit "fail closed" — if `signedRenewalInfo.offerType != null` and we don't recognize it, log + still set `trialing`. The current §5.4 mapping already does this implicitly (anything with a trial period → `trialing`), so just call it out.

### Grace period vs billing retry
- **GOOD** — Apple `BILLING_RETRY` → `past_due` matches the Stripe pattern. Google `IN_GRACE_PERIOD` and `ON_HOLD` both → `past_due` is fine, but Google's lifecycle is actually:
  - `IN_GRACE_PERIOD` — entitlement still granted (user keeps access while Play retries).
  - `ON_HOLD` — entitlement REVOKED for up to 30 days (user does NOT have access).

  Treating them identically as `past_due` (which is in `ACTIVE_SUBSCRIPTION_STATUSES` per `dto/subscription.ts:16-20`) means **`ON_HOLD` users keep Pro/Lite entitlement** for the full 30-day hold. This may or may not be intended — Stripe's `past_due` Smart Retries window is shorter (~3 weeks). Worth a sentence in §5.4 confirming the product decision: "We honor entitlement during the entire Play `ON_HOLD` window (≤30d) and during Apple `BILLING_RETRY`." If the answer is "no, revoke immediately on hold," map `ON_HOLD` → `unpaid`.

### User-initiated resume after expiry
- **MISSING** — When an iOS user re-subscribes after expiry via "Resubscribe" in Apple's UI, Apple issues a notification with `notificationType = DID_RECOVER` (or `SUBSCRIBED` with `subtype=RESUBSCRIBE`). The spec §5.3 step 4 says "If unknown (first-purchase race), log + return 200." That's OK for *brand-new* purchases — the client's `/billing/iap/checkout` will catch up. But for resubscribe-after-expiry, **there's no client roundtrip** (the user resubscribed from Settings, not from the app), so the row is already in the DB (status=`canceled`) and the webhook *will* find it via `originalTransactionId`. Re-syncing will flip it back to `active`. **This is fine and works**, but the spec should call it out explicitly so it isn't accidentally broken later. NIT, not a bug.

  For Android: resubscribe issues a brand-new `purchaseToken`, so it looks like a first purchase. Without the client roundtrip (user resubscribed from Play Store), the §5.3 step 4 google-webhook fallback "log + return 200" *drops the event*. The user will keep showing as `canceled` until they next open the app and we run a `restore`. **This is a real coverage gap for Android resubscribe.** Suggestions:
  - When `Subscription` row is unknown but `sourceCustomerId` (obfuscatedAccountId = SHA-256 of userId) matches an existing user, attribute & upsert anyway. (Cleanest.)
  - Or rely on the app calling `/billing/iap/restore` on next launch (acceptable but stale).

### Refund / chargeback semantics
- **NIT** — Apple `REVOKED` → `canceled` is correct (§5.4). But the spec doesn't say anything about *Family Sharing revocation* (`subtype=PRODUCT_NOT_FOR_SALE`) vs *refund revocation* (`subtype=REFUNDED_DUE_TO_ISSUE`). Family Sharing is OOS in §12 — make sure `apple-client.ts` ignores or treats Family Sharing notifications the same as a regular cancel. This is the boundary cleanliness §1 concern.

### "First-purchase race" between webhook and checkout
- **GOOD** — Both webhook routes handle the race correctly (return 200, defer to checkout). The retry semantics (Apple retries up to 5x over 3 days; Pub/Sub retries per ack-deadline) cover the gap.
- **CONSIDER** — Spec says "log + return 200" but the Pub/Sub *ack* of a 200 means Google never re-delivers. If the user's checkout call never lands (mobile killed mid-flight, network died after Apple/Play charged), the row never appears. We should either:
  - Return 5xx from the webhook for unknown originalTransactionId/purchaseToken, letting the store retry. The retry window is wide enough that the client will usually have caught up.
  - Or persist a "pending" `WebhookEvent` and a reconciliation cron walks it back. §12 says no reconciliation cron — fine, but then 200-and-drop is risky.

  Recommend changing §5.3 step 4 to **return 5xx (or 200 with a poison-message-counter)** if `sourceCustomerId` (obfuscatedAccountId / appAccountToken) is also unattributable. The trade-off is store-side retries hammering us, but they're bounded.

---

## 3. Decomposition

- **GOOD overall** — Twelve slices is on the high end, but most are real units with discrete tests. The shared-lib-first rule is honored (#1 first).
- **CONSIDER merging:** Slice #4 (`apple-client`) and #5 (`google-client`) could ship in parallel rather than sequentially since they share no code. Same for slice #8 (checkout/restore routes) and #9 (webhook routes). If executing in a single session, that's irrelevant; if dispatched as parallel agents, the spec should flag that #4/#5 and #8/#9 are independent.
- **NIT:** Slice #2 (env vars + `iap_not_configured` guard) is so small it could fold into #4/#5 (each client owns its env-var subset). Splitting it out is defensible for review checkpointing — leave it.
- **MISSING SLICE:** Nothing for adding `IAPErrorCode` strings to `libs/shared/src/errors.ts:8` `API_ERROR_CODES`. The spec adds them in `libs/shared/src/dto/iap-errors.ts` as a new type, but the existing `ApiError.code` type is `ApiErrorCode | http_${number}` (errors.ts:95). If IAP routes return codes that aren't in `API_ERROR_CODES`, the existing `isApiError` consumers in mobile will get type-narrowing surprises (or any frontend switch-exhaustive check fails). **Add the IAP error codes to `errors.ts` too** (and don't create a separate `iap-errors.ts` file — just append). This is a non-trivial divergence from the codebase convention; flagging as a **NIT** but it's real.

---

## 4. Naming + API shape

- **NIT — Route name asymmetry.** Existing pattern is `/billing/checkout` and `/billing/portal` (no source prefix because Stripe is implicit). The spec adds `/billing/iap/checkout` and `/billing/iap/restore`. That's *correct* — disambiguating by source is right — but it implies the Stripe routes should arguably move to `/billing/stripe/checkout` for symmetry. **Don't do that** (breaking change), but a sentence noting the asymmetry would help future readers.

- **NIT — Body field name.** §3 uses `transactionToken` to mean both "iOS JWS string" and "Android purchaseToken". OK, but `transactionToken` reads like a single opaque value; a future reviewer will be confused that on iOS it's a 2-3 KB signed JWS. Suggest renaming to `receipt: string` (industry term covering both) or document the per-platform shape on the zod schema with `.describe()`.

- **NIT — DTO file naming.** `libs/shared/src/dto/iap.ts` exports request bodies, but the existing pattern uses `libs/shared/src/schemas/billing.ts` for request bodies (checked: `schemas/billing.ts` holds `CheckoutBody`, `SyncBody`). Request bodies belong in `schemas/`, response DTOs in `dto/`. The spec's `libs/shared/src/dto/iap.ts` should be `libs/shared/src/schemas/iap.ts`. The `dto/` directory should only hold the `SubscriptionDTO`-style response wire types (which IAP already reuses — no new DTO needed).

- **NIT — Product ID config location.** `libs/shared/src/iap/productIds.ts` is fine, but `pricing-map.ts` is the existing pattern (Stripe has `apps/api/src/stripe/pricing-map.ts`). Either rename the new module to `libs/shared/src/iap/pricing-map.ts` to match, or move the IAP equivalent to `apps/api/src/iap/pricing-map.ts` (which the spec already does in §5.2 — but then it duplicates the constant from `@fina/shared/iap/productIds`). Cleanest: keep one source of truth in `@fina/shared` and have the API import it directly with no second pricing-map file. Spec implies this; just make it explicit in the plan.

- **GOOD** — `WebhookEvent` id format `"apple:" + notificationUUID` and `"google:" + messageId` is a fine convention. Stripe currently uses raw `evt_...` IDs. The prefix avoids any chance of collision, and the `source` column disambiguates anyway. No change.

- **CONSIDER** — `SubscriptionSource` is a Prisma enum (`schema.prisma:252-256`) AND a TypeScript union in `dto/subscription.ts:23`. Stripe webhook stores `"stripe"` and the prisma enum already lists `iap_apple` / `iap_google`. Spec §3 says "no schema changes" — correct, the values exist. Good.

---

## 5. Mobile UX & store guidelines

- **GOOD** — §4 "Manage billing" deep-links to platform-native subscription management. This is mandated by Apple guideline 3.1.2 and Play policy. Cannot host in-app cancel UI.

- **BUG-ISH: Plan picker UX (§4).** When `subscription === null` AND `tier === "free"` (trial expired), the user lands on the plan picker. Fine. But the picker uses `getSubscriptions` from `react-native-iap` which requires the products to be configured + approved in ASC/Play Console *and* the user to have a valid sandbox/license-test account. If anything is misconfigured, `getSubscriptions` returns an empty array and the user sees a blank screen with no error. **Recommend** the picker include a `react-native-iap` connection-status fallback: if products aren't fetched, show an inline "Subscriptions aren't available right now — try again later" + a Stripe-web sign-up link on iOS would be a guideline violation, so leave it as just the error message. Add this to slice #11.

- **NIT — Restore Purchases discoverability.** Apple guideline 3.1.1 requires "a way to restore previous purchases is clearly visible." The spec adds a "Restore purchases" row only "below Manage billing (visible only when `billingOwnedByMobile`)." That visibility check excludes Stripe-on-web users — which is correct, they have no IAP to restore. But it ALSO excludes new mobile users who haven't yet purchased anything; if they bought on a previous install and reinstall, they'd land on the plan picker (`subscription === null`) and need to restore. **Solution:** show "Restore purchases" *always* on the plan picker screen (`/plan/index.tsx`) as well as in More. The plan-picker placement is the one Apple actually checks for.

- **NIT — Apple subscription management URL.** `https://apps.apple.com/account/subscriptions` is correct as a generic link, but Apple has a deeper deep-link `itms-apps://apps.apple.com/account/subscriptions` (no preview). The `https://` form works (opens App Store). No action.

- **CONSIDER — Google's cancellation deep-link with `package` + `sku`** (§4): the URL `https://play.google.com/store/account/subscriptions?package=...&sku=...` is right but **`sku` requires the *exact current* productId**. If the user has `lite_monthly` but we hard-code `sku=pro_monthly`, the deep link 404s. The spec doesn't say where the current productId comes from at click time. Suggest: derive from `me.subscription.tier` → map back to productId. Trivial, but worth specifying.

---

## 6. Cross-source coexistence

§8 reads:
> Both subs are upserted normally. `buildMeBody` picks `pro > lite > first`, so the user sees their highest entitlement and isn't penalized.

- **GOOD intent** — defensible: "highest tier wins" preserves UX and avoids double-billing-induced rage cancellation.

- **BUG — `buildMeBody` doesn't actually do what §8 claims.** Look at `billing.ts:36-37`:
  ```ts
  const primary = activeSubs.find((s) => s.tier === "pro") ?? activeSubs[0];
  ```
  When a user has one Stripe `pro` + one IAP `pro` simultaneously, the picker chooses `activeSubs[0]` — first in `orderBy: { currentPeriodEnd: "desc" }`. So `subscription.source` and `subscription.cancelAtPeriodEnd` reflect whichever sub has the later period end, **not deterministically Stripe vs IAP**. That's a footgun for §4's "billingOwnedByMobile" gating: a Stripe user who fat-fingered an extra IAP purchase will suddenly see the IAP Restore/Manage UI flip in More tab. Then their "Manage billing" button now deep-links to Apple Settings instead of Stripe Portal — they can't cancel their Stripe sub from the app.

  Suggestion: §8 should explicitly say "if both Stripe and IAP are active, prefer Stripe in the DTO" (or "prefer the older sub by `createdAt`"). Then update `buildMeBody` accordingly — small change. Probably worth a slice of its own, or fold into #6.

- **NIT — `multi_source_active` log warning** (§8): good. Add an `audit_events` row too for forensic trail per design §13.9 (3rd rule: "user-facing notification recommended"). Out of scope for v1 if we accept a slow support-driven resolution.

---

## 7. Alternative approaches not considered

### Receipt validation
- **CONSIDER — Trust StoreKit 2 JWS without ASC roundtrip.** For Apple, the spec validates by:
  1. Verifying the JWS signature against Apple's root certs.
  2. *Then* calling `inApps/v1/transactions/{transactionId}` via ASC API to re-fetch.

  Step 2 is technically *redundant* on first purchase — the JWS payload is already cryptographically signed by Apple and contains all the fields we need (`productId`, `originalTransactionId`, `expiresDate`, `appAccountToken`). Apple's docs explicitly say "you can trust the JWS without an ASC API round-trip." We'd only need ASC for renewals where the client doesn't send a fresh JWS — and renewals come via ASSN V2 webhooks which *also* carry a fresh JWS.

  **Implication:** We could drop the ASC API client entirely for v1. The simplification is real:
  - No JWT signing/refresh.
  - No `APPLE_ASC_*` env vars.
  - No 5xx-handling for ASC outages.

  **Trade-off:** We still need an ASC client eventually for ad-hoc reconciliation (refund lookups, support tools, OOS reconciliation cron). And the Google side cannot do JWS-only because RTDN payloads don't include the full subscription state — you *must* call `purchases.subscriptionsv2.get`. So Apple-only saving.

  **Recommendation:** call this trade-off out in §6 ("Apple-specific contract") explicitly. Either commit to ASC-API (current spec) for parity with Google, or commit to JWS-only and shave a slice. The status quo of "validate JWS *then* roundtrip to ASC" is belt-and-suspenders — fine but worth being a deliberate choice rather than default.

### Google `acknowledge` API
- **MISSING — No mention of `purchases.subscriptions.acknowledge` (or `purchases.subscriptionsv2.acknowledge`).** Google's billing library **requires** every subscription to be acknowledged within 3 days of purchase. If not, **Google automatically refunds the user and revokes the purchase.** The spec mentions only `purchases.subscriptionsv2.get` (§5.2 + §11). This is a **BUG / launch blocker**.

  - `react-native-iap`'s `finishTransaction({ isConsumable: false, ... })` handles the client-side acknowledge for subscriptions. The spec mentions `finishTransaction` in §4 as a wrapper export — make sure slice #10 explicitly says "call `finishTransaction` only after the server `POST /billing/iap/checkout` returns 2xx; passing `isConsumable: false` triggers Google's acknowledge." Otherwise we ship and 3 days later every Android user gets refunded.
  - Apple has no equivalent — `finishTransaction` on iOS is just "remove from queue."

  **Action:** explicit step in §5.2 + slice #10: server response must be confirmed before finishTransaction. Add an integration test.

### Server-side notification consumption (v1 vs v2)
- **NIT** — Apple has ASSN V1 and V2; spec correctly chooses V2 (§5.3). Google has RTDN format 1 (legacy `subscriptionNotification`) and the implicit `subscriptionState` payload. Spec correctly uses the v2 endpoint `subscriptionsv2.get`. Good. But the RTDN payload itself (§5.3 step 2) is `{subscriptionNotification: {purchaseToken, subscriptionId, notificationType}}` — that's correct, but it's also useful to handle `oneTimeProductNotification` (we don't sell any) and `testNotification` (sent by Play when you first configure the topic). Add an explicit "ignore non-`subscriptionNotification` envelopes" line.

---

## 8. Operational risk

### Launch blockers (must do before flipping prod env vars)
1. **Acknowledge subscriptions** — see §7 above. **This is the #1 launch blocker.** Without it, all Android subs auto-refund in 72h.
2. **App Store Server Notifications V2 endpoint must be set BEFORE the first sandbox purchase.** Otherwise Apple never resends the historical notifications and we have a hole. Add a manual smoke step.
3. **EAS Build vs `react-native-iap` config plugin** (§4). The plugin requires `expo prebuild` or a custom dev client — the standard Expo Go workflow does NOT support IAP. Mobile dev memo (`project_mobile_dev_network.md`) says Expo Go is the dev runtime via Tailscale. **This is a real workflow break** — developers cannot test IAP in Expo Go at all. Spec mentions this implicitly ("EAS Build" in §4) but should be loud: **"IAP is dev-client-only; Expo Go users cannot exercise the plan picker beyond rendering."** Add a §4 note. Affects slice #10 + #12.
4. **Sandbox tester setup is manual + per-developer.** Each Apple dev needs their own sandbox tester (you can't share across team members because each device caches login). Add to §11 checklist.
5. **GOOGLE_SERVICE_ACCOUNT_JSON as `single-line, escaped` env var** (§5.1) — fine, but Vercel env vars have a 4 KB limit per var, and a typical Google SA JSON is ~2.5 KB. Tight but works. Recommend storing as base64-encoded JSON to be safe (`JSON.parse(Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON, "base64").toString("utf8"))`). NIT.

### Other operational concerns
- **NIT — Webhook URL configured in ASC/Play points to prod only.** Sandbox notifications go to a separate URL field in ASC (the spec catches this in §11: "prod + sandbox webhook URLs"). Make sure `APPLE_ENV` env var routes to the right code path; the spec mentions `APPLE_ENV=sandbox|production` but doesn't say *how* it changes behavior. Should `apple-client.ts` flip between `api.storekit-itc.apple.com` and `api.storekit.itunes.apple.com` URLs? Yes — make this explicit in §5.2.
- **CONSIDER — Webhook signature secret rotation.** ASC API key rotation is a "issue new key → update env var → revoke old key" three-step. Pub/Sub OIDC service-account key rotation likewise. Not in spec — add to §11 as a postlaunch task or Slack runbook reference.
- **CONSIDER — `WebhookEvent` row growth.** Existing `WebhookEvent` model has no retention policy (`schema.prisma:711-720`). Adding IAP events roughly doubles the inflow. Probably fine for v1 — add a retention cron in §12 OOS.

---

## 9. Section-by-section silence list (what looked OK)

- §2 (one-paragraph architecture) — accurate, scoped.
- §9 (pricing parity) — the "do not add IAP price constants" decision is right; `localizedPrice` from the store is the only legit display source for IAP.
- §10 (testing strategy) — coverage matrix is appropriate; sandbox tester process documented.
- §12 (OOS) — clean and explicit; no scope leak.
- §13 (open decisions: none) — fine, brainstorming-derived.

---

## Verdict

**APPROVE WITH CHANGES.**

**Must-fix before plan slicing → coding:**
1. **Google `acknowledge` for subscriptions** — explicit step in §5.2 + slice #10 + integration test. (§7 / §8)
2. **Apple `sourceSubscriptionId = originalTransactionId`** — explicit contract statement. (§1)
3. **Google `linkedPurchaseToken` upgrade chain** — explicit handling in `google-client.ts`. (§1)
4. **`buildMeBody` deterministic source preference** when Stripe+IAP both active. (§6)
5. **Android resubscribe-after-expiry** — webhook fallback when row unknown but `obfuscatedAccountId` attributable. (§2)
6. **`ApiErrorCode` additions in `libs/shared/src/errors.ts`** — don't create a parallel `iap-errors.ts` type. (§3)
7. **DTO file location** — request bodies move to `libs/shared/src/schemas/iap.ts`, not `dto/iap.ts`. (§4)

**Should-do (NIT, but cheap):**
- Sandbox routing for `APPLE_ENV`. (§8)
- Plan picker `getSubscriptions` empty-state. (§5)
- Restore Purchases on plan-picker screen too. (§5)
- Spec out which `productId` feeds the Google cancellation deep link. (§5)
- `expo prebuild` / dev-client warning. (§8)

**Defer / OK as-is:**
- Slice count of 12 (acceptable; can parallelize #4/#5 and #8/#9 if useful).
- ASC-API roundtrip on Apple (belt-and-suspenders, fine; just make it a deliberate choice).
- `WebhookEvent` retention (v1.5+).
- US External Link entitlement (§13.8 OOS, fine).

Once the seven must-fix items are folded in, this is ready for plan-slicing.
