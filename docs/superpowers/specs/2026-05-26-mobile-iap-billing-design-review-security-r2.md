# Mobile IAP Billing — Security Review **(Round 2)**

**Spec reviewed:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
**Round-1 review:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design-review-security.md`
**Fixes inspected:** R1–R10 (commits `7161442..75b45a2`)
**Reviewer role:** Security + correctness, follow-up
**Date:** 2026-05-26

---

## 1. Round-1 must-fix verification

| Round-1 item | Severity | R-commit | Spec location | Verdict |
|---|---|---|---|---|
| §1.2 Google `acknowledge` step + `.update` scope, mandatory on every sync | CRITICAL | R1 | §5.2 `google-client.ts` bullet 2; §7 bullet "Acknowledgment is mandatory" (1–5); §11 Google.2 service-account scopes | **FIXED** |
| §1.1 + §2.1 Apple JWS checks (bundleId, environment, alg=ES256, signedDate, appAccountToken, SPKI-pinned root) | HIGH | R2 | §5.2 `apple-client.ts` checks 1–6; §5.3 Apple webhook step 1 explicitly invokes all six | **FIXED** |
| §1.3 `transactionId` vs `originalTransactionId` confusion | MEDIUM | R3 | §3 "Subscription ID contract" Apple bullet ("ALWAYS … never `transactionId`"); §5.3 Apple webhook step 3 | **FIXED** |
| §3.2 First-purchase race — User binding columns OR 500-retry | HIGH | R4 | §3 schema additions (`User.iapAppleAccountToken`, `User.iapGoogleObfuscatedId`); §5.3 step 4 explicitly uses both: binding fallback **then** 500-retry. Belt-and-suspenders, both paths kept. | **FIXED** |
| §4.2 Explicit `appAccountToken == uuidv5(callerUserId)` check in `/billing/iap/checkout` | HIGH | R4 | §5.3 checkout step 3: "MUST 403 `user_mismatch` if the verified … does NOT equal the expected … check is mandatory, not optional." Mirrored for restore in step 3 of `/billing/iap/restore`. | **FIXED** |
| §7.1 Pino redact rules + boot validation | HIGH | R5 | §5.1 "Boot-time validation + log redaction (required)" — explicit redact list, boot-time shape check, base64-OR-JSON loader, `redactEnv()` helper | **FIXED** |
| §2.2 `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` env + envelope subscription check | MEDIUM | R2 | §5.1 env list; §5.3 Google webhook step 2 ("Verify `body.subscription === env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME`") | **FIXED** |
| §3.1 messageId stability | LOW | accepted | n/a — round-1 marked as acceptable NIT | **AS-IS (accepted)** |
| §4.1 Restore: reject ambiguous purchases with no `appAccountToken` | MEDIUM | R4 | §5.3 restore step 3 ("a verified transaction with NO `appAccountToken` … treated as `user_mismatch`") | **FIXED** |
| §5.2 raw-body parser per-plugin | NIT | R4/R5 | §5.3 — "Both webhook routes use a per-plugin `addContentTypeParser` with `parseAs: \"buffer\"` … mirror of `apps/api/src/routes/billing-webhook.ts:11`" | **FIXED** |
| §6.1 Apple `EXPIRED` voluntary/involuntary distinction | MEDIUM | R6 | §5.4 "`cancellationReason` (NEW column, v1.5)" — explicit out-of-scope with rationale (vs. round-1 spec silently dropping it) | **FIXED (deferred to v1.5, documented)** |
| §6.2 Google `CANCELED + expiryTime <= now` → `canceled` | LOW | R6 | §5.4 table: split into two rows for `CANCELED AND expiryTime > now` (active+cape) vs `<= now` (canceled) | **FIXED** |
| §6.3 `pendingTier` framing — product choice, not platform limitation | MEDIUM | R6 | §5.4 `pendingTier` / `pendingTierAt` block: "This is a product choice, NOT a platform limitation. Google Play Billing v6+ supports …" | **FIXED** |
| §7.2 In-memory ASC JWT cache | NIT | accepted | §6 — wording preserved, "no persistence" still explicit | **AS-IS (accepted)** |
| §8.1 PII / token redaction (purchaseToken, signedTransactionInfo) | LOW | R5 | §5.1 redact list includes both | **FIXED** |
| §8.2 GDPR / account deletion flow | MEDIUM | R7 | §12.1 entire new subsection — blocking banner before delete, deep-link to platform UI, drop row after confirmation | **FIXED** |
| §9.1 Restore cap of 20, mobile-side pre-filter | NIT | R8 | §5.3 restore step 4 — explicit "Mobile client MUST pre-filter … to `productId IN IAP_PRODUCT_IDS` and dedup on `originalTransactionId` before POSTing" | **FIXED** |
| §9.2 `product_mismatch` — verified tier wins | LOW | R5 | §5.3 checkout step 6 — "derives `tier` solely from the verified transaction's `productId` … server NEVER trusts client-side productId for write decisions" | **FIXED** |
| §9.3 `iap_not_configured` 500 vs 503 | NIT | R5 | §5.1 — "503 — service-not-configured semantics, not a generic 500" | **FIXED** |

