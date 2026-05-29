# Architecture Review — Mobile IAP Billing Design (Round 2)

**Reviewer role:** Architecture / design reviewer
**Spec under review:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md` (HEAD `75b45a2`)
**Round 1 review:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design-review-architecture.md`
**Date:** 2026-05-26

---

## 0. Commits applied since round 1

```
75b45a2 R10 — refresh §14 plan slice for post-review architecture
78251d6 R9 NIT — mobile + operational refinements
fb0b5e4 R8 NIT — shared-lib conventions + body field rename
eeacb4f R7 MEDIUM — account-deletion, Family Sharing boundary, ASC roundtrip rationale
23439a7 R6 MEDIUM — status mapping refinements
69540f7 R5 HIGH — deterministic buildMeBody source preference + log redaction
1c2f50e R4 HIGH — first-purchase race fix + binding columns + explicit token match
ebb6eeb R3 HIGH — Apple originalTransactionId + Google linkedPurchaseToken
79e8af9 R2 HIGH — Apple JWS hardening + Google OIDC tightening
7161442 R1 CRITICAL — Google acknowledge step + .update scope
```

Ten commits, one per major review thread. Mapping looks clean.

---

## 1. Round-1 must-fix verification

### (1) Google `acknowledge` + service-account `subscriptions.update` scope — **FIXED**

§5.2 `google-client.ts`:
> "Also calls `purchases.subscriptionsv2.acknowledge` after every successful upsert when the validated `acknowledgementState === ACKNOWLEDGEMENT_STATE_PENDING` — Google auto-refunds and revokes the purchase if not acknowledged within 3 days. The call is idempotent so we run it on every sync (initial + webhook). Acknowledge failure is non-fatal (logged + retried on next webhook), but acknowledge MUST run **after** the local upsert lands so we never acknowledge a purchase we couldn't record."

§7 spells out the full client/server handoff (steps 1–5), explicitly defers `finishTransaction` until after server returns 2xx, and notes the idempotent safety net on subsequent webhooks. §11 (Google ops) step 2 grants both `androidpublisher.subscriptions.get` **and** `subscriptions.update`. §14 slice #5 includes `subscriptionsv2.acknowledge` and slice #9 asserts "mandatory acknowledge on Google (integration test asserts it runs)."

The "acknowledge after upsert" ordering is the right call — protects against the race where ack succeeds but our DB write fails, leaving a charged-but-unrecorded purchase.

### (2) Apple `sourceSubscriptionId = originalTransactionId` explicit — **FIXED**

§3 "Subscription ID contract":
> "Apple: `Subscription.sourceSubscriptionId = originalTransactionId` ALWAYS. Never `transactionId` (which rotates per renewal). `originalTransactionId` is stable across renewals and is the subscription identity. The checkout route, the webhook handler, and `syncSubscriptionFromIAP` must all normalize to `originalTransactionId` before upserting — otherwise checkout-route and webhook target different rows and we get duplicate `Subscription` records per user."

§5.2 `sync-sub.ts` takes `{platform: "ios", originalTransactionId}` not `transactionId`. §5.3 webhook step 3 reads `signedTransactionInfo.originalTransactionId`. Consistent end-to-end.

### (3) Google `linkedPurchaseToken` upgrade chain handling — **FIXED (with a chain-depth caveat — see §3 below)**

§7:
> "`google-client.ts` MUST, before any insert, check for `linkedPurchaseToken` and rewrite the existing row via `prisma.subscription.update({ where: { source_sourceSubscriptionId: { source: 'iap_google', sourceSubscriptionId: linkedPurchaseToken }}, data: { sourceSubscriptionId: newToken, ... }})`. If the linked row doesn't exist (out-of-order delivery), fall through to upsert under the new token and rely on the eventually-consistent reconciliation by the next sync."

§5.3 google webhook step 4.1 also fans out the existing-sub lookup across both `purchaseToken` AND `linkedPurchaseToken`. §14 slice #5 carries it.

