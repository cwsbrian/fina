# Mobile IAP Billing — Plan Security Review

**Plan reviewed:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md`
**Spec:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
**Round-2 security review:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design-review-security-r2.md`
**Reviewer role:** Security + correctness — verifying the plan's *code blocks* encode the spec's guarantees.
**Date:** 2026-05-26

---

## Executive summary

The plan is broadly faithful to the spec and the round-2 fixes are reflected, but there are **two CRITICAL implementation gaps that will silently weaken security if the plan is executed as written**, plus several HIGH/MEDIUM issues where guarantees the spec phrases as code-level invariants survive only in prose.

| Sev | Count |
|---|---|
| CRITICAL | 2 |
| HIGH | 4 |
| MEDIUM | 5 |
| LOW | 3 |
| NIT | 2 |

The two CRITICALs are:
1. Apple JWS check #1 (`alg === ES256`) and check #2 (SPKI-pinned root) are **both delegated to the Apple SDK** with no explicit code; the pinned root is a literal `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>` placeholder that Step 4.6's tests pass without (the test mocks `_decodeAndVerifyJws` and never exercises the cert constant). Implementer can ship a placeholder root and tests still go green.
2. The Apple ASSN payload decode in `webhook-verify.ts verifyApplePayload` calls `appleClient.verifyAndDecodeTransaction` on the **notification envelope** JWS, not on a transaction. Apple's SDK has a separate `verifyAndDecodeNotification` API; the plan conflates the two and the resulting code path will fail signature verification or — worse — pass the wrong payload shape downstream.

Walking through guarantee-by-guarantee below.

---

## 1. Apple JWS six-check enforcement (spec §5.2)

**Plan step:** Task 4 Step 4.6 `apple-client.ts verifyAndDecodeTransaction`.

| Check | Encoding | Verdict |
|---|---|---|
| (1) `alg === ES256` | Implicit via SDK | **PARTIAL** |
| (2) Root pinned by SPKI hash | Implicit via SDK + placeholder PEM | **MISSING / CRITICAL** |
| (3) `bundleId === env.APPLE_BUNDLE_ID` | Explicit (line 1088–1090) | **ENCODED** |
| (4) `environment === env.APPLE_ENV` | Explicit (line 1092–1096) | **ENCODED** |
| (5) `signedDate` window (10min ASC / 1h ASSN) | Explicit (line 1098–1103) | **ENCODED** |
| (6) `appAccountToken` presence | Explicit (line 1105–1108) | **ENCODED** |

### 1.1 [CRITICAL] Root cert pinning is a placeholder, tests pass anyway

**Where:** Task 4 Step 4.6, lines 1020–1031.

```ts
const APPLE_ROOT_CERTS: Buffer[] = [
  Buffer.from(
    "-----BEGIN CERTIFICATE-----\n" +
    "<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>\n" +
    "-----END CERTIFICATE-----\n",
    "utf8",
  ),
];
```

The plan's own self-review §"Placeholder scan" acknowledges this as a known placeholder:
> *"the Apple G3 root cert PEM is a placeholder `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>` in Task 4 Step 4.6 — implementer drops in the real PEM at install time"*

Problems with this approach:

1. **The pinned cert is the entire `(2)` guarantee.** Spec §5.2 check 2: *"The X5C cert chain terminates at Apple's WWDR root, pinned by SPKI SHA-256 hash in code (no runtime fetch)."* The spec specifies **SPKI hash**, not the full PEM. The plan supplies a PEM buffer. These are not the same defense — a PEM-bytes comparison is brittle against re-encoded re-signed certs; an SPKI-hash comparison survives re-encoding. The plan downgrades the defense without flagging it.
2. **The unit tests in Step 4.5 mock `_decodeAndVerifyJws` entirely**, so the cert constant is never exercised. An implementer can ship the literal string `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>` and all 6 apple-client tests pass green. There's no test that asserts the constant is a valid X.509 PEM, no test that asserts the SPKI hash matches a known Apple root, and no boot-time validation in `env-guard.ts` for it.
3. **The cert wasn't a comment on which Apple root.** The comment claims "WWDR-G6" and "AppleRootCA-G3 (RSA) — used for ASSN V2 signing" — those are different certs. ASSN V2 is signed by AppleRootCA-G3 (the App Store) routed through Apple Worldwide Developer Relations. The plan needs to specify exactly which root to pin and verify both Apple's ASC API responses and ASSN V2 notifications chain to it.

**Remediation (required before implementation):**
- Replace placeholder with the actual Apple Inc. Root CA G3 PEM (or G6 if migration has happened), AND add an `env-guard.ts` boot check: parse the PEM, compute its SPKI SHA-256, compare against a hardcoded expected hash. Fail loud if it doesn't match.
- Add a unit test in `apple-client.test.ts`: `it("APPLE_ROOT_CERTS contains a parseable X.509 cert and its SPKI hash matches expected").`
- Document in the plan that the SPKI hash itself (not the PEM bytes) is what's load-bearing.

### 1.2 [MEDIUM] Check (1) `alg === ES256` is implicit-via-SDK with no test asserting it

The plan delegates ES256 enforcement entirely to `@apple/app-store-server-library`'s `SignedDataVerifier`. That's defensible — the SDK is Apple's own — but:

- No unit test asserts a JWS with `alg=none` or `alg=HS256` is rejected. The mocked `_decodeAndVerifyJws` in Step 4.5 returns success for any input; the alg check never runs in tests.
- If a future SDK upgrade silently changes behavior, we have no canary.

**Remediation:** Add a test that constructs a raw JWS with `alg=none` header and confirms `verifyAndDecodeTransaction` rejects it (the SDK should refuse to decode, surfacing a thrown error → `invalid_receipt`). Not a placeholder PEM — use the SDK's actual verifier on a hand-crafted JWS.

### 1.3 [LOW] `getSubscriptionStatus` re-decodes `signedTransactionInfo` and `signedRenewalInfo` with `_decodeAndVerifyJws` but skips check (3)/(4)/(6)

**Where:** Task 4 Step 4.6, lines 1139–1140.

