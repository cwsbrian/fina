# Mobile IAP Billing — Security + Correctness Review

**Spec reviewed:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
**Reviewer role:** Security + correctness
**Date:** 2026-05-26

---

## Summary

The spec is structurally sound and mirrors the proven Stripe pattern (signature → dedup → re-fetch → upsert). However, several **correctness gaps** in receipt/JWS verification (bundleId pinning, environment check, JWS `alg` whitelist), one **CRITICAL** missing Google requirement (purchase **acknowledgment** — Google auto-refunds at +3 days), and a **HIGH** gap in the first-purchase race handling (drop-on-the-floor on §5.3 step 4) must be resolved before merge. Several of these are silent failure modes — they will not throw, just produce wrong state or revenue loss.

---

## Findings

### 1. Receipt validation correctness

#### 1.1 Apple — missing anti-tampering checks  **HIGH**  (§5.2 `apple-client.ts`, §5.3 `/webhooks/iap/apple` step 1, §6)

Spec says: "Verifies `signedTransactionInfo` JWS using Apple's root certs." That is necessary but **not sufficient**. The signed payload also has claims that must be pinned, otherwise a valid Apple JWS for a *different app* or a *sandbox transaction* will be accepted in production.

Missing required checks against the verified JWS body:

1. **`bundleId` must equal `APPLE_BUNDLE_ID`** — without this, a transaction from any other app signed by Apple verifies fine. (Apple's `signedTransactionInfo` includes `bundleId`.)
2. **`environment` must equal `APPLE_ENV`** ("Production" vs "Sandbox") — without this, a sandbox transaction (free) is accepted as a production purchase. This is the classic "free Pro tier" exploit.
3. **JWS header `alg` whitelist = `ES256` only** — never accept `none`, never accept asymmetric→symmetric confusion. Spec says "JWS" but does not pin the algorithm.
4. **Cert chain `x5c` must terminate at Apple's pinned root**, and intermediates must chain by signature, not by name. Spec says "Apple's X5C cert chain → Apple root" — be explicit that the root is **pinned by SPKI hash** in code, not fetched at runtime.
5. **`signedDate` recency** — reject JWS older than ~10 minutes for the *transaction* endpoint response; for ASSN webhook payloads, reject older than ~1 hour, to prevent replay of a captured-and-stored payload. (Apple's ASSN does not include a nonce.)
6. **`appAccountToken` presence** — if absent in the verified transaction (i.e., the iOS app omitted it on `requestSubscription`), reject. Otherwise we have no way to bind to a Fina user at all and we will silently bind to whoever's session POSTed.

**Suggestion:** Add a §6.x "JWS verification rules" subsection enumerating the six checks above as MUST. Make `apple-client.ts` expose a single `verifyAndDecodeTransaction(jws): VerifiedAppleTransaction` that fails closed on any of them.

---

#### 1.2 Google — missing `acknowledge` step  **CRITICAL**  (§5.2 `google-client.ts`, §5.3 step 3, §7)

Spec talks only about `purchases.subscriptionsv2.get`. Google Play **requires** every new subscription purchase to be acknowledged within **3 days** via `purchases.subscriptions.acknowledge` (or by calling `purchases.subscriptionsv2.acknowledge` on v2), otherwise Google **auto-refunds the transaction and revokes entitlement**.

This is not optional. Without it, every new sub will be auto-refunded after 3 days and revenue is silently lost — there is no error surfaced to us until users complain.

**Suggestion:**
- In `syncSubscriptionFromIAP` for Android, when the validated `acknowledgementState === ACKNOWLEDGEMENT_STATE_PENDING`, immediately call `purchases.subscriptionsv2.acknowledge(packageName, token)` after the upsert succeeds (so we never acknowledge a purchase we couldn't record).
- Add a guard: if acknowledgment fails (5xx), the upsert is still useful, but log + retry on next webhook (it idempotently re-acknowledges).
- Add the corresponding scope to the service account: `androidpublisher.subscriptions.update` (§7 currently lists only `.get` — that's least-priv but **insufficient**). Update §11 step Google.2 accordingly.

Add a §7.x bullet: "Acknowledge within 3 days, idempotent on every sync, mandatory."

---

#### 1.3 Apple — `transactionId` vs `originalTransactionId` confusion  **MEDIUM**  (§5.2, §5.3 step 5)

Spec uses both `transactionId` and `originalTransactionId` interchangeably. They are **not** the same:
- `transactionId` rotates on every renewal.
- `originalTransactionId` is stable across renewals and **is** what binds a subscription line across its lifetime.

§5.2 says `apple-client.ts` calls `inApps/v1/transactions/{transactionId}` — that endpoint is intended for *single transaction lookup* and is correct for initial validation. But for sync, we should resolve to the `originalTransactionId` and then call `inApps/v1/subscriptions/{originalTransactionId}` (which the spec also mentions). Be explicit:
- `Subscription.sourceSubscriptionId` MUST always be `originalTransactionId`, never `transactionId`.
- The dedup webhook lookup must also key on `originalTransactionId` from `signedTransactionInfo` (§5.3 step 3 — fine as written, but verify the upserts in `sync-sub.ts` match).

**Suggestion:** Add one line to §5.4 / §6: "`sourceSubscriptionId` = Apple `originalTransactionId` (stable across renewals)."

---

### 2. Webhook signature verification

#### 2.1 Apple ASSN V2 — algorithm whitelist + replay window  **HIGH**  (§5.3 `/webhooks/iap/apple` step 1)

Same issue as 1.1: spec doesn't constrain JWS `alg`. ASSN V2 is ES256 always — pin it. Without this, an attacker who finds *any* JWS-verification library bug ("alg: none", HS256 confusion using the public key as HMAC secret) can forge notifications.

Also: ASSN does not carry a nonce. The `notificationUUID` is **stored by Apple** and the *same UUID is retransmitted on retry*. So `WebhookEvent`-based dedup catches a re-delivery from Apple — but only after **first delivery succeeded**. Captured-from-logs replay is still possible until the record exists. Combine with the §1.1 `signedDate` recency check to bound replay window.

**Suggestion:** In `webhook-verify.ts`, the `alg` whitelist + `signedDate` recency check is mandatory and tested in `iap/webhook-verify.test.ts` (already planned).

---

#### 2.2 Google RTDN — verify Pub/Sub subscription name + token age  **MEDIUM**  (§5.3 `/webhooks/iap/google` step 1)

Spec checks audience, issuer, email. That's the standard recipe and is sufficient for **OIDC verification** of the push subscription. But:

1. **OIDC JWT `exp` must be checked** with no clock skew tolerance (the JWT library default is 0–30 s; pin it explicitly). Pub/Sub tokens are short-lived (~1 hr); a leaked token after `exp` must fail.
2. **The `azp` claim should equal the configured service account email** (in addition to `email`). Belt-and-suspenders.
3. **Pub/Sub topic name verification** — Google's push delivery includes `subscription` in the envelope (e.g., `projects/{p}/subscriptions/{s}`). Pinning this in code defends against the case where a misconfigured *second* push subscription on the same OIDC service account email points at our webhook (e.g., a staging GCP project that an attacker controls). Spec does not mention this — recommend adding `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` env var and verifying `body.subscription === env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME`.

**Suggestion:** Add `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` to §5.1 env vars and enforce it as step 1.5 in §5.3.

---

### 3. Idempotency / replay safety

#### 3.1 `notificationUUID` and Pub/Sub `messageId` stability  **LOW**  (§5.3 steps 2, 3)

- Apple's `notificationUUID` is documented to be stable and unique across retries — using it as `WebhookEvent.id` is correct.
- Google's `message.messageId` from Pub/Sub is stable across redelivery attempts of the same notification but **may differ if Play republishes the same business event** (e.g., recovery republish for downstream subscribers). This means we may process the same `purchaseToken / notificationType` twice with two different `messageId`s — not a correctness problem (re-fetch + upsert is idempotent), but slightly wastes work and makes the dedup table grow.

**Suggestion (NIT):** Acceptable as-is. Optional improvement: also key dedup on `(purchaseToken, notificationType, eventTimeMillis)` in the dedup, but only if observability shows this matters.

---

#### 3.2 First-purchase race — dropping events on the floor  **HIGH**  (§5.3 `/webhooks/iap/apple` step 4, `/webhooks/iap/google` step 4)

Both webhook handlers say: "If unknown (first-purchase race), log + return 200 — the client-driven `/billing/iap/checkout` will create the row on retry."

This is the wrong call for at least two scenarios:

1. **The user never re-opens the app.** They tap "Subscribe" → Apple/Google charges them → notification arrives → we drop it (200 OK). The client-side `postIAPCheckout` may have failed (network error mid-purchase, app crash, user backgrounded). Apple/Google sees a 200 and **never retries**. The user is now subscribed at the store but our server has no record, forever. They get charged each month and see no Pro features in Fina.

2. **The notification legitimately arrives before checkout** — Apple ASSN V2 has near-zero latency; the SDK callback to the app can take longer than the webhook (especially on iOS with App Tracking transparency prompts). Result: 200 + log, then `/billing/iap/checkout` lands a few seconds later. The checkout call works because it re-fetches from Apple itself. OK in this case. But case 1 above is silent and bad.

**Suggestion (preferred):** When the webhook can't resolve a userId from `Subscription`, **but the verified transaction has an `appAccountToken` (Apple) / `obfuscatedAccountId` (Google)**, reverse-derive the userId:
- Apple `appAccountToken` = `uuidv5(userId, IAP_NAMESPACE)` — deterministic but **not reversible**. So instead, store an explicit `User.appAccountToken` column (or a side table `IapUserBinding{userId, platform, appAccountToken}`) on the *first* SUCCESSFUL `/billing/iap/checkout`, and on webhook do `prisma.user.findFirst({ where: { appAccountToken } })`. If found, create the Subscription row right here in the webhook.
- Google `obfuscatedAccountId` = `sha256(userId)` — same deal, store a binding.

**Suggestion (minimum):** If we choose not to add binding storage, then return **500** (not 200) in the unknown-user branch, so the store retries. After ~3 retries from Apple (3 days), it gives up; before then, the `/billing/iap/checkout` call has time to land. This is worse than the binding-table approach but better than silently dropping.

This is the single most important business-correctness issue in the spec.

---

### 4. Cross-user contamination

#### 4.1 Deterministic `appAccountToken` — log-out / log-in on same device  **MEDIUM**  (§6, §5.3 restore)

Scenario: userA buys on device → uuidv5(userA) baked into the receipt forever. UserA logs out. UserB logs in on the same device. UserB taps "Restore." StoreKit returns userA's purchase. We validate; `appAccountToken = uuidv5(userA) ≠ uuidv5(userB)`. We 403 `user_mismatch`. 

**Concern:** This is only safe if the `appAccountToken` check is **mandatory** for restore. §5.3 restore step 3 says "If **any** purchase belongs to a different user, return 403 `user_mismatch` for that one and continue with the rest." That is correct, but the spec does not explicitly say what we do in the **happy path** when the purchase has *no* `appAccountToken` (legacy iOS purchases before we shipped IAP, or if the app forgot to pass it). The reasonable answer is: **reject with `user_mismatch`** — don't bind ambiguous purchases. Spec should be explicit.

**Suggestion:** Add to §5.3 restore step 3: "If the verified transaction has no `appAccountToken` (or Google has no `obfuscatedAccountId`), treat as `user_mismatch` and reject — never bind ambiguous purchases."

---

#### 4.2 Checkout `appAccountToken` enforcement on first-purchase  **HIGH**  (§5.3 `/billing/iap/checkout` — implicit in step 3)

The user prompt itself notes this is implicit but not explicit in the spec. Confirming: we need an explicit step. The attack is:

> U1 logs in. U1 captures U2's freshly-purchased `transactionToken` (e.g., U2 shared it, MITM on U2's pre-TLS handshake, leaked from a debug build). U1 POSTs U2's token to `/billing/iap/checkout` under U1's session.
> We call Apple → verified transaction has `appAccountToken = uuidv5(U2)`. We compare against `requireSession().userId = U1` → `uuidv5(U1) ≠ uuidv5(U2)` → 403.

This works iff `syncSubscriptionFromIAP` **always** compares the verified `appAccountToken` against `uuidv5(callerUserId, IAP_NAMESPACE)` before upsert. Spec §5.3 step 3 implicitly assumes this but does not state it. Make it explicit.

**Suggestion:** In §5.3 `/billing/iap/checkout` step 3, expand to: "Call `syncSubscriptionFromIAP({userId, expectedAppAccountToken: uuidv5(userId, IAP_NAMESPACE), ...})`. The sync function MUST 403 if verified `appAccountToken !== expectedAppAccountToken`."

---

### 5. Privilege boundary

#### 5.1 Replay of leaked webhook payload before first record  **LOW**  (§5.3)

Discussed in §2.1 above. Mitigated by `signedDate` recency check + dedup. Not a separate finding.

---

#### 5.2 Webhook accidentally trusting bearer headers  **NIT**  (§5.3)

The Stripe webhook route (`billing-webhook.ts`) overrides the JSON parser to give raw bytes for signature verify. The new `/webhooks/iap/apple` and `/webhooks/iap/google` will need the **same** raw-body parser override scoped inside their plugin, otherwise Fastify re-serializes and JWS verification fails. Spec doesn't mention this.

**Suggestion:** Add an explicit note in §5.3 webhook subsections: "Use a per-plugin `addContentTypeParser` with `parseAs: 'buffer'` (mirror `billing-webhook.ts`). Scope it so it does not affect other routes."

---

### 6. State machine correctness

#### 6.1 Apple `EXPIRED` collapsed voluntary + involuntary  **MEDIUM**  (§5.4)

Spec maps both `EXPIRED` flavors to `canceled`. That's defensible for entitlement purposes (entitlement is gone either way), but it loses information needed for **customer support and revenue ops**:
- Voluntary cancel = user chose to leave (no action).
- Involuntary cancel = billing failed and grace expired (we may want to email "your card failed, here's a one-tap return link").

Stripe distinguishes these via `canceled_at` + `cancellation_details`. Apple distinguishes via `expirationIntent` (1=voluntary, 2=billing error, 3=price increase declined, 4=product unavailable) in `signedRenewalInfo`.

**Suggestion:** Either (a) add an internal `cancellationReason` column to Subscription (parallel to Stripe's), or (b) explicitly note in §5.4 that v1 loses this distinction and add it as a v1.5 follow-up. Current spec silently drops it.

---

#### 6.2 Google `SUBSCRIPTION_STATE_CANCELED` → `active + cancelAtPeriodEnd`  **LOW**  (§5.4)

Mapping is correct: Play returns `CANCELED` for "user pressed cancel but still in current period" (their `lineItems[].expiryTime` is still future). Our enum `active + cancelAtPeriodEnd=true` matches Stripe semantics. 

**However:** the mapping should also check that `expiryTime > now`. If we receive a `CANCELED` whose `expiryTime` is in the past (rare — clock skew or late delivery), `active` is wrong. Default to `canceled` in that case.

**Suggestion:** §5.4 — add a footnote: "If `subscriptionState === CANCELED` but `expiryTime <= now`, map to `canceled` (not `active`)."

---

#### 6.3 `pendingTier` always null vs Google upgrade/downgrade  **MEDIUM**  (§5.4)

Spec says: "IAP v1 doesn't expose tier changes the way Stripe Subscription Schedules do (users cancel + buy a new product). Always `null` for `source !== "stripe"`."

This is **incorrect for Google Play Billing v6+**. Play supports plan upgrades/downgrades via `BillingClient.launchBillingFlow` with `SubscriptionUpdateParams` (replacement modes: `CHARGE_FULL_PRICE`, `WITHOUT_PRORATION`, `DEFERRED`, `CHARGE_PRORATED_PRICE`). With `DEFERRED` mode, the new plan kicks in at the next billing cycle and the existing `SubscriptionPurchaseV2` reflects this via `lineItems[]` showing both the current and upcoming items.

For v1 with `IAP_PRODUCT_IDS = { lite_monthly, pro_monthly }`, the user must cancel + buy — fine. But the spec's claim that Google **doesn't support** scheduled changes is factually wrong. State it as a v1 product choice, not a platform limitation.

Apple is genuinely more constrained: Apple's "upgrade" (within a subscription group, lite_monthly → pro_monthly) takes effect immediately with prorated refund, and "downgrade" defers to the next renewal — but expressed only via `signedRenewalInfo.autoRenewProductId` differing from `signedTransactionInfo.productId`. We could surface this as `pendingTier` for Apple too.

**Suggestion:** Reword §5.4 last paragraph:
> "IAP v1: we don't offer in-app tier changes (user must cancel + re-purchase). `pendingTier` always null. v1.5 will surface Apple's `autoRenewProductId` and Google's deferred upgrade in `SubscriptionPurchaseV2.lineItems[]` to populate `pendingTier`."

This is a doc fix, not a behavior change, but worth correcting because it determines whether we add the column-population logic now or later.

---

### 7. Env / config safety

#### 7.1 `APPLE_ASC_PRIVATE_KEY` and `GOOGLE_SERVICE_ACCOUNT_JSON` redaction  **HIGH**  (§5.1)

Spec stores both as raw strings in env. Two concerns:

1. **No redaction policy mentioned.** If any `app.log.error({ env: app.fina.env }, ...)` or similar dump exists or is added, the keys leak to stdout → log aggregator → potential blast radius far larger than the API host. The existing Stripe key has the same shape but is shorter; an ASC `.p8` and a GCP service account JSON are both unmistakably credentials in log lines.
2. **No mention of how the JSON blob is escaped.** "Single-line, escaped" is a hint, not a contract. If someone JSON.stringify-double-escapes, parsing fails at boot and we get `iap_not_configured` everywhere — silent fail.

**Suggestions:**
- Add a `redact` field to the Pino logger config covering `APPLE_ASC_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, and any nested keys (`*.private_key`).
- For the service account JSON, accept **either** a single-line JSON string **or** a base64-encoded JSON string (try base64 decode first, fall back to plain JSON). Document which form is canonical.
- Validate at boot: parse + sanity-check (issuer claim shape, key has `BEGIN PRIVATE KEY`, etc.) — fail loud at startup, not at first webhook.
- Never log the raw env object. Pin a `app.fina.env` toString that excludes secrets, or stop ever logging it.

---

#### 7.2 In-memory ASC JWT cache lifetime  **NIT**  (§6)

"Re-sign per call (5-min expiry) and cache in-memory for ~4 min" is fine but the cache should be process-local (no Redis/shared), and on process restart we re-sign — no issue. Spec is OK; just don't accidentally persist.

---

### 8. PII / compliance

#### 8.1 Apple `originalTransactionId`, Google `purchaseToken`  **LOW**  (§5.2)

Per Apple's [App Store Server API terms] and Google's [Play Billing terms], these identifiers are **not** classified as PII on their own — they're opaque tokens scoped to your app. Storing them plaintext in `sourceSubscriptionId` is fine and standard practice.

**However:**
- The `purchaseToken` is a bearer credential for `purchases.subscriptionsv2.get`. Anyone with the token + your service-account credentials can re-fetch the purchase. Log redaction should treat it similarly to a session token.
- The `appAccountToken` (uuidv5(userId)) is derived from internal `userId`. It's not PII but it is a **stable cross-purchase identifier** for the same user. If we ever expose it client-side (we don't, in this spec — good), it becomes a tracking vector.

**Suggestion:** Add `purchaseToken` and `signedTransactionInfo` to log redaction. Same Pino redact config as §7.1.

---

#### 8.2 No mention of GDPR / account-deletion flow  **MEDIUM**  (§12 out of scope)

When a user deletes their Fina account, what happens to their `Subscription` row? Stripe sub is canceled via the existing flow (we have `/account/delete` if we have one — verify separately). IAP subs **cannot be canceled server-side** — only the user via Apple/Google's account settings.

For GDPR / data-deletion: we can null out `sourceCustomerId` and delete the Subscription row, but the user keeps paying Apple/Google. Spec doesn't address this.

**Suggestion:** Add to §12 (out of scope) or §8: "Account deletion: Stripe sub is canceled; IAP subs are surfaced to the user with a banner directing them to platform-native cancellation BEFORE confirming account deletion."

---

### 9. Other findings

#### 9.1 Restore endpoint — limit of 20  **NIT**  (`IAPRestoreBody`)

`purchases.array().min(1).max(20)`. 20 is fine, but consider: a long-time user could hit StoreKit's `getAvailablePurchases` and get back N >> 20 transactions if they've bought + canceled + re-bought many times. Document the cap and what happens if `getAvailablePurchases` returns more (mobile pre-filters to active product IDs only? caps to most recent 20?).

**Suggestion:** Mobile client filters to `productId IN IAP_PRODUCT_IDS` and dedup on `originalTransactionId` before POST. Add to §4 mobile units.

---

#### 9.2 `product_mismatch` semantics  **LOW**  (`IAPErrorCode`)

Spec says: "productId doesn't match validated receipt." But §5.3 step 3 takes `productId` from the request body **and** from the verified transaction. Which one wins for the tier? Should be: **always use the verified one**, and `product_mismatch` only signals to the *client* that its local state was stale (refresh products). Server never trusts client-side productId for tier resolution.

**Suggestion:** In `syncSubscriptionFromIAP`, derive `tier` solely from `verifiedTransaction.productId` via `pricing-map.ts`. The request body's `productId` is only used for telemetry / sanity check, never for write decisions.

---

#### 9.3 `iap_not_configured` returning 500  **NIT**  (§5.1)

If env vars are absent, consumer code throws `HttpError(500, "iap_not_configured")`. For a user-facing 5xx that always happens (e.g., dev/preview deploys), this is noisy. Consider 503 + a friendlier message, or short-circuit at route registration time (don't register `/billing/iap/*` if env missing).

**Suggestion:** Optional. Either is fine; 503 is more accurate semantically.

---

## Severity tally

| Severity | Count | Items |
|---|---|---|
| CRITICAL | 1 | 1.2 (missing Google acknowledge → auto-refund) |
| HIGH | 5 | 1.1, 3.2, 4.2, 7.1, and conjoined risk from 2.1 |
| MEDIUM | 5 | 1.3, 2.2, 4.1, 6.1, 6.3, 8.2 |
| LOW | 3 | 3.1, 6.2, 8.1 |
| NIT | 4 | 5.2, 7.2, 9.1, 9.3 |

---

## Verdict

**APPROVE WITH CHANGES** — block on the **CRITICAL** and all **HIGH** items before code lands. The MEDIUMs and LOWs can be tracked as follow-ups, but several (4.1, 6.1, 6.3) are easier to design in now than retrofit.

Required changes before this spec advances to a plan:
1. **§1.2 (CRITICAL)** — Add Google `acknowledge` step, service-account `subscriptions.update` scope, mandatory on every sync.
2. **§1.1 + §2.1 (HIGH)** — Enumerate Apple JWS verification claims (bundleId, environment, alg=ES256, signedDate recency, appAccountToken presence). Pin Apple root by SPKI hash.
3. **§3.2 (HIGH)** — Resolve first-purchase-race ambiguity: either store a `User.appAccountToken` / `User.obfuscatedAccountId` binding and create the Subscription row in the webhook, OR return 500 (not 200) when unknown so the store retries.
4. **§4.2 (HIGH)** — Make the `appAccountToken == uuidv5(callerUserId)` check explicit in `/billing/iap/checkout` step 3.
5. **§7.1 (HIGH)** — Add Pino redact rules covering `APPLE_ASC_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `*.private_key`, `purchaseToken`, `signedTransactionInfo`. Boot-time validation of both env secrets.
6. **§2.2 (MEDIUM, recommended)** — Add `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` env var and verify the envelope `subscription` field.

Once those are in the spec, this is good to plan.