### (4) `buildMeBody` deterministic source preference — **FIXED**

§8:
> "**Deterministic source preference in `buildMeBody`**: when multiple active subs exist, pick by `(tier === 'pro') > (tier === 'lite')` first, then break ties by `source === 'stripe' > 'iap_apple' > 'iap_google'`, then by `createdAt ASC`."

§14 slice #8 explicitly carves out `buildMeBody` precedence fix as an independent task with multi-active unit tests. Cross-references `billing.ts:36-37` correctly (that's the `find(pro) ?? activeSubs[0]` line).

Caveat under "newly introduced issues" §3 below — the rule's effect on the `billingOwnedByMobile` UI gate isn't fully internally consistent.

### (5) Android resubscribe-after-expiry — webhook fallback — **FIXED**

§3 introduces the `User.iapAppleAccountToken` / `User.iapGoogleObfuscatedId` reverse-lookup columns. §5.3 google webhook step 4.2:
> "Fallback: fetch the v2 purchase via `purchases.subscriptionsv2.get`, read `externalAccountIdentifiers.obfuscatedExternalAccountId`. `User.findUnique({ where: { iapGoogleObfuscatedId: ... }})` → matched user, create the missing `Subscription` row here (covers webhook-before-checkout race AND Android resubscribe-after-expiry, which always issues a brand-new purchaseToken)."

Plus step 4.3: "Still unknown → return 500 (NOT 200). Pub/Sub retries..." — closes the round-1 "200-and-drop loses the user's purchase forever" gap.

Apple side has the symmetric fallback at §5.3 step 4.2 reading `appAccountToken` from the verified JWS.

### (6) `ApiErrorCode` additions in `libs/shared/src/errors.ts` (no parallel file) — **FIXED**

§3:
> "**No separate `iap-errors.ts` file.** Append IAP codes to the existing `ApiErrorCode` union in `libs/shared/src/errors.ts` (`API_ERROR_CODES` array). New codes: `invalid_receipt`, `expired_receipt`, `product_mismatch`, `already_subscribed_stripe`, `already_subscribed_iap`, `user_mismatch`, `platform_unavailable`, `iap_not_configured`."

Confirmed against `libs/shared/src/errors.ts:8-86` — the new codes slot into the existing `as const` array. §14 slice #1 names this work explicitly.

### (7) DTO file location — request bodies → `schemas/iap.ts` — **FIXED**

§3 names `libs/shared/src/schemas/iap.ts` for `IAPCheckoutBody` / `IAPRestoreBody`. Matches the existing `schemas/billing.ts` pattern (`CheckoutBody`, `SyncBody`). No `dto/iap.ts` referenced anywhere.

---

## 2. Round-1 should-do verification

### Sandbox routing for `APPLE_ENV` — **FIXED**

§5.1: "routes apple-client between `api.storekit-itc.apple.com` (sandbox) and `api.storekit.itunes.apple.com` (prod). MUST also match the `environment` claim in verified JWS (see §5.2 check #4)." Cross-referenced from §5.2 check #4 ("rejects sandbox JWS in prod (the 'free Pro' exploit)").

### Plan picker empty-state — **FIXED**

§4: "**Empty-state fallback:** if `getSubscriptions` returns `[]` (misconfigured ASC/Play products, sandbox tester not signed in, Expo Go runtime, network failure), render an inline 'Subscriptions aren't available right now — try again later' message rather than a blank screen. Do **not** add a web Stripe link on iOS (Apple guideline violation under Reader-app policy)."

### Restore-on-plan-picker — **FIXED**

§4: "A 'Restore purchases' button MUST appear on the plan picker screen (`/plan`) regardless of subscription state — new mobile users reinstalling who had a prior purchase land here, not in More tab. This is the placement Apple's reviewers actually check."

### Google deep-link sku derivation — **FIXED**

§4: "Android: `https://play.google.com/store/account/subscriptions?package=...&sku=<currentProductId>` where `currentProductId` is derived from `me.subscription.tier` via the inverse of `IAP_PRODUCT_IDS` — hard-coding the wrong sku 404s the deep link."