```ts
const tx = await this._decodeAndVerifyJws(item.signedTransactionInfo);
const renewal = await this._decodeAndVerifyJws(item.signedRenewalInfo);
```

These two calls bypass `verifyAndDecodeTransaction` (which enforces checks 3–6) and go straight to the lower-level `_decodeAndVerifyJws`. The renewal JWS is then trusted for `offerType` / `autoRenewStatus` without re-checking that the bundleId / environment / appAccountToken still match.

In practice the ASC API only returns transactions for our bundle, so it's defense-in-depth — but the spec says "all six checks apply" on every JWS. Either:

- Route both decodes through `verifyAndDecodeTransaction` with the appropriate context, OR
- Document explicitly that ASC-API-returned inner JWS are trusted transitively from the outer ASC response.

**Remediation:** Add a `verifyInnerJws(jws, opts)` private method that runs checks 3–6 on `signedTransactionInfo` / `signedRenewalInfo` returns. Call it instead of the bare `_decodeAndVerifyJws`.

---

## 2. Google OIDC verification (spec §5.3 step 1)

**Plan step:** Task 6 Step 6.2 `verifyGoogleEnvelope`.

| Check | Encoding | Verdict |
|---|---|---|
| audience == `env.GOOGLE_PUBSUB_VERIFY_AUDIENCE` | Explicit (line 1617–1619), also passed to `verifyIdToken` | **ENCODED** |
| issuer == `https://accounts.google.com` | Explicit (line 1614–1616) | **ENCODED** |
| `email` AND `azp` == `env.GOOGLE_PUBSUB_VERIFY_EMAIL` | Explicit (line 1620–1622) | **ENCODED** |
| `exp` enforced, 0 skew | Explicit (line 1623–1626) | **ENCODED** |
| `subscription` == `env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME` | Explicit (line 1628–1631) | **ENCODED** |

### 2.1 [MEDIUM] `iss === "https://accounts.google.com"` may be too strict

Google also issues OIDC tokens with `iss === "accounts.google.com"` (no scheme). The plan rejects that variant. In practice the Pub/Sub push subscription consistently uses the scheme'd form, but Google's published guidance on validating push-sub tokens accepts either. If they ever flip, our webhook breaks silently.

**Remediation (LOW priority but worth a note):** Accept `iss in {"https://accounts.google.com", "accounts.google.com"}`. The spec doesn't require this and the round-2 review didn't flag it, but it's a known compatibility footgun.

### 2.2 [LOW] `OAuth2Client.verifyIdToken` clock-skew default behavior is undocumented in the plan

Spec §5.3 step 1 requires **"`exp` enforced with 0s clock skew tolerance — leaked-after-`exp` tokens must fail."**

The plan calls `oidcClient.verifyIdToken({ idToken, audience })` and then **also** manually checks `payload.exp < nowSec` (line 1623–1626). The manual check is the load-bearing one. Good.

**But:** `google-auth-library`'s `OAuth2Client.verifyIdToken` internally has its own `exp` check with a default tolerance of ~300 seconds. The plan never disables it. Result: a token expired ≤5 min ago passes `verifyIdToken` (returns a ticket), then the manual `payload.exp < nowSec` check catches it. So the end result is correct — but **only because the manual check is there**. Remove the manual check (a future refactor), and the SDK's 5-min skew silently re-introduces the leak window.

**Remediation:** Either (a) pass `maxExpiry` / explicit `exp` clamp to `verifyIdToken` if the SDK supports it, OR (b) add a comment to the manual check stating "this duplicates `verifyIdToken`'s internal check intentionally — Google SDK default tolerates 5min skew, spec requires 0."

### 2.3 [HIGH] Apple ASSN payload decode uses the wrong SDK API

**Where:** Task 6 Step 6.2 `verifyApplePayload`, lines 1560–1584.

```ts
const decode = deps.appleClient._decodeAndVerifyJws
  ?? ((s: string) => deps.appleClient.verifyAndDecodeTransaction(s, { context: "assn" }).then((r) => (r as any).raw));
const decoded = await decode(signedPayload).catch(() => {
  throw new HttpError(400, "invalid_receipt", "apple notification signature failed");
});
```

The plan calls `_decodeAndVerifyJws` (or falls back to `verifyAndDecodeTransaction`) on the **ASSN V2 `signedPayload`**. But ASSN V2 `signedPayload` is **not** a `SignedTransaction` — it's a `responseBodyV2DecodedPayload` which carries `notificationUUID`, `notificationType`, `subtype`, and a nested `data` with `signedTransactionInfo` / `signedRenewalInfo`.

`@apple/app-store-server-library` exposes **`verifyAndDecodeNotification(signedPayload)`** for this purpose. It's a distinct method from `verifyAndDecodeTransaction`. Calling the transaction decoder on a notification payload:

- If the SDK strict-validates, will throw "not a transaction" → every webhook returns 400 → **prod is broken**.
- If the SDK is permissive, will return a partial decode where the fallback `verifyAndDecodeTransaction` then enforces `bundleId`/`environment`/`appAccountToken` on a *notification* shape that has none of those fields → reject everything as `invalid_receipt`.

Worse, the fallback path calls `verifyAndDecodeTransaction` which expects an `appAccountToken` and will throw `user_mismatch` because the notification envelope doesn't carry one (it's nested in `data.signedTransactionInfo`). The test in Step 6.1 mocks the seam, so this is never exercised in CI.

**Then** in Task 10 Step 10.2, `billingIapWebhookRoutes` *additionally* calls `appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" })` to actually validate the inner transaction. So the notification-decode path is supposed to just extract the inner JWS string — but the code as written runs the full six-check transaction validator on the **outer notification**, which has no `bundleId`, `environment`, or `appAccountToken` field.

**Remediation (required):**
- Add a separate method to `AppleClient`: `verifyAndDecodeNotification(signedPayload): { notificationUUID, notificationType, subtype, signedTransactionJws }` that uses the SDK's notification verifier.
- Have `verifyApplePayload` call **that** method, not the transaction verifier.
- Inner `signedTransactionInfo` then goes through `verifyAndDecodeTransaction` separately as already done in `billing-iap-webhook.ts:2885`.

