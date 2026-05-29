# Mobile IAP Billing — Plan Security Review, Round 4

**Plan reviewed:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md` @ `158669a`
**Prior reviews:** R1 (design spec), R2 (`*-review-security.md`), R3 (`*-review-security-r3.md`)
**P-commits verified:** P9 `8fc2230`, P10 `5c68280`, P11 `0d41e33`, P11b `158669a`
**Date:** 2026-05-26
**Reviewer focus:** Verify round-3 must-fix list closed; surface regressions from P9-P11b; end-to-end flow walkthrough.

---

## Executive summary

All four round-3 must-fix items are now closed with code-level patches (not just prose):

- **N3.5 HIGH** `writeAccountDeletionTombstones` non-atomicity → **FIXED** via batch `prisma.$transaction([...upserts])`.
- **N3.2 MEDIUM** `getSubscriptionStatus` dedicated decoders → **FIXED** in code block; stale prose remains as a NIT.
- **N3.3 MEDIUM** Redact list divergence → **FIXED** by converting Task 3.8 to a no-op pointer.
- **N3.4 LOW** Mobile parity test placeholders → **FIXED** by computing expected values inline on both sides.
- **HIGH 11.1 PARTIAL** (R2) runtime appAccountToken check → **DEFERRED (acceptable)** — pin to ^14 closes the practical risk; verdict from R3 stands.

The patches introduce a small number of new concerns — none CRITICAL or HIGH. Two MEDIUMs and a handful of LOW/NITs:

| Sev | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 0 |
| MEDIUM | 2 |
| LOW | 3 |
| NIT | 3 |

Most notable new findings:
- **N4.1 MEDIUM** — `validateAppleRoots()` placeholder-detection regex (`/<<</`) is dead code. The placeholder PEM uses `<<INSTALLER` (two angles, not three). The X509 parse step catches the placeholder anyway, so security is intact, but the *explicit* "placeholder detected → install real PEM" error message never fires. Same bug in the `apple-roots.test.ts` regex.
- **N4.2 MEDIUM** — `apps/mobile` has no Vitest config and no existing tests. P11/P11b add `apps/mobile/src/iap/__tests__/*.test.ts` and assume `npx vitest run` works. Without a config (jsdom env, transform settings, alias), the binding-parity test will fail to even bootstrap.
- The end-to-end walkthrough for the deleted-user webhook (Apple ASSN → tombstone hit → 200) is complete and correctly encoded in code; no gap.

---

## 1. Round-3 must-fix verification

### N3.5 HIGH — `writeAccountDeletionTombstones` in transaction

**Status: FIXED.**

Patched section (plan lines 4232-4248):

```ts
const userIdHash = hashBindingToken(userId);
// Wrap in $transaction so a failure on the Google tombstone doesn't
// leave a half-tombstoned user (Apple tombstone committed, Google
// missing → Google webhooks 500 for 5 retries before the per-token
// cap trips). Batch transaction is atomic across both upserts at the
// SQL layer — no nested global-prisma writes (see billing-webhook.ts:42-47
// for the rationale Prisma's interactive tx-with-global-client deadlock
// pattern we deliberately avoid).
await prisma.$transaction(
  tombstones.map((t) =>
    prisma.iapDeletedBinding.upsert({
      where: { source_tokenHash: { source: t.source, tokenHash: t.tokenHash } },
      create: { source: t.source, tokenHash: t.tokenHash, userIdHash },
      update: {}, // idempotent
    }),
  ),
);
```

This is the **batch-transaction form** (Prisma compiles to a single SQL transaction wrapping both `INSERT ... ON CONFLICT` statements). Atomic at the SQL layer. Picks Option 2 from R3 — simpler than the optional `tx` parameter, and there are no external interactive-tx callers yet to break.

**Comment notes**: the runbook example at lines 4282-4287 still shows the helper called inside `prisma.$transaction(async (tx) => { ... })` — but `writeAccountDeletionTombstones` uses the global `prisma`, not the `tx` handle. **This nesting is a Prisma anti-pattern** (interactive-tx-with-global-prisma deadlock). However the runbook is *advisory text* for a future implementer; the deletion flow doesn't exist yet. When it lands, the future implementer needs to either:
- Stop nesting (run `writeAccountDeletionTombstones` BEFORE the interactive tx), or
- Refactor the helper to accept an optional `tx` (Option 1 from R3).

See **N4.4** below for the runbook ambiguity.

**Verdict:** Helper non-atomicity is FIXED. Runbook nesting is a documented-future-gotcha (N4.4 LOW).

### N3.2 MEDIUM — `getSubscriptionStatus` dedicated decoders

**Status: FIXED.**

Patched code block (plan lines 1335-1344):

```ts
// Decode each inner JWS through its DEDICATED Apple SDK verifier —
// signedTransactionInfo through the transaction verifier (which
// re-runs the 6 checks: alg, root, bundleId, environment,
// signedDate, appAccountToken — defense-in-depth), and
// signedRenewalInfo through the renewal-info verifier (different
// payload shape: autoRenewStatus, offerType, autoRenewProductId).
// Do NOT use _decodeAndVerifyJws — that's the generic JWS seam
// used only by the public verifier methods.
const verifiedTx = await this.verifyAndDecodeTransaction(item.signedTransactionInfo, { context: "asc-api" });
const renewal = await this.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
```

The code now uses the dedicated `verifyAndDecodeTransaction(...)` (with `context: "asc-api"` → 10-min signedDate window) and `verifyAndDecodeRenewalInfo(...)` (SDK's renewal-info verifier).

**Stale prose at line 1418:** the trailing instruction *"Also update `getSubscriptionStatus` to call the dedicated decoders…"* is still present even though the code above already does it. The instruction is now a contradicting no-op. See **N4.5 NIT**.

**Verdict:** Code is correct. Stale prose is a doc-only nit.

### N3.3 MEDIUM — Redact list divergence

**Status: FIXED.**

Patched section (plan lines 888-890):

```
- [ ] **Step 3.8: Run full API test suite (smoke)**

Pino redact paths are already wired in Step 0.4 (Task 0). No additional logger configuration needed here.
```

Task 3.8 is converted from "extend the redact config" into a smoke-test step with a one-line note. The implementer reads top-to-bottom, lands the full Task 0.4 redact list once, and Task 3.8 doesn't try to re-write it. No regression hazard.

**Verdict:** FIXED.

### N3.4 LOW — Mobile parity test placeholders

**Status: FIXED.**

Patched section (plan lines 3612-3621):

```ts
// apps/mobile/src/iap/__tests__/binding-parity.test.ts
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { IAP_NAMESPACE } from "@fina/shared";

const FIXTURE_USER_ID = "fixture-user-id";
// Compute expected values inline using the same primitives the server
// uses (uuidv5 + node:crypto sha256). No copy-paste literals — if
// IAP_NAMESPACE ever changes, both sides re-derive together and the
// test catches any encoding divergence (UTF-8 vs UTF-16, normalization).
const EXPECTED_APPLE = uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE);
const EXPECTED_GOOGLE = createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex");
```

No more `<paste from server test on first run>` placeholders. Both server and mobile compute expected values inline from the same primitives. If `IAP_NAMESPACE` changes, both sides re-derive together. The actual parity assertion compares the mobile-side `deriveAppleToken / deriveGoogleToken` (which use `js-sha256`) against `node:crypto.createHash("sha256")` — verifying that `js-sha256` produces identical bytes to `node:crypto` for the same UTF-8 input.

**Verdict:** FIXED. (But see **N4.2 MEDIUM** below about mobile vitest config absence.)

### HIGH 11.1 PARTIAL (from round 2) — runtime appAccountToken check

**Status: DEFERRED (acceptable, no regression).**

The R3 verdict stands: pin to `react-native-iap@^14` (plan line 3486) closes the practical risk that "rn-iap renames the param and every iOS purchase silently fails." The runtime pre-check (local JWS decode in `purchaseSubscription` before POSTing to the server) is still skipped. The server enforces `expectedAppAccountToken` (sync-sub.ts plan line 2344) so a misforwarded token surfaces as a 403, which is the actual security guarantee.

**Verdict:** No change since R3. Acceptable as LOW.

---

## 2. New security issues from P9-P11b

### N4.1 [MEDIUM] `validateAppleRoots` placeholder-detection regex is dead

**Location:** plan lines 1206-1211 (`apple-client.ts validateAppleRoots`) + plan lines 1473-1480 (`apple-roots.test.ts`).

The placeholder PEM literal at plan line 1442 uses **two angle brackets**:

```
<<INSTALLER: paste the real Apple Inc. Root CA G3 PEM here. Module-load
 validation will throw "APPLE_ROOT_CERTS contains a placeholder" until
 this is done — that's intentional.>>
```

The runtime check at plan line 1206 looks for **three** angle brackets:

```ts
if (pemStr.includes("<<<") || pemStr.includes(">>>")) {
  throw new Error(
    "APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM. " +
      "See https://www.apple.com/certificateauthority/",
  );
}
```

`pemStr.includes("<<<")` returns `false` on `<<INSTALLER...>>` because two `<` ≠ three `<`. So the explicit placeholder-detection branch **never fires**.

Same bug in `apple-roots.test.ts` at plan lines 1477-1478:

```ts
expect(s).not.toMatch(/<<</);     // never matches placeholder — dead assertion
expect(s).not.toMatch(/INSTALLER/);  // DOES match placeholder — saves the day
```

**Why security is still intact:** Both safety nets catch the placeholder via OTHER paths:
- In `validateAppleRoots`: line 1213 `new X509Certificate(pem)` throws on the unparseable placeholder text. Different error message ("unparseable certificate") but still throws at module load.
- In `apple-roots.test.ts`: the `/INSTALLER/` regex matches the placeholder. Also, test 2 calls `new X509Certificate(pem)` which throws.

**Net behavior:** the engineer running on a fresh checkout still gets a fail-loud error before any test runs — but the error is "unparseable certificate" instead of the more actionable "APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM. See https://www.apple.com/certificateauthority/". UX regression on the install path; no security weakening.

**Severity: MEDIUM** (doc-friendly error message is degraded; the explicit safety net documented in self-review §"Placeholder scan" doesn't fire as advertised).

**Remediation (text-only):**
1. Change line 1206: `pemStr.includes("<<")` instead of `<<<` (matches the actual placeholder).
2. Change line 1477: `expect(s).not.toMatch(/<</)` (and corresponding `>>` variant if intended). Or remove the `<<<` assertion entirely and rely on `/INSTALLER/`.
3. Alternatively: change the placeholder literal at line 1442 to use `<<<INSTALLER: ...>>>` (three angles) so the existing regex matches. This is the smallest change — only edit line 1442 (the placeholder content) so it reads `<<<INSTALLER: paste ... intentional.>>>`.

The "three angles on placeholder content" fix is the least error-prone — change one literal, every detection path becomes consistent. **Recommendation:** edit line 1442.

### N4.2 [MEDIUM] `apps/mobile` has no Vitest configuration

**Location:** plan Step 11.5 (line 3559) and Step 11.5b (line 3634).

The plan instructs:

```
cd apps/mobile && npx vitest run src/iap/__tests__/binding.test.ts
cd apps/mobile && npx vitest run src/iap/__tests__/binding-parity.test.ts
```

Reality:
- `apps/mobile/package.json` has zero existing test entries, no `vitest` dep, no `test` script.
- No `apps/mobile/vitest.config.ts` exists.
- No `*.test.ts` or `*.test.tsx` files exist under `apps/mobile/`.
- The mobile package is an Expo React Native app (`react`, `react-native`, `expo`, `expo-router`).

When `npx vitest run` is invoked from `apps/mobile`, it falls back to the workspace-root `vitest.config` (if any), or to defaults. The binding-parity test imports `@fina/shared` (workspace alias) and `node:crypto`. Vitest's Node environment exposes `node:crypto`, but:
- Without an explicit `apps/mobile/vitest.config.ts`, Vitest auto-discovery may not find `apps/mobile/src/iap/__tests__/binding-parity.test.ts` at all (the workspace's root vitest setup likely globs from `apps/api` / `libs/shared`).
- `@fina/shared` alias resolution depends on the test's resolve config. Without a mobile-side config, the `import { IAP_NAMESPACE } from "@fina/shared"` may fail to resolve.

The brief flagged a related concern: "If apps/mobile/vitest.config uses jsdom env or RN preset, the test may run in an environment that doesn't expose `node:crypto`." That's the FUTURE risk if the implementer adds a jsdom config. Today's risk is the opposite — there's no config at all, and the tests are likely undiscoverable.

**Severity: MEDIUM** — this is a blocking implementation gap. The implementer running `npx vitest run` in `apps/mobile` will see "no test files found" or a resolve error before the test even attempts to assert.

**Remediation (Task 11 must add):**
1. Add `apps/mobile/vitest.config.ts` with `environment: "node"` (explicitly NOT jsdom; the parity test needs `node:crypto`) and the workspace alias for `@fina/shared`.
2. Add `vitest` + `@vitest/ui` to `apps/mobile/package.json` devDependencies, OR rely on the root workspace's hoisted vitest (verify it actually resolves).
3. Verify with: `cd apps/mobile && npx vitest run src/iap/__tests__/binding-parity.test.ts` actually PASSES on a fresh clone after Step 11.1 install.

Alternative: move the mobile-side parity test into `libs/shared` (server-side) since it's pure-JS and doesn't exercise any RN-specific runtime. The "cross-runtime parity" guarantee would shift from "vitest-node vs vitest-node" to "test → actual mobile build" which is even weaker. Best to set up the mobile vitest config.

### N4.3 [LOW] ASC `getSubscriptionStatus` inner JWS signedDate window — Apple inner JWS can be days old

**Walk through the brief's concern:**

The plan now routes ASC API responses through `verifyAndDecodeTransaction(..., { context: "asc-api" })` which enforces a **10-minute signedDate window** (plan line 1297). The brief asked: "Apple's ASC responses contain JWS payloads that may be SECONDS old (just-signed) but could also be the original purchase JWS from days ago. If we enforce 10min on the inner JWS, we'll reject legitimate sub-renewal status fetches."

Behavioral analysis based on Apple's documented contract:
- Apple's ASC API `getAllSubscriptionStatuses(originalTransactionId)` returns `lastTransactions[].signedTransactionInfo`. Apple's docs state this is **"a signed transaction information JWS"** — Apple signs it at response time, not at the original purchase time. The `signedDate` claim is the **Apple-side signature timestamp**, not the user's purchase time.
- The actual purchase timestamp is in `purchaseDate` (Apple-side timestamp) and `originalPurchaseDate` (Apple-side). These are DIFFERENT from `signedDate`.
- Apple's ASC API is designed to return freshly-signed JWS payloads (one of the reasons ASC exists is to give servers a re-attestation channel for old purchases).

**Verdict:** the 10-min window is correct for ASC responses; Apple re-signs at response time, so the JWS `signedDate` is always within seconds of the API call. Legitimate sub-renewal status fetches are NOT rejected. **No issue.**

However: if Apple's ASC API ever stops re-signing on response (unlikely but theoretically possible — e.g., a caching layer that returns the original purchase JWS verbatim), this contract breaks. Not a code-fix concern today; document as a known dependency on Apple's signing behavior.

**Severity: LOW** — actually a confirmation, not a finding. Recording for trace.

### N4.4 [LOW] `verifyAndDecodeRenewalInfo` does not re-run six checks 3-6

The brief asked: "Does the SDK verify the same six security checks for renewal-info payloads? Renewal info has different fields (no bundleId, no environment claim). If the SDK only validates the JWS chain + alg, then bundleId/environment defense doesn't apply to renewal."

Behavioral analysis:
- The SDK's `verifyAndDecodeRenewalInfo` verifies cert chain + alg (checks 1, 2).
- Renewal-info JWS payloads carry: `autoRenewProductId`, `originalTransactionId`, `productId`, `autoRenewStatus`, `offerType`, `signedDate`, `environment`, `priceIncreaseStatus`. There's no `bundleId` claim in renewal-info (Apple docs confirm).
- Renewal-info DOES carry `environment` — but our SDK call (plan line 1409-1415) doesn't re-validate it.

**Defense-in-depth analysis:**
- Renewal-info is only read inside `getSubscriptionStatus`, which is called only after a `verifiedTx` is already pinned to the user (line 1343). The parent transaction's `appAccountToken` check has already validated user identity.
- The cert chain (which renewal-info DOES re-verify) ensures the renewal-info is Apple-signed.
- Bundle/environment cross-check on renewal-info is defense-in-depth (catches a hypothetical SDK regression), but the actual attack surface is bounded: an attacker would need to inject a renewal-info payload signed by Apple but for a different bundle. ASC responses for `originalTransactionId` are tenant-scoped to our ASC API credentials (which include our bundleId).

**Verdict:** acceptable per defense-in-depth principle — bundleId is enforced on the outer transaction; renewal-info is co-signed by the same root and scoped to our tenant. No code change required.

**Severity: LOW** — confirmation, recorded for trace.

### N4.5 [NIT] Stale prose at plan line 1418

Already covered under N3.2 above. The line *"Also update `getSubscriptionStatus` to call the dedicated decoders…"* is a leftover instruction that no longer matches the code block (which already does the work). Delete the line.

### N4.6 [LOW] Webhook race with concurrent tombstone write (deletion flow flight)

The brief asked: "If the user has BOTH apple AND google tokens AND deletion happens during a webhook delivery, could a webhook resolve via User binding (step 4.2) while the deletion transaction is in-flight? Race condition with webhook reading from User table while tombstone batch is committing."

Walk through:
1. Webhook thread W: receives ASSN for `appAccountToken=AAT-1`. Reads User table by `iapAppleAccountToken = AAT-1` → HIT (deletion hasn't started yet) → `userId = u1`.
2. Deletion thread D: starts `prisma.$transaction([upsertApple, upsertGoogle])`. Tombstone INSERTs are in-flight.
3. Webhook W: proceeds to `syncSubscriptionFromIAP(...)` which upserts a Subscription row for `u1`. Subscription is keyed on `(source, sourceSubscriptionId)` — independent of the User row.
4. Deletion D: commits both tombstones. Then (in the future deletion flow) deletes/PII-nulls the User row.

**Failure modes:**
- W reads User BEFORE D commits tombstones → W gets `userId = u1`, syncs to Subscription, writes dedup row. Subscription row exists under `u1`. Then D commits → tombstones written + User deleted → orphaned Subscription. Future webhooks for the same `appAccountToken`: step 4.1 finds the Subscription (orphan), proceeds to sync — but Subscription has `userId = u1` which no longer exists → FK violation when `syncSubscriptionFromIAP` tries to update.

**Wait — does `tx.subscription.upsert` have an FK constraint?** Yes — `Subscription.userId` references `User.id`. If User is deleted (hard delete), the upsert would either cascade-delete the Subscription (depending on `onDelete`) or fail with FK violation.

Looking at the Prisma schema convention: User.id is the FK target. The deletion flow's runbook (plan line 4296) explicitly says "Hard-delete `Subscription` rows for IAP-source subs" is forbidden. So if the deletion flow follows the runbook, it tombstones the User but doesn't cascade-delete Subscriptions. Then a future webhook step 4.1 finds the Subscription (still pointing at a no-longer-existing User.id)... and the upsert UPDATEs the row (FK check passes only if the User still exists).

**This is a real but minor race.** It depends on:
1. The future deletion flow's actual behavior (hard-delete User vs tombstone with PII-null).
2. Whether the IAP Subscription's `userId` FK has `ON DELETE` set to anything.

**Severity: LOW** — depends on undecided future behavior. The Task 14 runbook should explicitly say: "Tombstone the User row (PII-null, keep User.id alive) — don't hard-delete, because IAP Subscription FKs depend on it." This is *implied* by spec §12.1's "PII-null + retain 6 years" but the runbook can make it explicit.

**Remediation:** in plan line 4285 ("null out PII fields per spec §12.1 retention guidance"), add a sentence: "**Do NOT hard-delete the User row** — IAP Subscription FKs depend on `User.id`. PII-null in place (email, name, etc.) but keep `id`."

### N4.7 [LOW] Apple webhook giveup row written inside concurrent retry — race recap

R3 already documented this under §4.4. P9-P11b didn't change the relevant code. The cap-trip race is acceptable per R3's analysis (one extra 500 logged before dedup stabilizes). No regression.

### N4.8 [NIT] P11 Gate 3 acknowledge verification

Plan lines 4110-4113 (after P11):

```
- [ ] Within 5 minutes: API calls `purchases.subscriptions.acknowledge(packageName, subscriptionId=productId, token)`
      for the new sub. Verify by directly re-fetching the purchase via `purchases.subscriptionsv2.get`
      (gcloud CLI or googleapis quickstart) and confirming `acknowledgementState === ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`.
      (No custom log line — the call lives inside `google-client.ts._acknowledge` and surfaces only errors.)
- [ ] DB: `Subscription.acknowledgementState` indirectly verified — re-fetch via `purchases.subscriptionsv2.get`
      and confirm `ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`.
```

The brief asked: "How does the smoke step actually verify acknowledgement without a custom log line? 'Re-fetch via subscriptionsv2.get and confirm ACKNOWLEDGED' — this is a manual gcloud/curl step. Is it actionable? Could the implementer skip it?"

The Gate 3 step IS actionable (gcloud CLI exists, `purchases.subscriptionsv2.get` is a standard call) but requires the operator to (a) have gcloud authenticated to the service account, (b) know the exact CLI invocation. A skipped/lazy operator would mark the box ✓ without verifying.

**Mitigation options:**
1. Add a brief gcloud command snippet to the smoke doc (low effort, high actionability):
   ```
   gcloud auth activate-service-account --key-file=<sa-key>
   curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/app.fina/purchases/subscriptionsv2/tokens/<token>"
   ```
2. Add an integration test (P10's `acknowledgeIfPending` unit test already exists — extend to a route-level integration test that asserts the mock's `_acknowledge` was called).

**Severity: NIT** — Gate 3 is operationally verifiable, just not turn-key. The smoke checklist genre tolerates this.

### N4.9 [LOW] `_acknowledge` and the v1 endpoint with `subscriptionId=productId` — confirm SDK quirk

The Gate 3 mention says `purchases.subscriptions.acknowledge(packageName, subscriptionId=productId, token)` (v1 endpoint with productId workaround). The code at plan line 1668-1679 does exactly this. The reason for v1 (not v2): `googleapis@^140` doesn't expose `purchases.subscriptionsv2.acknowledge`. So we use v1 with `subscriptionId === productId` as a quirk.

This is a documented Google API quirk — `subscriptionId` in v1 is the **product SKU** (not the unique sub instance). Both names refer to the same product, so passing `productId` satisfies the contract. Confirmed correct in P4 (R2 must-fix close).

**Severity: LOW** — confirmation, recorded for trace.

---

## 3. Internal consistency re-check

### 3.1 All round-1, round-2, round-3 must-fix items — cumulative verification

| ID | Sev | Round | Status @ R4 |
|---|---|---|---|
| CRITICAL 1.1 — Apple root SPKI hash | CRIT | R2 | **FIXED** (P3) |
| CRITICAL 2.3 — ASSN verifyAndDecodeNotification | CRIT | R2 | **FIXED** (P3) |
| HIGH 3.1 — acknowledgeIfPending no double-fetch | HIGH | R2 | **FIXED** (P4) |
| HIGH 3.2 — Google _acknowledge subscriptionId | HIGH | R2 | **FIXED** (P4) |
| HIGH 4.1 — Single migration in Task 2 | HIGH | R2 | **FIXED** (P2) |
| HIGH 4.3 — Dedup vs retry-counter separation | HIGH | R2 | **FIXED** (P5) |
| HIGH 10.1 — Mobile sha256 top-level | HIGH | R2 | **FIXED** (P7) |
| HIGH 11.1 — rn-iap pin + runtime check | HIGH | R2 | **PARTIAL/LOW** (pin landed; runtime check skipped — acceptable) |
| HIGH 12.1 — Account-deletion helper + runbook | HIGH | R2 | **FIXED** (P8) |
| HIGH 15.2 — E_USER_CANCELLED / E_ALREADY_OWNED UI | HIGH | R2 | **FIXED** (P7) |
| MED 1.3 — ASC inner JWS dedicated decoders | MED | R2 | **FIXED** (P10) |
| MED 4.1 — WebhookEvent.body in redact | MED | R2 | **FIXED** (P1) |
| MED 7.1 — buildMeBody caller enumeration | MED | R2 | **FIXED** (P6) |
| MED 7.2 — filterEnvironmentRows type narrowed | MED | R2 | **FIXED** (P6) |
| MED 8.1 — signedRenewalInfo/Payload/jwsRep redact | MED | R2 | **FIXED** (P1) |
| MED 10.2 — Cross-platform parity test | MED | R2 | **FIXED** (P7+P11) |
| MED 15.1 — ApiErrorCode→status mapping | MED | R2 | **FIXED** (P8) |
| MED 15.3 — Family Sharing → canceled | MED | R2 | **FIXED** (P5) |
| MED 1.2 — alg=ES256 explicit rejection test | MED | R2 | **DEFERRED (acceptable)** |
| MED 2.1 — OIDC issuer flexibility | MED | R2 | **DEFERRED (acceptable)** |
| MED 9.2 — Plugin parser collision | MED | R2 | **DEFERRED (acceptable)** |
| N3.5 HIGH — Tombstone transactionality | HIGH | R3 | **FIXED** (P10) |
| N3.2 MED — getSubscriptionStatus code block | MED | R3 | **FIXED** (P10) |
| N3.3 MED — Redact list divergence | MED | R3 | **FIXED** (P11) |
| N3.4 LOW — Mobile parity placeholders | LOW | R3 | **FIXED** (P11) |
| N3.1 LOW — validateAppleRoots fail-loud | LOW | R3 | acceptable (no regression) |
| N3.6 (info) — IapRetryCounter atomicity | — | R3 | confirmed atomic |
| N3.7 NIT — Family Sharing 1h window | NIT | R3 | acceptable |
| 7.1 NIT — Self-review placeholder ref | NIT | R3 | **PARTIAL** (self-review updated in P11b but still references the placeholder gap; acceptable) |
| 7.2 NIT — Gate 3 iap_acknowledge_ok log | NIT | R3 | **FIXED** (P11 — dropped the fake log line, replaced with re-fetch via subscriptionsv2.get) |

**No regressions** introduced by P9-P11b on any prior must-fix.

### 3.2 Spec §5.2 check #5 — signedDate window

ASC-API 10min vs ASSN 1h is encoded correctly at `apple-client.ts` plan line 1297:

```ts
const maxAgeMs = opts.context === "assn" ? 60 * 60 * 1000 : 10 * 60 * 1000;
```

Call sites:
- `getSubscriptionStatus` (line 1343): `{ context: "asc-api" }` → 10min ✓
- Webhook handler (line 3295): `{ context: "assn" }` → 1h ✓
- `syncApple` (line 2341): `args.context === "assn" ? "assn" : "asc-api"` → 1h for ASSN webhooks, 10min for /checkout/restore ✓

**Verdict:** correctly encoded across all paths.

### 3.3 Spec §12.1 GDPR — 6-year retention

The runbook (plan lines 4283-4288) documents:
```
// ... cancel any Stripe subs, null out PII fields per spec §12.1
//     retention guidance (6-year tax-retention exemption), etc.
```

The brief asked: "Task 14 runbook documents but no code enforces (deferred to future deletion flow). Acceptable? Or should the helper itself null PII fields on the User row?"

R3 answered this and the verdict still stands: the helper is correctly scoped to IAP-tombstone-write-only. The deletion flow's PII-null is a separate (future) concern that touches multiple subsystems (Plaid, Chat, etc.). Putting User-row PII-null inside the IAP helper would couple it to non-IAP concerns.

One refinement from this round: the runbook should *also* explicitly warn against hard-deleting the User row (see **N4.6 LOW** above) since IAP Subscription FKs depend on `User.id`.

**Verdict:** runbook surface is correct; needs one-line addition about not hard-deleting User.

### 3.4 Pino redact paths — final coverage

Task 0.4 (plan lines 161-176) — the canonical list:

```
env.APPLE_ASC_PRIVATE_KEY
env.GOOGLE_SERVICE_ACCOUNT_JSON
*.APPLE_ASC_PRIVATE_KEY
*.GOOGLE_SERVICE_ACCOUNT_JSON
*.private_key
*.purchaseToken
*.signedTransactionInfo
*.signedRenewalInfo
*.signedPayload
*.appAccountToken
*.receipt
*.jwsRepresentation
*.body.appAccountToken
*.body.obf
```

Cross-referenced against fields that DO appear in webhook bodies, error payloads, and log statements throughout the plan:

- `signedPayload` (Apple ASSN inbound) — covered ✓
- `signedTransactionInfo` (ASSN inner + ASC API response) — covered ✓
- `signedRenewalInfo` (ASSN + ASC API) — covered ✓
- `appAccountToken` (inside ASSN payload + log statements) — covered ✓
- `purchaseToken` (Google body) — covered ✓
- `private_key` (service account JSON) — covered ✓
- `receipt` (mobile checkout body) — covered ✓
- `jwsRepresentation` (StoreKit 2 outbound) — covered ✓
- `body.obf` (forensic event payload) — covered ✓

**Fields NOT in redact:**
- `obfuscatedExternalAccountId` (Google's binding token, plaintext in v2 response) — **not in redact**. This is a SHA-256 hex over the userId, so it's a hash-of-PII rather than raw PII. Logging it doesn't disclose userId directly, but it's a unique fingerprint per user. R2 didn't ask for this; the spec's redact list (§5.1) didn't require it. Acceptable to leave as-is for v1.
- `linkedPurchaseToken` (Google v2 response) — **not in redact**. This is an opaque Play token, equivalent to `purchaseToken`. The `*.purchaseToken` redact path catches the outer `purchaseToken`, but `linkedPurchaseToken` (different key) is not redacted. Pino's `paths` is exact-match by default (not prefix). Minor leak risk in log statements that include the full v2 response object.

**Severity: LOW** — `linkedPurchaseToken` should arguably be redacted. Add `"*.linkedPurchaseToken"` to Task 0.4.

### 3.5 mobile parity test cryptographic encoding

The mobile-side test at plan lines 3612-3621 computes EXPECTED values inline using:
- `uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE)` — same `uuid` package on both sides ✓
- `createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex")` — `node:crypto` ✓

The mobile's `deriveGoogleToken` at plan line 3539 uses `js-sha256.sha256(input)`. js-sha256 defaults to UTF-8 encoding for string inputs, which matches `node:crypto` default. Good.

**One subtle point:** if `FIXTURE_USER_ID` ever contains characters whose UTF-8 byte-encoding differs from what `js-sha256` assumes (e.g., emoji, surrogate-pair handling), divergence could surface. `"fixture-user-id"` is ASCII-safe so no issue today. Worth a note for the future v1.5 if the fixture changes.

---

## 4. End-to-end security flow walkthrough — Apple webhook for a deleted user

Following the brief's prompt. The path: Apple sends ASSN for `originalTransactionId=OT-1`, `appAccountToken=AAT-1`, where the underlying user was deleted (deletion flow ran first).

**Step 1: Apple POSTs to `/webhooks/iap/apple` with `{ signedPayload }`.**

Code: plan line 3258 (route handler) reads `req.body as { signedPayload?: string }`. Guard at line 3263 returns 400 if missing.

**Step 2: Verify the envelope.**

Code: plan line 3265 calls `verifyApplePayload(body.signedPayload, cfg.apple, { appleClient })`. This delegates to `appleClient.verifyAndDecodeNotification(signedPayload)` (the SDK's dedicated notification verifier, NOT the transaction verifier — verified by R3 CRITICAL 2.3 fix).

Returns: `notificationUUID`, `notificationType`, `subtype?`, `signedTransactionJws`, `raw`.

**Step 3: Dedup check.**

Code: plan lines 3275-3277:
```ts
const eventId = `apple:${notification.notificationUUID}`;
const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
if (existing) return { ok: true };
```

Assumes first delivery — no prior `WebhookEvent` row. Continue.

**Step 4: Family Sharing branch — NOT applicable (this is a renewal/cancellation, not `DID_CHANGE_RENEWAL_STATUS + PRODUCT_NOT_FOR_SALE`).** Skip lines 3282-3293.

**Step 5: Verify inner transaction.**

Code: plan line 3295:
```ts
const verifiedTx = await appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" });
```

`verifyAndDecodeTransaction` runs 6 checks (plan lines 1280-1305):
1. SDK alg + cert chain (delegated to `_decodeAndVerifyJws`).
2. `bundleId === cfg.bundleId`.
3. `environment === expectedEnv` (Sandbox/Production matches runtime).
4. `signedDate` within `60 * 60 * 1000` (1h ASSN window).
5. `appAccountToken` is non-empty string.
6. Returns `VerifiedAppleTransaction` with `appAccountToken=AAT-1`, `originalTransactionId=OT-1`.

All six checks pass.

**Step 6: Compute binding hash.**

Code: plan line 3296:
```ts
const bindingHash = hashBindingToken(verifiedTx.appAccountToken);
// = createHash("sha256").update(AAT-1, "utf8").digest("hex")
```

**Step 7: Try Subscription lookup.**

Code: plan lines 3301-3304:
```ts
const sub = await prisma.subscription.findFirst({
  where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
  select: { userId: true },
});
```

User was deleted; if deletion ran `prisma.subscription.deleteMany`, no row. Or if PII-null kept the row but the user is gone — row would still exist with the original `userId`. **Depends on the future deletion flow's behavior.**

Scenario A (runbook-compliant): deletion PII-nulls User but does NOT delete IAP Subscription rows. Step 7 HITS, returns the original `userId`. Webhook proceeds to `syncSubscriptionFromIAP(..., { userId: deletedUserId })`. Subscription upsert succeeds (the User row still exists with PII nulled). Dedup row written. Return 200.

Scenario B (hard-delete deletion): runbook violated; deletion hard-deletes the User AND the IAP Subscriptions cascade-delete (via FK `onDelete: CASCADE`) or are orphaned. Step 7 misses, fall to step 8.

**Step 8: User lookup by binding.**

Code: plan lines 3307-3310:
```ts
const user = await prisma.user.findUnique({ where: { iapAppleAccountToken: verifiedTx.appAccountToken } });
if (user) userId = user.id;
```

In scenario B (hard-delete): User is gone; no hit.

**Step 9: Tombstone lookup.**

Code: plan lines 3312-3322:
```ts
const tombstone = await prisma.iapDeletedBinding.findUnique({
  where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
});
if (tombstone) {
  await prisma.webhookEvent.create({
    data: { id: eventId, source: "iap_apple", type: "unattributable_after_delete", body: { tokenHash: bindingHash } as any },
  });
  return reply.code(200).send({ ok: true });
}
```

`writeAccountDeletionTombstones(userId)` was run by the deletion flow. It looks up the User's `iapAppleAccountToken`, hashes it, writes to `IapDeletedBinding`. Verification of hash chain:

- account-deletion: `t.tokenHash = hashBindingToken(user.iapAppleAccountToken)` = `sha256(uuidv5(userId, IAP_NAMESPACE), "utf8").hex`.
- webhook: `bindingHash = hashBindingToken(verifiedTx.appAccountToken)` where `verifiedTx.appAccountToken` is the JWS claim set by the mobile app to `deriveAppleToken(args.userId) = uuidv5(args.userId, IAP_NAMESPACE)`.

If `args.userId === userId` (deleted user's id), both hashes match → tombstone HIT. ✓

**Step 10: Write forensic WebhookEvent + return 200.**

Code: plan lines 3317-3321. `WebhookEvent.body` is set to `{ tokenHash: bindingHash }`. The `WebhookEvent.body` Json column is added by Task 2 (plan lines 549-557). Pino redact for `*.body.obf` and `*.body.appAccountToken` doesn't catch `body.tokenHash` — but `tokenHash` is already a SHA-256 hash, so it's not raw PII. Acceptable.

**Step 11: Apple sees 200 → stops retrying.** ✓

---

**Subtle gap check:**
1. **Hash collision** — if two different userIds produced the same `bindingHash`, tombstone would incorrectly match. SHA-256 collision resistance: 2^128, infeasible.
2. **Token reuse** — if the deleted user's `iapAppleAccountToken` somehow got reassigned to a NEW user before the tombstone was written, the new user's webhook would see `unattributable_after_delete`. The User schema has `iapAppleAccountToken @unique`, so token reuse on a new User row would fail with unique-constraint violation (the deletion flow MUST run `writeAccountDeletionTombstones` BEFORE nulling the User's token field). Order of operations in the runbook example (line 4282-4287): `writeAccountDeletionTombstones(userId)` FIRST, then PII-null. Correct.
3. **Race: webhook arrives WHILE deletion is mid-flight** — covered by N4.6 LOW.

**Verdict:** the round-trip is correct. The hash chain validates end-to-end. The future deletion flow's compliance with the runbook (don't hard-delete; tombstone-then-PII-null in correct order) is the load-bearing assumption. N4.6 LOW captures the only remaining ambiguity.

---

## 5. Summary of findings

### Round-3 must-fix verification

| ID | Sev | Status |
|---|---|---|
| N3.5 — `writeAccountDeletionTombstones` in transaction | HIGH | **FIXED** |
| N3.2 — `getSubscriptionStatus` dedicated decoders | MED | **FIXED** (stale prose remains as N4.5 NIT) |
| N3.3 — Redact list divergence | MED | **FIXED** |
| N3.4 — Mobile parity placeholders | LOW | **FIXED** |
| R2 HIGH 11.1 — Runtime appAccountToken check | LOW (post-pin) | **DEFERRED (acceptable)** |

### New findings from P9-P11b

| ID | Sev | Issue |
|---|---|---|
| N4.1 | MED | `validateAppleRoots()` `<<<`/`>>>` placeholder regex is dead — placeholder uses `<<`/`>>` only. X509 parse failure catches it via fallback, but the explicit placeholder error never fires |
| N4.2 | MED | `apps/mobile` has no vitest config — Step 11.5 / 11.5b commands won't actually run on a fresh checkout |
| N4.3 | LOW | ASC-API 10min signedDate window — confirmed correct (Apple re-signs on response). Recorded for trace |
| N4.4 | LOW | `verifyAndDecodeRenewalInfo` doesn't re-validate bundleId/environment — acceptable defense-in-depth |
| N4.5 | NIT | Stale prose at plan line 1418 — code block already does the work |
| N4.6 | LOW | Future deletion-flow runbook should explicitly warn "don't hard-delete User row" (FK dependency from IAP Subscription) |
| N4.7 | LOW | Cap-trip race recap — no regression from R3 |
| N4.8 | NIT | Gate 3 acknowledgement verification requires manual gcloud step — add CLI snippet for actionability |
| N4.9 | LOW | `_acknowledge` v1 endpoint with `subscriptionId=productId` — confirmed correct |
| (extra) | LOW | `*.linkedPurchaseToken` not in Pino redact paths — add for completeness |

---

## 6. Required before implementation (action list)

**SHOULD fix (MEDIUM):**

1. **N4.1** — Either change the placeholder PEM at plan line 1442 to use `<<<INSTALLER...>>>` (three angles), OR change the regex at plan line 1206 (and the test at line 1477) to `<<` / `>>`. Smallest change: edit line 1442 only.
2. **N4.2** — Add `apps/mobile/vitest.config.ts` with `environment: "node"` + `@fina/shared` alias. Add `vitest` to `apps/mobile/devDependencies` (or verify hoisted resolution works). Verify Step 11.5 / 11.5b commands actually run on a fresh checkout.

**MAY fix (LOW/NIT):**

3. **N4.5** — Delete the stale prose at plan line 1418.
4. **N4.6** — Add to runbook line 4285: "Do NOT hard-delete the User row — IAP Subscription FKs depend on `User.id`."
5. **N4.8** — Add a gcloud CLI snippet to Gate 3 verification (plan lines 4111-4112) for actionability.
6. **Extra** — Add `"*.linkedPurchaseToken"` to Task 0.4 redact paths (plan line 175-ish).

The N4.1 and N4.2 fixes are blockers for implementation (otherwise the install gate fails with a worse-than-intended error message, and the mobile parity test doesn't run at all). The others are polish.

---

## Verdict

**APPROVE WITH CHANGES.**

All four round-3 must-fix items are properly closed with code-level patches. The plan is now substantively complete and correct. The remaining concerns are:
- **N4.1** (placeholder regex dead-code) — security is intact via the X509 parse fallback, but the documented explicit-detection path is silently broken. Trivial text edit.
- **N4.2** (mobile vitest missing) — blocking for implementation, not for security. Trivial setup.

Both are text-level fixes. Once applied, this plan is implementation-ready.

**The author has demonstrated sustained, high-quality engagement across four rounds of security review.** Three rounds closed every CRITICAL/HIGH; this round closes the remaining MEDIUMs introduced by the prior round's patches. The pattern of "address every finding with a code patch rather than a prose note" is what made this convergent.

No new CRITICAL or HIGH findings. The end-to-end deleted-user webhook walkthrough is correctly encoded in code.