### `expo prebuild` / dev-client warning — **FIXED**

§4: Loud "⚠ Dev workflow break — Expo Go cannot exercise IAP" callout with the four implications. Explicitly cross-references `project_mobile_dev_network.md`. §10 testing strategy adds "Both: requires a dev client build, NOT Expo Go (see §4 warning)." §14 slice #11 says "Document Expo Go limitation in repo CLAUDE.md."

---

## 3. Newly-introduced issues

### NEW-1. **BUG (MEDIUM): Webhook 500s indefinitely for deleted users.**

§3 introduces `User.iapAppleAccountToken @unique`. §5.3 step 4.3 says "still unknown → return 500 (NOT 200). Apple retries up to 5x over 3 days." §12.1 "Account deletion" says "We null out `Subscription.sourceCustomerId` and drop the row; the user keeps paying Apple/Google until they actually cancel."

Combined race: userA subscribes → user record deleted (cascade drops Subscription) → renewal webhook fires → step 4.1 misses (no Subscription) → step 4.2 misses (no User row, so no `iapAppleAccountToken` column either) → 500 → Apple retries 5x over 3 days → all 500 → event drops permanently. Pub/Sub on Google side will retry longer per the topic's policy, and "500 with no resolution" is the worst possible outcome — log spam, alert fatigue, store-side rate-limit risk.