This is a **HIGH** — it's a correctness bug that would surface on the first real ASSN delivery.

---

## 3. Google `acknowledge` mandatory (spec §1.2 CRITICAL)

**Plan step:** Task 5 Step 5.3 `acknowledgeIfPending`, Task 7 Step 7.6 `syncGoogle`.

| Behavior | Encoding | Verdict |
|---|---|---|
| `acknowledgeIfPending` checks state first, only calls API when PENDING | Explicit (Task 5 Step 5.3, line 1378–1385) | **ENCODED** |
| Acknowledge runs AFTER upsert succeeds | Explicit (Task 7 Step 7.6, line 2118–2120) | **ENCODED** |
| Test asserts ordering | Explicit (Task 7 Step 7.5, line 1887–1911) | **ENCODED** |

### 3.1 [HIGH] `acknowledgeIfPending` double-fetches the v2 payload — race window for status to flip

**Where:** Task 5 Step 5.3, lines 1378–1385.

```ts
async acknowledgeIfPending(purchaseToken: string): Promise<boolean> {
  const v2 = await this.fetchAndNormalize(purchaseToken);   // ← second fetch
  if (v2.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING") {
    await this._acknowledge(purchaseToken);
    return true;
  }
  return false;
}
```

`syncGoogle` in Task 7 already calls `fetchAndNormalize` once (line 2055), then calls `acknowledgeIfPending` which fetches again. Two issues:

1. **Wasted API call** (~150ms latency added to every successful sync).
2. **TOCTOU window:** if another concurrent webhook acknowledges between the two fetches, we now think we don't need to ack, and a different code path that depends on `acknowledgeIfPending`'s return value (none currently, but the API surface invites it) would draw the wrong conclusion.

`syncGoogle` already has the `acknowledgementState` value from the first fetch (line 2118). It should call `_acknowledge` directly when needed, OR `acknowledgeIfPending` should accept the already-fetched state.

**Remediation:** Refactor `acknowledgeIfPending(purchaseToken)` to `acknowledgeIfPending(purchaseToken, knownState?)`. When `knownState === PENDING`, skip the re-fetch and call `_acknowledge` directly. Update `syncGoogle` to pass the known state.

### 3.2 [LOW] `_acknowledge` passes `subscriptionId: ""` to Play Developer API

**Where:** Task 5 Step 5.3, lines 1334–1340.

```ts
await this.androidPublisher.purchases.subscriptions
  .acknowledge({
    packageName: this.cfg.packageName,
    subscriptionId: "",  // ← empty string
    token: purchaseToken,
    requestBody: {},
  })
```

The comment says: *"v1 endpoint requires subId; v2 doesn't surface it cleanly — pass empty"*.

This is wrong. Google's v1 `purchases.subscriptions.acknowledge` requires `subscriptionId` to be the productId (e.g. `lite_monthly` or `pro_monthly`). Passing empty string returns 400 from the Play Developer API.

The `googleapis` v3 client does expose `purchases.subscriptionsv2.acknowledge` (subscriptionsv2, not subscriptions) — and that method does NOT need `subscriptionId`. The plan picked the wrong method.

**Remediation:** Use `androidPublisher.purchases.subscriptionsv2.acknowledge({ packageName, token })` (no subscriptionId). Verify the method name in the installed version of `googleapis`. If the v3 client doesn't surface a subscriptionsv2 acknowledge yet, populate `subscriptionId` with the productId from the prior `fetchAndNormalize` call.

This will fail on the first real Android purchase and the webhook will keep returning PENDING → Google auto-refunds at the 3-day window.

---

## 4. First-purchase race resolution (spec §5.3 step 4)

**Plan step:** Task 10 Step 10.2 webhook handler.

| Step | Apple encoding | Google encoding | Verdict |
|---|---|---|---|
| 1: Subscription lookup by sourceSubscriptionId | Explicit (line 2890–2894) | Explicit (line 2965–2972) | **ENCODED** |
| 2: User binding lookup | Explicit (line 2896–2899) | Explicit (line 2974–2978) | **ENCODED** |
| 3: Tombstone check → 200 | Explicit (line 2900–2909) | Explicit (line 2979–2987) | **ENCODED** |
| 4: 500 with retry-cap, then forensic 200 | Explicit (line 2911–2921) | Explicit (line 2988–2998) | **ENCODED** |

### 4.1 [HIGH] Per-token retry counter uses `WebhookEvent.body` JSON-path query — the `body` column doesn't exist yet at this task

**Where:** Task 10 Step 10.2, lines 2912–2915, also 2989–2991.

```ts
const priorCount = await prisma.webhookEvent.count({
  where: { source: "iap_apple", type: "unattributable_retry",
           body: { path: ["appAccountToken"], equals: verifiedTx.appAccountToken } as any },
});
```

The existing `WebhookEvent` model (`schema.prisma:711-720`) does **not** have a `body` column. The plan acknowledges this inline ("if needed, extend") in Step 10.3, but the schema change lives **after** Step 10.2's tests in the task order:

1. Step 10.1: Write tests (they'll fail because of missing `body` column)
2. Step 10.2: Implement code that queries `body: { path: [...], equals: ... }`
3. Step 10.3: Add `body Json?` to schema

Step 10.5 then says "Run integration test, confirm PASS 8/8". But the test in Step 10.1 calls `prisma.iapDeletedBinding.create` AND uses `webhookEvent` queries with `body` — both depend on the migration. If the migration hasn't been generated by the time tests run, the tests fail.

Worse: the **`IapDeletedBinding` model is created in Task 2** and the **`body` column on `WebhookEvent` is created in Task 10**, but the test in Step 10.1 (lines 2698–2701, 2912–2915) uses both. So the task order is internally inconsistent.

**Remediation:**
- Move the `body Json?` schema change to Task 2 alongside the `IapDeletedBinding` model. Single migration covering all IAP-related schema changes.
- Update Task 10's commit message and file list to drop the prisma changes.
- The `WebhookEvent` design note at line 710 (`// no body retained (PII + volume)`) **must** be updated when the column is added — and the new field MUST be on the redact list (Task 3 already covers this via `*.body` if we add it, but the plan doesn't explicitly list `WebhookEvent.body` in the redact paths).

### 4.2 [MEDIUM] Tombstone hash is over the binding token only — Google path may collide

**Where:** Task 10 Step 10.2 lines 2902–2904 (Apple), 2980–2982 (Google).

For Apple: `hashBindingToken(verifiedTx.appAccountToken)` — sha256 of a uuidv5. Inputs are 36-char strings, sha256 has 256-bit output, no collision concern.

For Google: `hashBindingToken(v2.obfuscatedExternalAccountId)` — sha256 of sha256(userId). Net result: double-sha256(userId). Still no collision concern, but the schema field is also `tokenHash`, ambiguous. A future migration adding userIdHash for support replay would now confuse two different hashing depths.

**Remediation (LOW):** Document this clearly in the comment on `hashBindingToken` or the `IapDeletedBinding.tokenHash` field — for Google it's hash-of-hash, for Apple it's hash-of-uuidv5.

### 4.3 [MEDIUM] Apple webhook step 4 retry-cap uses `notificationUUID` as `eventId` — second 500 attempt within 3 days has a different UUID

**Where:** Task 10 Step 10.2, lines 2916–2920.

The plan writes a `WebhookEvent` with `id = "apple:" + notificationUUID` on every unattributable retry. Apple's retry policy delivers the SAME `notificationUUID` per retry attempt (idempotency expectation). So the `findUnique(eventId)` dedup at the top of the handler short-circuits on retry 2+ — meaning the retry counter would only ever hit count=1 because the second retry of the same UUID short-circuits to `{ok: true}` (line 2873–2874) before reaching the counter logic.

The test in Step 10.1 (lines 2705–2724) acknowledges this implicitly by passing `notificationUUID: \`uuid-4-${i}\`` (a different UUID per iteration) — but real Apple ASSN retries send the *same* UUID. The test is wrong, and the production behavior is broken: retries 2-5 short-circuit on dedup, the counter sits at 1 forever, the 500 stream never trips the cap, and the 5-day Apple retry window completes returning the same 500 on the same notificationUUID.

Two issues conflated here:
- **Dedup vs retry-cap** — dedup says "this UUID was processed, skip". Retry-cap says "this token caused N retries". They're orthogonal but the plan glues them together via the same WebhookEvent row.
- **The dedup should only fire AFTER the handler succeeded** — current Stripe pattern (line 51–53 of `billing-webhook.ts`) records the dedup row AFTER `handleEvent`. The IAP plan records it inside the 500 path too (line 2919), which causes the issue above.

**Remediation:**
- Use a **separate counter table** (or distinct WebhookEvent.type prefix) for retry-cap that is keyed on the binding token, not the notificationUUID.
- Move the dedup `WebhookEvent.create` AFTER successful sync (matching Stripe pattern). On 500 paths, do NOT create the dedup row — let Apple retry the same UUID.
- Update the test in Step 10.1 lines 2705–2724 to use the *same* notificationUUID across retries (real Apple behavior).

### 4.4 [LOW] Google retry counter uses sha256(obf) ≠ sha256(token)

Same structural issue as 4.3. Google RTDN retries deliver the *same messageId* per retry. Dedup on messageId + retry-counter on a different key means the dedup short-circuits before the counter ever increments.

**Remediation:** Same as 4.3.

---

## 5. Token-match guarantee on checkout/restore (spec §4.2 HIGH)

**Plan step:** Task 7 `syncApple` / `syncGoogle`, Task 9 routes.

| Behavior | Encoding | Verdict |
|---|---|---|
| Apple: expected != verified → 403 BEFORE upsert | Explicit (Task 7, line 2003–2005) — check is before the `prisma.$transaction` | **ENCODED** |
| Google: expected != verified → 403 BEFORE upsert | Explicit (Task 7, line 2057–2059) | **ENCODED** |
| Task 9 checkout passes `expectedAppAccountToken: deriveAppleToken(userId)` | Explicit (Task 9 Step 9.2, line 2504) | **ENCODED** |
| Task 9 restore passes the expected token | Explicit (line 2544–2553) | **ENCODED** |
| Task 10 webhooks do NOT pass `expected*` | Explicit comment (line 2928 `// webhook path does NOT pass expectedAppAccountToken (spec §12.3)`) | **ENCODED** |

This guarantee is well-encoded.

### 5.1 [NIT] Restore continues on `user_mismatch` (logs and moves on) — spec said "treated as user_mismatch ... both cases continue"

Spec §5.3 restore step 3 says "Both cases continue (skip this one, process the rest)." The plan's restore (Task 9 Step 9.2, line 2558) catches all errors and logs — that's correct. But user_mismatch is currently logged at `warn` with the productId; an attacker bulk-sending forged-but-someone-else's-receipt payloads via Restore will spam the warn channel. Bound by the 20-purchase cap, so impact is bounded.

**No change required.**

---

## 6. Boot-time validation must not leak env values (spec §5.1, round-2 §2.5)

**Plan step:** Task 3 Step 3.6 `env-guard.ts`.

Walked through every `throw new HttpError(...)` in `requireIapEnv`:

```ts
throw new HttpError(503, "iap_not_configured", `${k} is not set`);                          // ✓ name only
throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY base64 decode failed"); // ✓ no value
throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY shape invalid");        // ✓ no value
throw new HttpError(503, "iap_not_configured", "APPLE_ENV must be sandbox|production");       // ✓ no value
throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON base64 decode failed"); // ✓ no value
throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON parse failed");   // ✓ no value
throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON missing client_email/private_key"); // ✓
```

**Verdict: ENCODED.** No env-value substring appears in any error message. The test in Step 3.5 explicitly asserts no leak (lines 578–587).

### 6.1 [LOW] HttpError's stack trace may include local variable names

This is JavaScript's behavior — `throw new HttpError(...)` captures a stack trace, but the stack only carries function names and line numbers, not local variable values (V8 doesn't include locals in `.stack`). So `appleKeyRaw` value won't appear. Confirmed safe.

**No change required.**

---

## 7. Sandbox/prod environment filter (spec §8, round-2 §2.6)

**Plan step:** Task 8 `precedence.ts filterEnvironmentRows`, Task 7 upserts populate `environment`.

| Behavior | Encoding | Verdict |
|---|---|---|
| `filterEnvironmentRows` excludes Sandbox in prod | Explicit (Task 8 Step 8.2, line 2246–2252) | **ENCODED** |
| Applied in `buildMeBody` | Explicit (Task 8 Step 8.4, line 2275–2276) | **ENCODED** |
| Applied in `effectiveTier` (auth/tier.ts) | Explicit (Task 8 Step 8.5, line 2297–2302) | **ENCODED** |
| `Subscription.environment` populated in Apple upsert | Explicit (Task 7 Step 7.6, line 2035 + 2042) | **ENCODED** |
| `Subscription.environment` populated in Google upsert | Explicit (Task 7 Step 7.6, line 2075 + 2101 + 2108) | **ENCODED** |

### 7.1 [MEDIUM] `buildMeBody` change requires signature change — plan doesn't show the existing callers being updated

**Where:** Task 8 Step 8.4 says:

> *"buildMeBody doesn't have direct app access — pass app.fina.env.APPLE_ENV as a parameter, OR read from a module-scope env. Cleanest: change `buildMeBody(userId)` → `buildMeBody(userId, runtimeEnv)` and pass from each caller."*

The plan flags this but doesn't enumerate the callers or write the changes. `buildMeBody` is exported / called from at least:
- `apps/api/src/routes/billing.ts` (existing `/me`, `/billing/sync`)
- The new `/billing/iap/checkout` and `/billing/iap/restore` in Task 9 Step 9.2 (lines 2521, 2562) which call `await buildMeBody(userId, cfg.apple.env)` — but this passes `"sandbox"` | `"production"` directly while `filterEnvironmentRows` expects `"sandbox" | "production"` too. Match check.

**Remediation:** Add a Step 8.4b that lists every existing call site to `buildMeBody` in `apps/api/src/routes/billing.ts` and updates them. As written, the plan leaves "update each caller" as homework, and one of those callers is the existing `/me` route — which the plan doesn't show changing.

### 7.2 [MEDIUM] `effectiveTier` minimum-fields hack hides a real schema concern

**Where:** Task 8 Step 8.5, line 2299–2302.

```ts
const filtered = filterEnvironmentRows(
  activeSubs.map((s) => ({ ...s, source: "", createdAt: new Date(), sourceSubscriptionId: "" })),
  runtimeEnv,
);
```

The `filterEnvironmentRows` signature uses a `Sub` type requiring `source`, `createdAt`, `sourceSubscriptionId` — none of which the filter actually reads (it only reads `environment`). The plan synthesizes empty values to satisfy the type. This works, but:

- The Prisma `select` should be expanded to include `environment` (currently `select: { tier: true, environment: true }` — OK).
- The type confusion suggests `filterEnvironmentRows<T extends { environment: string }>` is the right shape, not the wider `Sub` type.

**Remediation:** Narrow the type in `precedence.ts` to `<T extends { environment: string }>` and drop the synthetic-fields hack.

---

## 8. Pino redact rules (spec §5.1, round-2 §8.1)

**Plan step:** Task 3 Step 3.8.

Plan's redact paths (line 701–713):
```
env.APPLE_ASC_PRIVATE_KEY
env.GOOGLE_SERVICE_ACCOUNT_JSON
*.APPLE_ASC_PRIVATE_KEY
*.GOOGLE_SERVICE_ACCOUNT_JSON
*.private_key
*.purchaseToken
*.signedTransactionInfo
*.appAccountToken
*.receipt
```

Spec required:
- APPLE_ASC_PRIVATE_KEY ✓
- GOOGLE_SERVICE_ACCOUNT_JSON ✓
- *.private_key ✓
- *.purchaseToken ✓
- *.signedTransactionInfo ✓
- *.appAccountToken ✓
- *.receipt ✓

**Verdict: ENCODED.**

### 8.1 [LOW] Missing `*.signedPayload` and `*.signedRenewalInfo`

The spec lists `signedTransactionInfo` explicitly but a webhook handler that logs `{ signedPayload: req.body.signedPayload }` or `{ signedRenewalInfo: renewal }` would still bypass redaction. These two are JWS strings just as sensitive as `signedTransactionInfo` (same cert chain, same PII content).

Also missing from redact: `*.jwsRepresentation` (StoreKit 2's name for the same payload, which the mobile code surfaces in Task 11).

**Remediation:** Add `*.signedPayload`, `*.signedRenewalInfo`, `*.jwsRepresentation` to the redact list.

### 8.2 [LOW] Plan's `WebhookEvent.body` (introduced in Task 10) is unredacted

Task 10 Step 10.2 stores `body: { appAccountToken: verifiedTx.appAccountToken }` into `WebhookEvent.body` (line 2919). If `app.log.info({ event })` ever logs a fetched `WebhookEvent` row, the `body.appAccountToken` is at depth 2 from the log record root, so `*.appAccountToken` should match — confirm with Pino path syntax. If Pino requires `*.body.appAccountToken` explicitly, add it.

**Remediation:** Add `*.body.appAccountToken`, `*.body.obf` (the Google path).

---

## 9. Raw-body parser for webhook signature (spec §5.3, round-2 §5.2)

**Plan step:** Task 10 Step 10.2, lines 2837–2847.

```ts
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (_req, body, done) => {
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (e) {
      done(e as Error, undefined);
    }
  },
);
```

The plan parses-as-buffer and then immediately JSON-parses the buffer. This **defeats the purpose of the raw-body parser** for Apple's case:

- For Google: the body IS a JSON envelope (`{message, subscription}`). The Pub/Sub OIDC token in `Authorization:` header is verified independently; the body just needs to be parsed JSON. ✓ OK.
- For Apple: the body is `{signedPayload: "<JWS string>"}`. The signature is over the JWS *content*, not the outer JSON wrapper. So Apple also doesn't need raw bytes of the outer envelope — it needs the JWS string inside.

So the raw-body parser is **unnecessary** for IAP webhooks. Stripe's case is different (Stripe signs the raw body bytes for HMAC; re-stringifying would break the HMAC).

The plan still uses `parseAs: "buffer"` and parses. This is harmless but adds a marshalling step. The bigger concern is the comment "Mirrors apps/api/src/routes/billing-webhook.ts:11" — that mirror is *wrong*; Stripe's parser delivers a raw Buffer to the handler, IAP's parser delivers a parsed object. The mirror suggests the implementer treats both routes the same way and may, by reflex, try to access `req.body` as a Buffer elsewhere.

### 9.1 [LOW] Misleading parser comment

**Remediation:** Update the comment to clarify: *"Scoped JSON parser for IAP webhooks. Unlike Stripe's HMAC over raw bytes, Apple ASSN signs the inner JWS (not the envelope) and Google Pub/Sub signs an OIDC token in the header. So parsing JSON here is fine. Scoped via plugin encapsulation."*

### 9.2 [MEDIUM] `addContentTypeParser` inside the plugin may collide with the Stripe parser already registered globally

The existing `billing-webhook.ts` plugin also registers a JSON parser scoped to its plugin (line 11–15). Fastify resolves content-type parsers in the encapsulation hierarchy, so two sibling plugins each registering for `application/json` may conflict — the second registration throws `FST_ERR_CTP_ALREADY_PRESENT`. The plan doesn't verify scope isolation.

**Remediation:** Register the IAP webhook routes under their own `fastify-plugin` boundary OR use `fastify.register(handler, { prefix: "/webhooks/iap" })` such that the encapsulation is fresh. Test that both `/webhooks/stripe` and `/webhooks/iap/apple` can be hit in the same Fastify instance — the integration test in Step 10.5 builds a fresh app per test (`buildApp({...})`), which may hide a real production collision.

---

## 10. Deterministic binding tokens cross-platform (spec §6, §7)

**Plan step:** Task 7 (server `binding.ts`), Task 11 (mobile `binding.ts`).

| Check | Encoding | Verdict |
|---|---|---|
| Server uses uuidv5 + IAP_NAMESPACE from @fina/shared | Explicit (Task 7 Step 7.2, line 1713) | **ENCODED** |
| Mobile uses uuidv5 + IAP_NAMESPACE from @fina/shared | Explicit (Task 11 Step 11.4, line 3111–3117) | **ENCODED** |
| Server sha256 hex utf-8 input | Explicit (line 1720) | **ENCODED** |
| Mobile sha256 hex via js-sha256 (utf-8 default) | Explicit (line 3142–3143) | **ENCODED** |

### 10.1 [HIGH] Mobile `sha256Hex` uses `require("js-sha256")` synchronously — won't work in production Hermes

**Where:** Task 11 Step 11.4, lines 3137–3144.

```ts
export function sha256Hex(input: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sha256 } = require("js-sha256");
  return sha256(input);
}
```

The file also exports `sha256HexAsync` via `expo-crypto` for production use, but `binding.ts deriveGoogleToken` calls **`sha256Hex`** (the sync one) — and `purchaseSubscription` in `client.ts` calls `deriveGoogleToken(args.userId)` (line 3225). So at runtime on a real Android device, `deriveGoogleToken` runs the sync version using `js-sha256`. The plan comment claims this is "test parity" but the production code path uses it too.

`js-sha256` is a pure-JS implementation and DOES work under Hermes (no native deps). So functionally it's fine. **But:**

- Loading `js-sha256` via `require()` inside the function on every call is slow (no module-level caching for Hermes lazy-require).
- `js-sha256`'s default encoding on string input is UTF-8 — matches `node:crypto`'s `.update(str, 'utf8')`. ✓
- The plan installs `js-sha256` *conditionally* ("if not already present"). Better Auth's mobile SDK does NOT depend on js-sha256 — the plan's comment claiming it's "already in deps because it's used by Better Auth's client" is incorrect. So this is a new dep.

**Remediation:**
- Import `js-sha256` at module top-level, not inside the function.
- Drop the misleading "already in deps because Better Auth" comment.
- Add a unit test that asserts `mobile deriveGoogleToken("test-user") === server deriveGoogleToken("test-user")` (cross-package parity).

### 10.2 [MEDIUM] No cross-platform parity test exists

The plan tests `binding.ts` on both sides but never asserts they produce the **same output for the same input**. A subtle encoding difference (UTF-16 input on mobile vs UTF-8 on server) would silently produce different binding values and the user would 403 user_mismatch on every checkout.

**Remediation:** Add a cross-package fixture test:
```ts
// libs/shared/test/iap/binding-parity.test.ts (or equivalent)
it("uuidv5 of 'fixture-user-id' is exactly '<known-uuid>'", () => {
  expect(uuidv5("fixture-user-id", IAP_NAMESPACE)).toBe("<known-uuid>");
});
it("sha256 hex of 'fixture-user-id' is exactly '<known-hex>'", () => {
  expect(sha256Hex("fixture-user-id")).toBe("<known-hex>");
});
```
Both server and mobile import this fixture. Any divergence flunks both.

---

## 11. `appAccountToken` propagation to Apple (spec §6)

**Plan step:** Task 11 Step 11.6, lines 3213–3219.

```ts
const purchase = await requestSubscription({
  sku: args.productId,
  appAccountToken,
});
```

### 11.1 [HIGH] `react-native-iap` v12's `requestSubscription` parameter name is `appAccountToken` for iOS — but the plan doesn't verify

`react-native-iap`'s API for iOS appAccountToken propagation has gone through multiple iterations. Older versions used `applicationUsername`; v12 uses `appAccountToken`. The plan installs `react-native-iap` (latest, which is v12.x as of 2026-05) but does not pin the version (`npm install react-native-iap` not `react-native-iap@12.x`).

If a future minor version renames or removes this parameter, the appAccountToken silently stops being forwarded to StoreKit, and every iOS purchase returns a JWS with `appAccountToken: undefined`, which Task 4 Step 4.6 line 1105–1108 rejects as `user_mismatch`. The whole iOS purchase flow breaks.

**Remediation:**
- Pin to a specific major: `npm install react-native-iap@^12.0.0`.
- Add a runtime check in `purchaseSubscription`: after getting back the purchase object, verify the local JWS contains the expected appAccountToken before POSTing to the server (this catches the misconfiguration before the server reject).
- Document the parameter name + library version in `apps/mobile/src/iap/client.ts` as a comment.

### 11.2 [NIT] Android `subscriptionOffers: undefined` may be required

**Where:** Task 11 Step 11.6, line 3229.

`react-native-iap` v12 may require `subscriptionOffers` to be a non-empty array for Android subscriptions with offers. The plan passes `undefined`. v1 has no offers (no intro, no trial), so this is correct for v1 — but the plan doesn't justify it.

**No change required for v1.** Add a comment: `// no offers in v1; intro/trial added in v1.5`.

---

## 12. Account-deletion writes tombstone (spec §12.1)

**Plan check:** Does any task write to `IapDeletedBinding` on account deletion?

**Verdict: MISSING.** Searched the plan for `IapDeletedBinding.create` outside of test fixtures. Only the *read* path (Task 10) and *test seeding* (Task 10 Step 10.1 line 2686–2688) use it. **No task implements the write path.**

The plan acknowledges this in self-review §"§12.1 GDPR retention + IapDeletedBinding write":
> *"schema in Task 2; webhook tombstone read in Task 10. Account-deletion writes are deferred to whoever builds the deletion flow (linked in spec)."*

The deferral is **acceptable for v1** (no account-deletion flow exists yet), but:

### 12.1 [HIGH] Plan should explicitly add a task — or a marked TODO note in code — for the future implementer

Without a hook point, when the account-deletion flow is built later, the implementer may:
- Forget to write tombstones, leaving webhooks 500-ing for 5 retries on every deleted user.
- Write to the wrong source string (e.g., `"apple_iap"` instead of `"iap_apple"`), silently failing the tombstone read.
- Use the wrong hash function.

**Remediation (required):**
- Add a final Task 14: "Document account-deletion integration points." A markdown doc, not code, that:
  - Lists exactly what the deletion flow must do (write tombstone with `source: "iap_apple"`, `tokenHash: hashBindingToken(user.iapAppleAccountToken)`, repeat for google).
  - Provides a code stub the deletion-flow implementer pastes in.
  - References the spec §12.1 retention requirements.
- Alternatively, expose a helper function in `binding.ts`: `writeAccountDeletionTombstones(userId): Promise<void>` that the future deletion flow imports. Tests for the helper land in Task 7 with the rest of binding.

---

## 13. GDPR retention (spec §12.1, round-2 §2.10)

**Plan check:** Does any task implement PII-null + retain-for-6-years?

**Verdict: MISSING.** Same as 12.1 — deferred to the future deletion flow. The plan's self-review acknowledges deferral.

### 13.1 [LOW] Acceptable deferral, but document the field-level guidance

The retention pattern requires nulling `Subscription.sourceCustomerId` and **future** PII-bearing fields. There are no current PII-bearing fields beyond `sourceCustomerId`. The future implementer needs to know which columns count as PII.

**Remediation:** Add to the Task 14 doc (or wherever account deletion is documented): explicit list of columns the deletion flow must null. Today: `sourceCustomerId`. Future v1.5 additions like `cancellationReason` will need re-evaluation.

---

## 14. WebhookEvent.body field — schema-change ordering

Already covered as **4.1 HIGH**. The `body Json?` migration belongs in Task 2, not Task 10.

---

## 15. Anything missing entirely

### 15.1 [MEDIUM] No task wires the new error codes into the existing API error response handler

Task 1 Step 1.11 appends new error codes to `API_ERROR_CODES`. But the API's existing `HttpError` → response mapping (presumably in `auth/context.ts` or a server hook) needs to translate `iap_not_configured` → 503, `invalid_receipt` → 400, etc. The plan doesn't verify this mapping exists or update it.

**Remediation:** Add a step to Task 3 (or wherever HttpError is centralized) to verify the new codes route to their declared status codes. The plan's `HttpError(503, "iap_not_configured", ...)` already specifies the status, so this depends on whether the server's error serializer trusts `e.statusCode` or maps from `e.code`. Inspect `auth/context.ts` and confirm.

### 15.2 [HIGH] Mobile `react-native-iap` purchase error states (cancelled, network, etc.) are not handled

**Where:** Task 11 Step 11.6 `purchaseSubscription` and Task 12 Step 12.1 `onSubscribe`.

The plan catches any thrown error and shows `Alert.alert("Couldn't subscribe", e?.message)`. But `react-native-iap` distinguishes:

- User-cancelled purchase: code `E_USER_CANCELLED` — should silently dismiss, not show an alert ("Couldn't subscribe" after the user explicitly cancelled is bad UX).
- Network failure: code `E_NETWORK_ERROR` — should suggest "check your connection, try again".
- Item unavailable: code `E_ITEM_UNAVAILABLE` — should suggest restart.
- Already owned: code `E_ALREADY_OWNED` — should automatically run Restore flow (this is the "I subscribed before but server doesn't know" case).
- Service unavailable: code `E_SERVICE_ERROR` — try later.

The plan's blanket `e?.message ?? "Try again."` shows the raw library error message to the user — non-localized, often inscrutable, and "User cancelled the purchase" reads like an error to a normal user.

**Remediation:** Add a step to Task 12 to switch on the error code from `react-native-iap` and produce appropriate UX. Specifically: `E_USER_CANCELLED` → silently return (no alert), `E_ALREADY_OWNED` → suggest Restore flow.

### 15.3 [MEDIUM] No task handles iOS Family Sharing notification AFTER the JWS verify (only before)

Task 10 Step 10.2 lines 2877–2883 handle Family Sharing via:

```ts
if (
  notification.notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
  notification.subtype === "PRODUCT_NOT_FOR_SALE"
) {
  await prisma.webhookEvent.create({...});
  return { ok: true };
}
```

Good — but the plan also calls `verifyAndDecodeTransaction` on `notification.signedTransactionJws` (line 2885) **after** the Family Sharing skip. Wait — the skip uses `notification.notificationType === "DID_CHANGE_RENEWAL_STATUS"` which is dispatched BEFORE the inner transaction verify (line 2877–2883 runs before line 2885). So Family Sharing notifications never reach the transaction verify. ✓ Encoded correctly.

But spec §6 says ANY notification with subtype `PRODUCT_NOT_FOR_SALE` should be treated like `EXPIRED` — not silently ignored. The plan creates a WebhookEvent with `type: "ignored_family_sharing"` but does NOT flip the user's subscription status to `canceled`. So a family-shared user who loses access keeps their entitlement until the next non-family notification (or expiry).

**Remediation:** When Family Sharing revocation arrives, mark the subscription `status: canceled` for that `originalTransactionId` — match the spec's "treat like a regular EXPIRED".

---

## Summary of findings by severity

### CRITICAL (2)
- **1.1** Apple root cert is a `<<<placeholder>>>` PEM, tests pass without it, downgrades SPKI hash defense to PEM bytes comparison.
- **2.3** Apple ASSN notification payload decoded via `verifyAndDecodeTransaction` instead of a dedicated `verifyAndDecodeNotification` API — webhook signature verification will not work.

### HIGH (4)
- **3.1** `acknowledgeIfPending` re-fetches v2 payload — wasted API call + TOCTOU window.
- **3.2** `purchases.subscriptions.acknowledge` called with `subscriptionId: ""` — wrong method, returns 400.
- **4.1** `WebhookEvent.body` column added in Task 10 but used in Task 10's tests; should be added in Task 2 with the rest of the migration.
- **4.3** Retry-counter and dedup share `WebhookEvent.id`; real-Apple retries with same notificationUUID short-circuit the counter, retry-cap never trips.
- **10.1** Mobile `sha256Hex` uses `require()` inside function call; comment claims js-sha256 is already a dep (it isn't).
- **11.1** `react-native-iap` version not pinned; the appAccountToken parameter name can silently change.
- **12.1** No task — and no doc — for the account-deletion flow to write `IapDeletedBinding` tombstones.
- **15.2** No handling for `react-native-iap` user-cancel / already-owned error codes; bad UX for cancelled purchases.

### MEDIUM (5)
- **1.2** Apple alg=ES256 check is implicit via SDK with no test asserting alg=none is rejected.
- **2.1** OIDC issuer accepts only `https://accounts.google.com`, not the schemeless form Google sometimes uses.
- **4.2** Tombstone hash naming may confuse future migrations.
- **7.1** `buildMeBody` signature change not enumerated for existing callers.
- **7.2** `effectiveTier` synthetic-fields hack to satisfy a too-wide type.
- **9.2** Plugin-scoped JSON parser may collide with existing Stripe parser.
- **10.2** No cross-platform parity test for binding token derivation.
- **15.1** New error codes' status-code mapping not verified.
- **15.3** Family Sharing notification logs but doesn't flip status to `canceled`.

### LOW (3)
- **1.3** ASC API inner JWS decoded without re-running checks 3–6.
- **2.2** `OAuth2Client.verifyIdToken`'s default 5-min skew is shadowed by manual check; comment missing.
- **4.4** Google retry counter has the same issue as 4.3.
- **6.1** HttpError stack trace doesn't leak env values (defense-in-depth verified).
- **8.1** `*.signedPayload`, `*.signedRenewalInfo`, `*.jwsRepresentation` missing from redact paths.
- **8.2** `WebhookEvent.body.appAccountToken` path may need explicit redact entry.
- **9.1** Misleading "mirror" comment on raw-body parser.
- **11.2** Android `subscriptionOffers: undefined` not justified in comment.
- **13.1** No documented column-level PII guidance for the future deletion flow.

### NIT (2)
- **5.1** Restore logs `user_mismatch` at warn — bounded by 20-cap.
- **11.2** Android offers comment.

---

## Verdict

**APPROVE WITH CHANGES.**

The plan demonstrates real engagement with the spec's security requirements and the round-2 review. Most guarantees are encoded in actual code: the 6 Apple JWS checks are mostly there, OIDC verification is comprehensive, the token-match check is in the right place, sandbox/prod filter is wired into both `buildMeBody` and `effectiveTier`, redact rules cover all spec-required paths.

But there are **two CRITICALs that will break production on the first real ASSN webhook** (1.1 placeholder root cert; 2.3 wrong SDK method) and **four HIGHs** that range from "tests pass but prod is broken" (3.2, 4.3) to "future implementer has no guide rails" (12.1).

**Required before implementation begins:**

1. Replace the `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>` placeholder with a real PEM AND an SPKI hash validation, both in the constant and in env-guard boot validation. Add a test that fails if the constant doesn't parse as a valid X.509. (1.1)
2. Split `apple-client.verifyAndDecodeTransaction` into transaction vs notification verifiers. The webhook calls the notification verifier; ASC API responses call the transaction verifier. (2.3)
3. Replace `purchases.subscriptions.acknowledge({subscriptionId: ""})` with `purchases.subscriptionsv2.acknowledge({packageName, token})`. (3.2)
4. Move the `WebhookEvent.body` schema change from Task 10 to Task 2 (single IAP migration). (4.1)
5. Move dedup-record creation to AFTER successful sync (matches Stripe pattern); use a separate counter table or key the retry-cap on the binding token (not notificationUUID) so Apple's real retry behavior trips the cap. (4.3, 4.4)
6. Pin `react-native-iap` major version + add runtime check that the returned JWS carries the expected appAccountToken before POSTing. (11.1)
7. Add a Task 14 or equivalent that documents the account-deletion integration points and provides a `writeAccountDeletionTombstones(userId)` helper for the future deletion flow. (12.1)
8. Handle `E_USER_CANCELLED` / `E_ALREADY_OWNED` from `react-native-iap` distinctly in the mobile UI. (15.2)

**Recommended (MEDIUMs):** Address before merge — none are architectural, all are text/code edits.

**LOWs and NITs:** Can land alongside implementation or in follow-up.

Once items 1–8 above are in the plan, this is good to execute.