**Round-1 outcome: 1 CRITICAL + 5 HIGH + 5 MEDIUM + 3 LOW + 4 NIT → all addressed.** No round-1 item remains open.

Bonus fix observed: R3 also tightened the Google `linkedPurchaseToken` chain-rewrite (in §7), which was not flagged in round 1 but is a real edge case for in-Play upgrades — good catch by the author.

---

## 2. NEW findings introduced by R1–R10

### 2.1 cuid risk analysis for `iapGoogleObfuscatedId` / `iapAppleAccountToken`

**Severity: LOW (advisory).** **§3, §6, §7**

The prompt asked specifically: is `sha256(userId)` / `uuidv5(userId, IAP_NAMESPACE)` resistant to a precomputed-dictionary attack against the `User.iap*` columns?

Verified `apps/api/prisma/schema.prisma:17` — `User.id` has **no `@default(cuid())`**; it's externally supplied by Better Auth. Better Auth's default user ID is a 32-character alphanumeric string (~190 bits of entropy, far more than a cuid's ~125 bits). Both representations are well outside any practical precomputed-dictionary scope.

For the attack to matter, the adversary would also need to **observe** a target user's `iapGoogleObfuscatedId` or `iapAppleAccountToken`. These columns are server-internal — never returned by `/me`, never set in a cookie, never logged once the §5.1 redact rules are honored. The `appAccountToken` is sent to Apple inside `requestSubscription` and round-trips through the verified JWS, but it's not exposed in our own client wire format.

So the deterministic-derivation property is fine for the threat model it's defending (binding a verified purchase to a userId without storing AsyncStorage state). The spec correctly notes (§6 Apple bullet, §7 Google bullet) that determinism is the point.

**Recommendation (NIT, not blocking):** Add one explicit sentence to §6 and §7: *"These binding tokens are not authenticators — they're identifiers. The security boundary is the verified-JWS / verified-Pub/Sub signature, not the secrecy of the binding value. Source-code disclosure of `IAP_NAMESPACE` does not weaken the design."* This pre-empts the inevitable code-review question of "isn't this a secret?"

`@unique` collision math: with ~190 bits of `User.id` entropy → SHA-256 collision space is bounded by the input space → collision probability is effectively zero (`User.id`-driven, not 2^128-driven). uuidv5 is also injective over inputs of distinct value. No concern.

---

### 2.2 Webhook → 500 DoS amplification surface

**Severity: LOW.** **§5.3 Apple webhook step 4.3, Google webhook step 4.3**

Round-1 §3.2 recommended either binding-columns OR 500-on-unknown. R4 kept **both**: binding lookup first, then 500 only if the binding is also missing. That's the right call defensively, but it does mean: an attacker with a valid recent ASSN payload for a userId that has never installed Fina **could** force ~5 retries from Apple over 3 days.

The spec partially bounds this via the §5.2 check #5 `signedDate` window (1h for ASSN webhooks). Cross-checking the windows:

| Source | Window | Source of truth |
|---|---|---|
| ASC-API responses | ≤ 10 min | §5.2 check #5 |
| ASSN webhook JWS | ≤ 1 hour | §5.2 check #5 |
| Apple ASSN retry policy | 5 retries over 3 days | §5.3 Apple webhook step 4.3 |

**Internal consistency check:** The retry window (3 days) is much longer than the JWS recency window (1 hour). So even though Apple may retry for 3 days, any *captured-and-replayed* payload becomes invalid after 1 hour. A live Apple-originated replay during the legitimate retry window is fine because each retry carries a fresh `signedDate`. **Spec is internally consistent.** Good.

**Recommendation (NIT):** §5.3 Apple webhook step 4.3 already says "Cap log noise via per-`appAccountToken` counter" — extend the counter to also drive a rate-limiter (e.g., max 100 unknown-binding 500s/hour per IP-range or per `appAccountToken`). At Apple's normal volume this would never trip, but defends the log-aggregator from an attacker hand-replaying captured payloads at high rate within the 1h window. Not blocking.

---

### 2.3 `receipt` field naming regression

**Severity: NIT.** **§3 `schemas/iap.ts`**

R8 renamed `transactionToken` → `receipt`. The author's rationale ("industry term, less misleading than 'token' for the 2-3 KB JWS") is reasonable, but Apple's own StoreKit 2 documentation calls this payload `signedTransaction` (the field name on `Transaction.jwsRepresentation`). Apple deliberately stopped calling it a "receipt" in StoreKit 2 because the historical StoreKit 1 "receipt" was a single app-wide blob — quite different from a per-transaction JWS.

This is a documentation/dev-experience nit, not a security issue. `receipt` is fine for the on-the-wire field name but the schema comment should not call it ambiguous.

**Current:** `receipt: z.string().min(1).describe("iOS: signedTransaction JWS string; Android: purchaseToken")` — this is actually OK because the `.describe()` says `signedTransaction JWS string` explicitly. Strong enough that an implementer reading the schema sees both names.

**No change required.** Flagging only because the prompt asked.

---

### 2.4 Deep-link `sku` privacy

**Severity: NIT.** **§4 Subscription group in More tab**

R9 added `&sku=<currentProductId>` to the Android Manage-billing deep link. The concern raised in the prompt — does this leak a private product ID? — is unfounded. The same productId is already public via Play Store listings, the Subscriptions group in the user's own Play account, and `BillingClient.getSubscriptions` on any device with the app installed. No new disclosure.

**Recommendation:** No change. Spec is fine.

---

### 2.5 Boot-time validation must not log the private key on failure

**Severity: MEDIUM.** **§5.1 (NEW gap — implementation note missing)**

The spec adds "Validate at boot: parse + sanity-check (issuer claim shape, key has `BEGIN PRIVATE KEY`, etc.) — fail loud at startup, not at first webhook." Combined with the Pino redact rules, this is mostly safe — *but* the redact rules apply to log records emitted via Pino. The classic boot-time failure path is `throw new Error(\`bad APPLE_ASC_PRIVATE_KEY: ${value}\`)` directly to stderr, which **bypasses Pino entirely**.

The spec does not explicitly forbid this pattern. An implementer wiring boot validation could legitimately read the spec and write:

```ts
if (!key.includes("BEGIN PRIVATE KEY")) {
  throw new Error(`APPLE_ASC_PRIVATE_KEY invalid: ${key.slice(0, 64)}…`);
}
```

…and now the first 64 chars of the .p8 are in container logs.

**Recommendation:** §5.1 "Boot-time validation" bullet should add: *"Boot-time validation MUST fail with an error message that names the env var but NEVER contains any portion of its value (not even a prefix). The redactEnv() helper should be used for any boot-time diagnostic that touches the env object."* This is small but important — the redact rules don't help if you bypass Pino.

---

### 2.6 Sandbox-to-production crossover

**Severity: MEDIUM.** **§5.4 / §12 (NEW gap)**

A user testing in sandbox creates a `Subscription` row with `environment` derived from `signedTransactionInfo.environment === "Sandbox"`. When the app ships to production, the user's sandbox subscription will eventually expire (sandbox subs accelerate — monthly = 5 min) and the webhook will transition it to `canceled`. But the local row persists.

In production:
1. The same `originalTransactionId` cannot be reused (Apple guarantee).
2. But the `User.iapAppleAccountToken` binding (uuidv5(userId)) **is** the same in sandbox and prod.
3. So a prod purchase by the same user lands cleanly and creates a new row — the old sandbox row sits alongside.

The §5.2 check #4 (`environment === env.APPLE_ENV`) ensures we **reject** a sandbox JWS that arrives while running with `APPLE_ENV=production`. Good. So the persistence is *latent* but doesn't actively confuse production logic, because `syncSubscriptionFromIAP` never re-fetches sandbox transactions in a prod env (the ASC API call would also fail since prod credentials hit prod endpoints).

**However:** `buildMeBody`'s active-sub query (R5 multi-source precedence) walks all rows. A stale sandbox row with `status=canceled` doesn't pollute the precedence (only `ACTIVE_SUBSCRIPTION_STATUSES` participate). But a stale sandbox row with `status=active` left from a never-cancelled sandbox sub will incorrectly grant Pro entitlement in prod.

The spec doesn't address this. The simplest fix:

**Recommendation:** Add to §5.4 or §8: *"`buildMeBody` and `effectiveTier` MUST filter out subscriptions where `environment === 'Sandbox'` when `APPLE_ENV === 'production'` (and the symmetric Google case). Stale sandbox rows are NOT garbage-collected by v1 — they're treated as inactive in prod."* Alternatively (heavier but cleaner): tag `Subscription.environment` as a column and add it to the predicate in `auth/tier.ts`.

Without this, the "developer who tested in sandbox using their real account" eventually pollutes prod-tier resolution. Practical impact is low (only affects devs/QA), but it's a silent correctness bug.

---

### 2.7 `signedTransactionInfo` replay window asymmetry

**Severity: LOW (NIT-borderline).** **§5.2 check #5**

The prompt asked why 10 min for ASC-API responses but 1 hour for ASSN webhooks.

- **ASC-API roundtrip:** request initiated server-side, response signed by Apple in the same TCP exchange. 10-min `signedDate` skew tolerates clock-skew + ASC's internal signing latency. Any longer would mean the response was cached or replayed. 10 min is tight and correct.
- **ASSN webhook:** Apple emits the notification at the event time; their delivery can take seconds to minutes to a few minutes for retries. 1 hour bounds the legitimate "Apple queued and re-emitted" delay.

The asymmetry is **defensible** but the spec doesn't justify it. Apple's documented ASSN delivery SLA is "near real-time" with retries up to 5 days. The 1-hour bound is *much* tighter than the retry-window — a captured payload aged > 1h can no longer replay. Good.

**Recommendation (NIT):** §5.2 check #5 should add a parenthetical: *"(ASSN window is longer than ASC-API to tolerate Apple's retry-induced delivery latency, but still well below the 5-day retry-policy ceiling, so captured-and-replayed payloads age out quickly.)"* Helps the next reviewer understand why the two numbers differ.

---

### 2.8 Account merge / userId migration → orphaned binding

**Severity: MEDIUM.** **§12.1 / §3 (NEW gap not raised in round 1)**

The prompt raised this directly. Scenario:
1. UserA buys IAP → `User.iapAppleAccountToken = uuidv5(userA.id)`. JWS carries `appAccountToken = uuidv5(userA.id)`.
2. We later merge userA → userB (or migrate userA's data to a new userId). The "iap_apple" Subscription row is moved to userB.
3. **The `User.iapAppleAccountToken` is not transferable.** uuidv5 is deterministic over userId — userB's natural binding value would be `uuidv5(userB.id)`, which does NOT equal the stored `appAccountToken`.
4. ASSN renewal arrives → §5.3 step 4.1 finds the Subscription by `originalTransactionId` (works, points to userB) → §5.3 step 5 calls `syncSubscriptionFromIAP({..., expectedAppAccountToken: uuidv5(userB.id)})` → MISMATCH → 403.

The webhook attempts to call sync from inside step 5 — does it pass `expectedAppAccountToken`? Re-reading the spec:

> §5.3 Apple webhook step 5: "Call `syncSubscriptionFromIAP({platform: \"ios\", originalTransactionId, userId})`."

…no `expectedAppAccountToken`. So for the **webhook path**, the token check is implicitly skipped. Round-1 §4.2 made the check mandatory **inside `/billing/iap/checkout`**, but the spec didn't extend the requirement to webhook-triggered syncs. Re-reading §5.3 step 3 (checkout): the function signature there *does* pass `expectedAppAccountToken`. So the function's behavior depends on whether the arg is supplied.

This is actually **fine for the account-merge case** (the webhook can renew a merged subscription) but **bad for security**: a webhook with a forged-but-Apple-signed payload for a different user's `originalTransactionId` (effectively replay-after-token-rotation) would not be cross-checked against the resolved userId's expected `appAccountToken`. The webhook trusts the `Subscription.userId` lookup as the source of truth.

**Two findings here:**

**2.8a (MEDIUM):** Account-merge / userId-migration is undefined. Without a migration runbook step ("delete `User.iapAppleAccountToken` after merging" or "rewrite the binding to the new userId"), webhooks renewing the merged subscription continue indefinitely **but** any future Restore-flow call from userB will 403 because uuidv5(userB.id) != the appAccountToken baked into the receipt.

**Recommendation:** Add to §12.1 (or a new §12.2 "Account merge / migration"): *"Account merges / userId migrations MUST: (1) move all `Subscription` rows to the new userId, (2) clear `User.iapAppleAccountToken` / `iapGoogleObfuscatedId` on the new user, (3) flag the user with `pendingIapRebind` so the next mobile open prompts a Restore. The Restore flow detects the mismatch and either (a) blocks with 'subscription locked to prior account' or (b) provides a support escalation path. v1 should at minimum document this as a manual support ticket — `User.iap*` columns are NOT auto-migrated."*

**2.8b (LOW):** The webhook path doesn't enforce `expectedAppAccountToken` against the resolved userId. That's deliberate-but-undocumented. Add a sentence to §5.3 Apple webhook step 5: *"The webhook path does NOT re-verify the appAccountToken against the resolved userId, because the userId was either resolved via `Subscription.sourceSubscriptionId` (already-trusted prior binding) or via `User.iapAppleAccountToken` lookup (transitively the same value). The mandatory check lives in `/billing/iap/checkout` — webhook is downstream of that."* This clarifies the trust chain.

---

### 2.9 Apple Reader-app guideline wording

**Severity: LOW.** **§4 Plan picker empty-state**

R9 added: *"Do **not** add a web Stripe link on iOS (Apple guideline violation under Reader-app policy)."* Wording is clear and emphatic (bold "not"), with explicit guideline reference. An implementer copy-pasting this gets the message.

**However:** Apple's actual policy area is **3.1.1 (In-App Purchase) + 3.1.5 (Reader-app exception)** — the spec calls it "Reader-app policy" which is roughly correct but a non-expert reading the App Review Guidelines might not match the term. Tightening this to "Apple App Review Guideline 3.1.1 (in-app subscriptions cannot link to alternative payment flows)" would be more precise.

**Recommendation (NIT):** Replace "Apple guideline violation under Reader-app policy" with "Apple App Review Guideline 3.1.1 — in-app subs cannot link to external payment flows on iOS." Crisper for an implementer doing the second guideline-walk.

---

### 2.10 GDPR — "drop the row" loses refund/dispute audit trail

**Severity: MEDIUM.** **§12.1**

§12.1 step 3: *"we null out `Subscription.sourceCustomerId` and drop the row; the user keeps paying Apple/Google until they actually cancel."*

Two issues with "drop the row":

1. **Refund dispute trail:** If the user later disputes a charge with Apple/Google, our `WebhookEvent` table still holds the notification UUIDs but `Subscription` is gone — we cannot show "this user had an active sub on date X, status Y." Apple/Google audit requests (and Stripe Radar fraud reviews for the cross-source case) usually want the merchant-side record. Hard-deleting the row loses this.
2. **Tax (Canadian GST/HST):** Subscription revenue is taxable. Our books need to reconcile "rows of subscriptions during period P" against Apple/Google payouts during P. Hard-deleting a row mid-period creates a reconciliation gap.

GDPR's "right to erasure" (Art. 17) has a §3(b) exemption for legal obligations (including tax retention — typically 6 years in CA). Stripe handles this by retaining the Customer row but redacting PII fields. We should mirror.

**Recommendation:** §12.1 step 3 should say: *"We null out `Subscription.sourceCustomerId` and PII-bearing fields (none currently, but if any are added later) but **retain** the `Subscription` row with `userId` set to a tombstone or `null` (depending on FK semantics). GDPR Art. 17(3)(b) tax-retention exemption applies — subscription billing records are kept for 6 years for CRA compliance. Hard-delete only after the retention window."*

This is a real compliance gap. **MEDIUM** because the v1 IAP launch likely won't trigger account deletions before this is fixed, but the spec as written tells the implementer to do the wrong thing.

---

## 3. Severity tally (new findings only)

| Severity | Count | Items |
|---|---|---|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 3 | 2.5 (boot-validation log leak), 2.6 (sandbox-prod crossover), 2.8a (account-merge), 2.10 (GDPR audit retention) |
| LOW | 4 | 2.1 (cuid clarification), 2.2 (DoS rate-limit), 2.7 (window asymmetry rationale), 2.8b (webhook trust-chain doc) |
| NIT | 3 | 2.3 (receipt naming), 2.4 (sku privacy — no change needed), 2.9 (guideline citation) |

All round-1 items are **FIXED** or explicitly **AS-IS accepted**. Zero regressions introduced by R1–R10.

---

## 4. Verdict

**APPROVE WITH CHANGES.**

The R1–R10 fixes close every round-1 finding cleanly. The author also caught one independent edge case (R3 `linkedPurchaseToken` chain rewrite) that wasn't in the round-1 review. Quality of the revision is high.

The new findings are all bounded: zero CRITICAL, zero HIGH. The four MEDIUMs are addressable with text edits to the spec, no architectural change:

**Required before plan generation (MEDIUMs):**
1. **§5.1 (2.5):** Add explicit note that boot-time validation must not log any portion of the env value, only the var name.
2. **§5.4 or §8 (2.6):** Sandbox→production stale-row filter in `buildMeBody` / `effectiveTier`. Or document explicitly that sandbox-environment rows are dev-only and never reach prod (and enforce that with a deploy-time guard).
3. **§12 (2.8a):** Add account-merge / userId-migration runbook subsection. Even a "manual support ticket — not automated in v1" sentence is acceptable.
4. **§12.1 (2.10):** Change "drop the row" to PII-null + retain-for-6-years (GDPR Art. 17(3)(b) tax exemption).

**Nice-to-have (LOWs / NITs):** can land alongside implementation or in the plan, not blocking.

Once the four MEDIUMs above are in the spec, this is good to advance to a plan.