This is not necessarily wrong (you can't usefully process a notification for a vanished user), but the spec needs to **distinguish "unknown user we expect to learn about soon"** (return 5xx → store retries) from **"unknown user that will never resolve"** (return 200 + log to forensic store).

Suggestions:
- After step 4.2 fails, do a secondary check: `WebhookEvent.create({source, type: "iap_unattributable_renewal", payload: {appAccountToken, productId}})` and return **200**. The forensic trail survives, the store stops retrying.
- Or: keep `User.iapAppleAccountToken` after deletion as a tombstone (move it to a separate `IAPDeletedBinding` table). Then step 4.2 can return a deterministic "user-deleted" 200 instead of a vague 500.

The round-1 reviewer's concern was "200-and-drop is risky." The round-2 fix swung to "500-forever." Neither extreme is right; you need a third path for "we tried, user is gone."

### NEW-2. **NIT: `linkedPurchaseToken` chain rewrite is not chain-aware.**

§7 handles the **single-link** case: `oldToken → newToken` rewrites the existing row to point at `newToken`. But what about a user who upgrades **twice within a billing window**? Sequence:
1. User on `lite_monthly` (purchaseToken=A).
2. Upgrades to `pro_monthly` → new purchaseToken=B, `linkedPurchaseToken=A`. We rewrite row to `sourceSubscriptionId=B`. ✓
3. Downgrades back to `lite_monthly` → new purchaseToken=C, `linkedPurchaseToken=B`. We do `update where sourceSubscriptionId=B → C`. ✓

Actually this is fine because each link only references the **immediate predecessor**, not the original. Verified by re-reading the rule: "rewrite the existing row via `prisma.subscription.update({ where: { ... sourceSubscriptionId: linkedPurchaseToken }, ...})`."

**But:** if event for purchaseToken=C arrives **before** event for purchaseToken=B (Pub/Sub out-of-order, which it allows), step §7 says "fall through to upsert under the new token and rely on the eventually-consistent reconciliation by the next sync." The "next sync" must then notice that purchaseToken=C now exists as both an orphan row AND a `linkedPurchaseToken` reference from a later state. The spec doesn't say what reconciles the orphan. The result is two rows for the same logical subscription until the **next event** arrives. Within the active-sub 409 guard window (§5.3 step 2), a user trying to do a fresh `/billing/iap/checkout` during this transient would hit the 409 and bounce.

CONSIDER tightening §7: when upserting under a new token without a matching `linkedPurchaseToken` predecessor, **scan for any other active row for the same `(userId, source=iap_google)`** and either reject or merge. The userId can be resolved at this point because `obfuscatedExternalAccountId` is in the v2 response.

Out-of-order Pub/Sub delivery is rare but documented behavior — flagging because the spec implies it's handled but isn't quite.

### NEW-3. **CONSIDER: `buildMeBody` cross-tier collision still flips `billingOwnedByMobile`.**

The round-1 concern was "a Stripe user who fat-fingered an extra IAP purchase will suddenly see the IAP Restore/Manage UI flip in More tab." The §8 fix `(tier, source, createdAt)` ordering preserves Stripe **only when same-tier**.

Scenario the fix doesn't cover:
1. User on Stripe `lite` (`source=stripe`, primary in `buildMeBody`).
2. User fat-fingers an `pro_monthly` purchase on iOS.
3. New row: `source=iap_apple, tier=pro`.
4. `buildMeBody` picks IAP first by `(tier === "pro") > (tier === "lite")` regardless of source.
5. `subscription.source` flips to `iap_apple` → More tab "Manage billing" now deep-links to Apple Settings instead of Stripe Portal.
6. **User cannot cancel their Stripe sub from inside Fina anymore.** They'd have to find the Stripe Portal URL out-of-band.

§8 says "Support task to reach out + ask which to keep" — but during the window between purchase and support contact, the user is locked out of Stripe cancel UX. Round-1 raised exactly this concern; the §8 rule only solves half of it.

Options (each defensible, pick one explicitly):
- (a) When both sources are active, ALWAYS prefer Stripe regardless of tier. Rationale: Stripe is the source the user originally chose; respecting that until support resolves the dup is the principle of least surprise.
- (b) Show **both** Manage Billing entries in More when `multi_source_active` — "Manage Stripe subscription" + "Manage Apple subscription" as separate rows. Slightly more code; resolves the UX bind cleanly.
- (c) Accept the trade-off as-is and document that cross-tier dup means user must contact support for Stripe-side cancel. Spec doesn't currently say this.

Round-1 verdict on this item said "Stripe-first tiebreak". The author implemented "Stripe-first tiebreak **within same tier**" which is a narrower interpretation. Worth a sentence in §8 either reaffirming the narrower scope (and accepting NEW-3 as a known limitation) or widening to option (a).

### NEW-4. **NIT: `IAP_NAMESPACE` constant placement isn't slice-allocated.**

§6, §5.3, §14 slice #11 all reference `IAP_NAMESPACE` as living in `@fina/shared/iap`. But §14 slice #1 (`@fina/shared` additions) lists `iap/productIds.ts`, `schemas/iap.ts`, errors.ts — **not** a `iap/namespace.ts` or equivalent. Slice #11 says "`IAP_NAMESPACE` constant lives in `@fina/shared/iap`" but slice #11 is the mobile slice, which can't be the one creating shared-lib content (shared-lib-first rule).

Fix: explicit mention in slice #1 — "add `IAP_NAMESPACE` UUID constant to `libs/shared/src/iap/namespace.ts` (or co-locate with `productIds.ts`)."

### NEW-5. **NIT: `transactionToken` ghost reference.**

Grepped the spec for the old name: only one residual occurrence at §3 line 59: "Field renamed `transactionToken` → `receipt`". That's the rename callout itself, which is fine to keep. No other stale references. ✓

But: the round-1 review uses the old name `transactionToken` (line 24, line 86). The author may want to update the round-1 review file with an addendum or the round-1 reviewer may need to be told the schema name moved. NIT, not a spec defect.

### NEW-6. **NIT: `User.iap*` columns + deterministic derivation are over-specified.**

The spec writes `iapAppleAccountToken = uuidv5(userId, IAP_NAMESPACE)` (deterministic from userId). It then **stores** this in a unique column. But since the value is a pure function of userId, the column adds no information — given `appAccountToken`, you could in principle iterate users and find the matching one... except you can't because there's no inverse (uuidv5 is one-way).

So the column is justified because it's the **only** way to reverse-resolve userId from an `appAccountToken`. ✓

But there's a subtle design tension worth flagging: because the value is deterministic, the column is **redundant with the userId itself** for any user we already know. A simpler alternative: dedicated `IAPUserBinding { tokenHash String @id, userId String }` table indexed for reverse lookup, decoupled from User. This survives `User` deletion (NEW-1) cleanly — you can tombstone the binding without keeping the user.

Not a bug. CONSIDER for the schema design — the current "two unique columns on User" approach works but has the deletion-tombstone issue.

### NEW-7. **NIT: Plan slice #14.13 ("End-to-end sandbox smoke") drift.**

§14 says 13 slices. Slice #13 is "End-to-end sandbox smoke — manual checklist (in plan, not code). Covers all four launch gates in §11." §11 lists **four** launch gates AND a separate "Credential rotation (postlaunch runbook)" section. Slice #13 should explicitly mention which gates it covers (the four numbered ones, not the rotation runbook).

Also, the spec text references slice count "12" implicitly in older sections — search confirms §14 line 362 says "~13 tasks" explicitly. Round-1 said 12 slices; round-2 added slice #8 (`buildMeBody` precedence fix as an independent task). That's a justified split. No orphan tasks.

---

## 4. Decomposition check (now 13 slices)

- Slice #4 (`apple-client`) ‖ #5 (`google-client`) — parallel-flagged. ✓
- Slice #8 (`buildMeBody` precedence) ‖ — newly added; small enough to be its own slice OR could fold into slice #7 (`sync-sub`). Folding would create coupling between IAP code and a shared `buildMeBody` change that affects Stripe-only users too. Keeping it independent is correct.
- Slice #9 (routes) ‖ #10 (webhooks) — independent.
- Slice #6 (`webhook-verify`) is sequential after #4/#5 because it "reuses #4's checks" — correct ordering.

Slice count of 13 is the high end of acceptable but every slice is a discrete unit with discrete tests. No merging recommended.

One missing dependency annotation: slice #7 (`sync-sub`) depends on #4 + #5 + #6 (uses all three). The plan slice text doesn't say so explicitly. NIT.

---

## 5. Internal consistency check (§3 ↔ §5.3 ↔ §6/§7 ↔ §14)

- §3 says `User.iapAppleAccountToken` / `User.iapGoogleObfuscatedId` are `String? @unique`. §14 slice #2 names both columns with `(unique)`. ✓
- §5.3 Apple step 4.2 reads `appAccountToken` from the JWS, queries `User.findUnique({where: {iapAppleAccountToken: ...}})`. ✓ matches column name.
- §5.3 Google step 4.2 reads `externalAccountIdentifiers.obfuscatedExternalAccountId`, queries `User.findUnique({where: {iapGoogleObfuscatedId: ...}})`. ✓ matches column name.
- §6 says "stored as `Subscription.sourceCustomerId`" — keeps the per-row column for forensic/dedup. §3 confirms: "`Subscription.sourceCustomerId` continues to hold the same `appAccountToken` / `obfuscatedAccountId` per-row for forensic/dedup convenience; the `User.iap*` columns are the canonical user→token binding." ✓ consistent.
- §6 says "Mobile derives `appAccountToken` deterministically from Fina `userId` via `uuidv5(userId, IAP_NAMESPACE)`." §5.3 step 3 says `expectedAppAccountToken: uuidv5(userId, IAP_NAMESPACE)`. ✓
- §7 says "Mobile uses `obfuscatedAccountId` (Fina userId, hashed via SHA-256 hex, max 64 chars per Google's limit)." §5.3 step 3 says `expectedObfuscatedAccountId: sha256(userId)`. ✓
- §5.4 Google status mapping table covers `SUBSCRIPTION_STATE_CANCELED + expiryTime > now` → `active + cancelAtPeriodEnd=true`, and `SUBSCRIPTION_STATE_CANCELED + expiryTime <= now` → `canceled`. §5.4 `cancelAtPeriodEnd` derivation row says "Google: explicit `subscriptionState === CANCELED` AND `expiryTime > now`." ✓ consistent.

Three minor inconsistencies:

**INC-1.** §5.2 `sync-sub.ts` signature: "`syncSubscriptionFromIAP(env, args, userId, log)`. Takes either Apple (`{platform: 'ios', originalTransactionId}`) or Google (`{platform: 'android', productId, purchaseToken}`)." But §5.3 step 3 calls it with `syncSubscriptionFromIAP({platform, productId, receipt, userId, expectedAppAccountToken, expectedObfuscatedAccountId})` — **one** flat object, not `(env, args, userId, log)`. Different arities. The Stripe pattern at `apps/api/src/stripe/sync-sub.ts` is `syncSubscriptionFromStripe(env, sub.id, user.id, app.log)` — positional. Mixing positional + object is fine, but pick one and be consistent. §5.2 says positional `(env, args, userId, log)` where `args` is the object — that's the cleanest read and matches §5.3 step 3's flat call if you assume `args` is the inner object. But §5.3 step 3 also passes `userId` INSIDE the object (last arg in the literal). Tighten §5.3 step 3 to match the §5.2 signature, or update §5.2.

**INC-2.** §5.3 Apple webhook step 4 ordering ("Resolve userId, in order:") only enumerates **two** lookups + a 500 fallback. §5.3 Google webhook step 4 enumerates the same **two** lookups + 500. ✓ symmetric. But §3 line 77 says "Webhook does `prisma.user.findUnique({ where: { iapAppleAccountToken: ... } })` (or the Google equivalent) and creates the missing `Subscription` row in-place." That's the 4.2 fallback, but §3 frames it as the *primary* path; §5.3 frames it as the *fallback*. The §5.3 ordering (Subscription → User binding → 500) is the right one — fix §3 line 77 to match the explicit 2-step resolution rather than implying single-step.

**INC-3.** §10 testing strategy says "webhook unknown originalTransactionId path" for integration tests. But the new behavior is "500-not-200" — the test name suggests it tests the **resolution** path, not the **500-fallback** path. Worth adding "webhook 500 fallback when neither Subscription nor User-binding matches" as a discrete test case.

---

## Verdict

**APPROVE WITH CHANGES.**

All seven round-1 must-fix items are addressed. All five round-1 should-do items are addressed. Quality of fixes is high — the author engaged with the spirit of each finding rather than the letter.

**New must-fix (1 item):**
- **NEW-1**: Distinguish "transient unknown user" (retry) from "permanent unknown user" (forensic 200) in §5.3 step 4.3. The current "return 500 forever" creates a worse failure mode than the round-1 "200-and-drop." Add either a tombstone strategy (NEW-6 hints at it) or a retry-count cap + forensic dump.

**New should-do (3 items, NIT-level):**
- **NEW-3**: Spell out the cross-tier `buildMeBody` collision UX in §8 (either widen Stripe-preference to all collisions, or document the lockout). Pick (a) or (c) and write it down.
- **NEW-4**: Add `IAP_NAMESPACE` constant to §14 slice #1 explicitly.
- **INC-1**: Reconcile §5.2 `syncSubscriptionFromIAP` signature with §5.3 step 3's call site.

**Defer / OK as-is:**
- NEW-2 chain rewrite out-of-order edge case (rare, eventually-consistent acceptable for v1).
- NEW-5 stale `transactionToken` reference in round-1 review file (not a spec defect).
- NEW-6 `IAPUserBinding` table refactor (current approach works; refactor only if NEW-1 fix needs it).
- NEW-7 slice #13 scope drift (cosmetic).
- INC-2 §3 ↔ §5.3 framing mismatch (cosmetic).
- INC-3 testing strategy missing one case name (testing slice already covers the path; just add the case).

Once **NEW-1** is folded in (and ideally the three should-dos), this is ready for plan-slicing → code.

Decomposition is sound at 13 slices. Internal consistency is high — three minor framing inconsistencies, no contradictions in the design itself.
