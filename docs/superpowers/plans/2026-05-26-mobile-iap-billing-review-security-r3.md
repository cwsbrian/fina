# Mobile IAP Billing — Plan Security Review, Round 3

**Plan reviewed:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md` @ `90676b4`
**Prior reviews:** Round 1 (design spec), Round 2 (`*-review-security.md`)
**P-commits verified:** P1 `a074ff0`, P2 `e9f315e`, P3 `a542d66`, P4 `5ac3e53`, P5 `02ff6e0`, P6 `409c472`, P7 `418582a`, P8 `90676b4`
**Date:** 2026-05-26
**Reviewer focus:** verify round-2 must-fix list closed; surface regressions from the patches.

---

## Executive summary

The author engaged seriously with every round-2 ask. All 10 REQUIRED items from round-2 are now addressed; 9 are fully fixed, 1 is partial. The MEDIUM/LOW set is mostly closed (10/11 landed; 1 explicitly deferred). The patches did introduce a small number of new concerns — none CRITICAL, two HIGH, three MEDIUM. Most notable new issues:

| Sev | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 3 |
| LOW | 4 |
| NIT | 2 |

Two patches deserve special attention:

- **P3 root-cert validation is good engineering** (boot-time SPKI hash check, array of expected hashes for rotation, parse error throws fail-loud). The placeholder strings in the constants are *intended* to throw on load — that's the safety net. But the test in Step 4.6c will pass green on a fresh checkout only if the installer has filled both constants first; otherwise the existing API tests that wire `buildApp` will all break with an unhelpful module-load error before any test runs. See finding **N3.1**.
- **P5's dedup-after-success + IapRetryCounter** is correct and elegantly solves round-2 §4.3. The sequence is verifiable: 500 paths don't write the dedup row, retries see same UUID, IapRetryCounter increments atomically via `{ increment: 1 }`, cap-trip writes the dedup row, subsequent retries short-circuit. ✓

---

## 1. Round-2 must-fix verification

### CRITICAL 1.1 — Apple root cert PEM + SPKI hash validation

**Status: FIXED.**

P3 introduced `apps/api/src/iap/apple-roots.ts` (plan lines 1436–1477) with:
- `APPLE_ROOT_CERTS: Buffer[]` — array for rotation support.
- `EXPECTED_APPLE_ROOT_SPKI_SHA256: ReadonlyArray<string>` — pinned hashes.

`apple-client.ts` calls `validateAppleRoots()` at module load (plan lines 1220–1251). The function:
1. Rejects empty array (line 1221–1226).
2. Detects placeholder markers `<<<` / `>>>` and throws (lines 1228–1234).
3. Parses each PEM with `new X509Certificate(pem)` (lines 1235–1240).
4. Computes SPKI SHA-256 via `cert.publicKey.export({ type: "spki", format: "der" })` and `createHash("sha256").update(spki).digest("hex")` (lines 1241–1242).
5. Compares against the pinned set; throws if mismatch (lines 1243–1248).

Test (Step 4.6c, lines 1481–1507) asserts:
- No placeholder markers remain.
- Every cert parses and its SPKI hash is in the expected set.

**Verdict:** round-2 CRITICAL 1.1 closed. The PEM-bytes-vs-SPKI-hash downgrade is fixed (SPKI hash is the load-bearing comparison, PEM is just the input).

---

### CRITICAL 2.3 — Apple ASSN uses `verifyAndDecodeNotification`

**Status: FIXED.**

P3 added a dedicated `AppleClient.verifyAndDecodeNotification` (plan lines 1398–1420) that calls `this.verifier.verifyAndDecodeNotification(signedPayload)` (the SDK's separate API for notification envelopes). The webhook path uses it:

- `webhook-verify.ts verifyApplePayload` now delegates to `deps.appleClient.verifyAndDecodeNotification(signedPayload)` (plan line 1929).
- The notification result surfaces `notificationUUID`, `notificationType`, `subtype`, `signedTransactionJws`, and `raw`.
- The inner `signedTransactionJws` then goes through `verifyAndDecodeTransaction(..., { context: "assn" })` (plan line 3311) — separate call, six-check validator.

The webhook handler in Task 10 lines 3274–3381 honors this two-step pattern. `verifyAndDecodeTransaction` is no longer called on the outer envelope.

**Verdict:** round-2 CRITICAL 2.3 closed.

---

### HIGH 3.1 — `acknowledgeIfPending` no double-fetch

**Status: FIXED.**

P4 refactored `acknowledgeIfPending(args)` to accept `{ purchaseToken, productId, acknowledgementState }` (plan lines 1731–1739). It does not refetch — it short-circuits on the passed-in state.

`syncGoogle` (plan lines 2476–2480) passes `v2.acknowledgementState` from the prior `fetchAndNormalize`, eliminating the TOCTOU + 150ms-latency window.

**Verdict:** FIXED.

---

### HIGH 3.2 — Google `_acknowledge` correct `subscriptionId`

**Status: FIXED.**

P4's `_acknowledge(purchaseToken, productId)` (plan lines 1684–1695) now requires `productId` (which is the v1 endpoint's required `subscriptionId` parameter). The comment at line 1683 documents the rationale and notes v2 has no acknowledge method as of `googleapis@^140`. `acknowledgeIfPending` passes `args.productId` derived from the prior `fetchAndNormalize` result.

**Verdict:** FIXED.

---

### HIGH 4.1 — `WebhookEvent.body` migration in Task 2

**Status: FIXED.**

P2 consolidated all schema changes into Task 2:
- `User.iapAppleAccountToken` + `iapGoogleObfuscatedId` (Step 2.1).
- `Subscription.environment` (Step 2.2).
- `IapDeletedBinding` model (Step 2.3, lines 512–525).
- `IapRetryCounter` model (Step 2.3, lines 534–545).
- `WebhookEvent.body Json?` column (Step 2.3, lines 548–555).

Single `migrate dev --name iap_billing` run covers all five.

**Verdict:** FIXED.

---

### HIGH 4.3 — Dedup vs retry-counter separation; counter keyed on binding token

**Status: FIXED.**

P5 introduces the `IapRetryCounter` table (Task 2 Step 2.3, lines 534–545) keyed on `(source, tokenHash)` — i.e., on the binding token, NOT the notificationUUID.

The Apple webhook handler (plan lines 3343–3360) does:
1. On 500 path: `prisma.iapRetryCounter.upsert(...)` with atomic `{ increment: 1 }`.
2. If `counter.attempts > MAX_UNKNOWN_RETRIES (5)`: write `WebhookEvent.create` (dedup row) with `type: "unattributable_giveup"`, return 200.
3. If counter ≤ cap: return 500 WITHOUT writing the dedup row — so Apple's next retry with the SAME notificationUUID does NOT short-circuit at the dedup check.

The test (Step 10.1 lines 3093–3128) uses a stable `notificationUUID: "uuid-4-stable"` across the 5 retries (matching real Apple retry behavior) and asserts attempts 1–5 return 500, attempt 6 returns 200 with forensic row, attempt 7 hits the dedup short-circuit.

Successful sync path (lines 3362–3372) writes the dedup row AFTER `syncSubscriptionFromIAP` succeeds — matches the Stripe pattern (`billing-webhook.ts:51` writes `webhookEvent.create` only AFTER `handleEvent`).

**Verdict:** FIXED. Architecturally correct.

---

### HIGH 10.1 — Mobile `sha256Hex` top-level import; drop misleading comment

**Status: FIXED.**

P7 split `binding.ts` and `sha256.ts` into separate files (plan lines 3558–3570):

```ts
// apps/mobile/src/iap/sha256.ts
import { sha256 } from "js-sha256";          // ← top-level import
export function sha256Hex(input: string): string { return sha256(input); }
```

The misleading "already in deps because Better Auth" comment is gone; the comment now correctly documents js-sha256 as "a new explicit dep installed in Step 11.1." Step 11.1 (plan line 3502) explicitly installs `js-sha256` alongside `uuid` and `react-native-iap`.

**Verdict:** FIXED.

---

### HIGH 11.1 — react-native-iap version pinned + runtime appAccountToken check

**Status: PARTIAL.**

**Pinned version: FIXED.** P7 pins to `react-native-iap@^14` (plan line 3502) with explicit justification at line 3506: "react-native-iap 15.x is a `nitro`-based rewrite that removed `requestSubscription` (replaced by `requestPurchase` with a different signature). v14 still ships `requestSubscription({sku, appAccountToken, obfuscatedAccountIdAndroid})`."

**Runtime appAccountToken check: STILL MISSING.** Round-2 §11.1 also asked for "a runtime check in `purchaseSubscription`: after getting back the purchase object, verify the local JWS contains the expected appAccountToken before POSTing to the server." Reviewing `purchaseSubscription` in Task 11 Step 11.6 (plan lines 3701–3742): the iOS branch extracts the JWS string from `transactionReceipt`/`jwsRepresentation` and returns it directly — no local decode-and-check of the embedded `appAccountToken` claim.

The server enforces this via `expectedAppAccountToken` in `sync-sub.ts` (plan lines 2360–2361), so a misforwarded token surfaces as a 403 user_mismatch from the API. Functionally safe, but the round-2 ask was *defense-in-depth*: catch the misconfiguration on-device before the round-trip.

**Severity:** the *security* guarantee is intact (server is the source of truth). The UX guarantee (clearer error before POST) is not. Round-2 phrased this as HIGH because of the cascading "every iOS purchase silently breaks if rn-iap renames the param" risk — pinning to ^14 mitigates that risk to "until you bump the dep." Given the pin, this becomes LOW.

**Verdict:** PARTIAL — pin landed, local pre-check did not. Downgraded to LOW per "the pin closes the actual risk."

---

### HIGH 12.1 — Account-deletion tombstone helper + integration runbook

**Status: FIXED.**

P8 adds Task 14 (plan lines 4145–4338):
- `apps/api/src/iap/account-deletion.ts` with `writeAccountDeletionTombstones(userId)` (plan lines 4222–4245). Idempotent, no-ops for non-IAP users, writes apple + google tombstones with `userIdHash` for support-replay.
- Re-export from `binding.ts` (Step 14.3).
- `docs/runbooks/iap-account-deletion.md` runbook (lines 4258–4312) — explicit "MUST do" / "MUST NOT do" sections, code stub for `prisma.$transaction`, verification step.
- Tests (Step 14.1, lines 4157–4205) cover happy path, no-op case, idempotency.

**Verdict:** FIXED.

---

### HIGH 15.2 — Mobile UI handles E_USER_CANCELLED / E_ALREADY_OWNED distinctly

**Status: FIXED.**

P7 adds `IapPurchaseError` class (plan lines 3691–3699) with `code` and `recoverable` fields. `purchaseSubscription` normalizes rn-iap codes (lines 3729–3741):
- `E_USER_CANCELLED` → recoverable
- `E_ALREADY_OWNED` → recoverable
- `E_NETWORK_ERROR` / `E_SERVICE_ERROR` → recoverable
- `E_ITEM_UNAVAILABLE` → not recoverable
- Anything else → `E_UNKNOWN`

UI dispatch in Task 12 Step 12.1 (plan lines 3878–3895):
- `E_USER_CANCELLED` → silent return (no alert).
- `E_ALREADY_OWNED` → routes to `/plan/restore`.
- Anything else → `Alert.alert("Couldn't subscribe", e.message)`.

**Verdict:** FIXED.

---

## 2. MEDIUM/LOW item verification

### MEDIUM 1.2 — alg=ES256 test asserting alg=none rejection

**Status: DEFERRED (acceptable).** No new test exercises a hand-crafted `alg=none` JWS through the real SDK. The plan still mocks `_decodeAndVerifyJws` (Step 4.5). Round-2 marked this MEDIUM ("future SDK upgrade silently changes behavior"). The SPKI hash validation in P3 means the SDK *cannot* swap to a permissive verifier without `validateAppleRoots()` re-checking on every boot, so the regression surface is bounded. Acceptable to defer.

### MEDIUM 1.3 — ASC inner JWS re-runs checks 3-6

**Status: PARTIAL.** P3's prose instruction at plan line 1434 says: *"Also update `getSubscriptionStatus` to call the dedicated decoders (replace the two `_decodeAndVerifyJws` calls with `verifyAndDecodeTransaction` for `signedTransactionInfo` and `verifyAndDecodeRenewalInfo` for `signedRenewalInfo`)."* But the actual code block at plan lines 1359–1360 still reads:

```ts
const tx = await this._decodeAndVerifyJws(item.signedTransactionInfo);
const renewal = await this._decodeAndVerifyJws(item.signedRenewalInfo);
```

The implementer will see the contradiction between prose and code. They'll probably follow the prose (it's the later word) but it's worth a one-line code-block patch so there's no ambiguity. See finding **N3.2**.

### MEDIUM 2.1 — OIDC issuer flexibility

**Status: DEFERRED (acceptable).** Plan line 1967 still strict-equals `https://accounts.google.com`. Round-2 noted this as a forward-compat risk; no patch landed. Per spec, Pub/Sub push tokens consistently use the scheme'd form. Acceptable to defer with a follow-up issue.

### MEDIUM 4.1 — WebhookEvent.body added to redact paths

**Status: FIXED.** P1's Task 0.4 redact list (plan lines 161–177) includes `*.body.appAccountToken` and `*.body.obf`. (Task 3.8 redact list lines 887–910 is the OLDER list and is *not* updated to match — see finding **N3.3**.)

### MEDIUM 7.1 — buildMeBody caller enumeration

**Status: FIXED.** P6 explicit at plan line 2661: *"There is only one existing call site in `billing.ts` (`/billing/sync`). The new IAP routes (Task 9) call this function too."* Verified against the real codebase: `apps/api/src/routes/billing.ts:198` is the sole existing caller. Update at line 2657–2658 covers it.

### MEDIUM 7.2 — filterEnvironmentRows type narrowed

**Status: FIXED.** P6 narrowed the signature (plan lines 2605–2611):

```ts
export function filterEnvironmentRows<T extends { environment: string }>(
  rows: ReadonlyArray<T>,
  runtime: "sandbox" | "production",
): T[]
```

The synthetic-fields hack is gone from `effectiveTier` (plan lines 2686–2687 just pass `activeSubs` directly).

### MEDIUM 8.1 — Missing redact: signedPayload, signedRenewalInfo, jwsRepresentation

**Status: FIXED.** P1's Task 0.4 redact list at plan lines 169–173 includes:
- `*.signedRenewalInfo` ✓
- `*.signedPayload` ✓
- `*.jwsRepresentation` ✓

### MEDIUM 9.2 — Plugin parser collision with Stripe webhook

**Status: DEFERRED (acceptable).** No change to Step 10.2's `addContentTypeParser` registration. The Stripe webhook is already a `fastify-plugin` (encapsulated scope), so two `addContentTypeParser("application/json", …)` calls in *sibling* plugins coexist. Worth a smoke test in Step 10.5 ("hit both /webhooks/stripe AND /webhooks/iap/apple in the same `buildApp` instance") but not a blocker. Could be a follow-up.

### MEDIUM 10.2 — Cross-platform parity test

**Status: FIXED.** P7 Step 11.5b (plan lines 3579–3641) adds `libs/shared/test/iap/binding-parity.test.ts` (server side) and `apps/mobile/src/iap/__tests__/binding-parity.test.ts` (mobile side). Both pin `FIXTURE_USER_ID = "fixture-user-id"` and assert the resulting tokens match. The mobile side imports values from "first server run" — minor UX friction at first install, but works.

**One concern:** the mobile fixture (line 3623) reads `EXPECTED_APPLE = "<paste from server test on first run>"` — a placeholder. The mobile test will FAIL until pasted. That's intentional (forces installer to verify parity), but make sure Step 11.5 verification ordering catches this. See finding **N3.4**.

### MEDIUM 15.1 — ApiErrorCode → status code mapping verified

**Status: FIXED.** P8 Step 14.5 (plan lines 4314–4324) documents the verification: `HttpError` carries `statusCode: number` and `code: string`, route handlers do `reply.code(e.statusCode).send({ error: e.code })`. Smoke-test mention at line 4324 covers the regression case.

### MEDIUM 15.3 — Family Sharing notification flips status to canceled

**Status: FIXED.** P5 plan lines 3298–3309: on `DID_CHANGE_RENEWAL_STATUS` + `subtype: "PRODUCT_NOT_FOR_SALE"`, the handler now:
1. Verifies the inner transaction JWS to extract `originalTransactionId`.
2. `prisma.subscription.updateMany({ where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId }, data: { status: "canceled" } })`.
3. Writes `WebhookEvent` with `type: "family_sharing_revoked"`.
4. Returns 200.

Test (Step 10.1 lines 3146–3165) asserts the Subscription row's status flips to `canceled`.

**Verdict:** FIXED.

---

## 3. New issues introduced by patches

### N3.1 [LOW] `validateAppleRoots()` runs at module load — risk of import-time failure ordering

P3 adds the line `validateAppleRoots();` at plan line 1251 (module top-level body). This runs immediately on `import "../iap/apple-client.js"`. If the installer hasn't filled `APPLE_ROOT_CERTS` or `EXPECTED_APPLE_ROOT_SPKI_SHA256`, the throw happens during module evaluation — BEFORE `buildApp` has set up Pino, BEFORE the test harness wires `iap-mocks`. Test runs will fail with an opaque "ERR_MODULE_FAILED" or similar.

**Concrete failure mode:** a developer running `npx vitest run` on a fresh clone (without installing the real cert PEM + hash) will see EVERY API test fail at import time with an Error message including `"APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM."` — which is *clear* but appears in CI logs as 100+ test failures rather than 1.

**Walk through every throw in `validateAppleRoots()`:**
- Line 1223: `"APPLE_ROOT_CERTS is empty — install the Apple root cert(s) per spec §5.2 check #2. See apps/api/src/iap/apple-roots.ts."` — no PEM content. ✓
- Line 1231: `"APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM. See https://www.apple.com/certificateauthority/"` — no PEM content. ✓
- Line 1239: `\`APPLE_ROOT_CERTS contains an unparseable certificate: ${(e as Error).message}\`` — uses `e.message` from `new X509Certificate(pem)`. Node's X509 parse error messages don't include the input bytes (they're shape errors like "Bad signature" / "ASN.1 parse error"). ✓ Safe.
- Line 1245: `\`APPLE_ROOT_CERTS SPKI SHA-256 ${spkiHash.slice(0, 16)}… is not in the expected pinned set. Refusing to start.\`` — includes 16 hex chars of the actual SPKI hash. The SPKI hash is itself non-secret (it's a public-key fingerprint, by design). ✓ Safe.

**No PEM content leaks in any error.** Module-load-before-logger is acceptable: the throw goes to stderr unconditionally (Node behavior), no Pino redact bypass.

**Severity:** LOW. The fail-loud-at-deploy behavior is *desired*. Recommendation: the runbook (or Step 4.6b's header comment) should mention "this will surface at first `vitest run` on a fresh checkout — fill the PEM + SHA before running tests." Plan line 1509 already notes "FAILS on a fresh checkout … by design" — sufficient.

**Verdict:** Acceptable. No code change needed.

### N3.2 [MEDIUM] `getSubscriptionStatus` code block in plan still uses `_decodeAndVerifyJws`

Already covered as round-2 MEDIUM 1.3 partial. The prose at line 1434 instructs replacement; the code block at lines 1359–1360 wasn't updated. Implementer might miss the instruction.

**Remediation (text-only):** update the code block at line 1359–1360 to:

```ts
const tx = await this.verifyAndDecodeTransaction(item.signedTransactionInfo, { context: "asc-api" });
const renewal = await this.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
```

— and remove the trailing prose instruction at line 1434.

### N3.3 [MEDIUM] Two redact-list configurations diverge (Task 0.4 vs Task 3.8)

Both Task 0.4 (P1) and Task 3.8 (Step 3.8) write a Pino redact config in `apps/api/src/server.ts`. Task 0.4's list (plan lines 162–176) is the NEW expanded list. Task 3.8's list (plan lines 898–907) is the OLDER list — missing `signedRenewalInfo`, `signedPayload`, `jwsRepresentation`, `body.appAccountToken`, `body.obf`.

If the implementer follows the plan top-to-bottom:
1. Task 0.4 writes the full list.
2. Task 3.8 says "Extend Pino redact config" — but the code block REPLACES (not extends) the smaller list.

**Risk:** implementer copy-pastes Task 3.8's smaller list and *removes* the redact entries added in Task 0.4. The signedRenewalInfo / signedPayload / jwsRepresentation entries silently disappear.

**Severity:** MEDIUM. The defense is real (PII redaction) and this is a regression hazard introduced by P1's expansion of Task 0.4 not being mirrored into Task 3.8.

**Remediation:** Update Task 3.8 to either (a) be marked as a no-op ("redact already wired in Task 0.4 — nothing to add here"), or (b) match Task 0.4's full list verbatim.

### N3.4 [LOW] Mobile binding-parity test ships with placeholder strings

P7 Step 11.5b plan lines 3623–3624:

```ts
const EXPECTED_APPLE = "<paste from server test on first run>";
const EXPECTED_GOOGLE = "<paste from server test on first run>";
```

These are angle-bracket placeholders. The test will FAIL on first run (intentional — forces the installer to compute + paste). No `eslint-disable` or `// TODO` marker to flag this in code review.

**Severity:** LOW. The intent is correct (fail-loud until parity computed) and Step 11.5b's prose at line 3641 documents the paste step. But a casual reader might think this is a placeholder bug.

**Remediation:** Add a brief `// SETUP: replace with output of `cd libs/shared && npx vitest run test/iap/binding-parity.test.ts` (the first run prints EXPECTED_APPLE and EXPECTED_GOOGLE values)` comment in the mobile fixture.

### N3.5 [HIGH] `writeAccountDeletionTombstones` is not transactional across apple+google upserts

P8 Step 14.2 (plan lines 4222–4245). The implementation:

```ts
for (const t of tombstones) {
  await prisma.iapDeletedBinding.upsert({...});  // ← sequential, not in $transaction
}
```

If a user has BOTH apple and google bindings (rare but possible — same Fina account purchased on iOS then re-bound on Android), this is 2 upserts. If the second one fails (DB hiccup), the first one is committed — partial tombstone. Result: webhooks for Apple are recognized; webhooks for Google still 500 for 5 retries.

**Severity:** HIGH because the runbook at lines 4275–4283 explicitly shows the caller wrapping `writeAccountDeletionTombstones` in `prisma.$transaction`. But that outer transaction does NOT protect the two inner upserts — `writeAccountDeletionTombstones` uses the global `prisma` client, not the `tx` handle. Interactive-tx callbacks in Prisma use a *different* client; sequential `prisma.iapDeletedBinding.upsert` outside the callback are not part of the outer transaction.

This is the same architectural reason `billing-webhook.ts:42-47` calls out: *"handleEvent uses the global prisma client (via syncSubscriptionFromStripe), and nesting global-prisma writes inside an interactive tx causes deadlocks in Prisma 5."*

**Remediation:** Either
1. Refactor `writeAccountDeletionTombstones` to accept an optional `tx` handle:

   ```ts
   export async function writeAccountDeletionTombstones(
     userId: string,
     client: typeof prisma | Prisma.TransactionClient = prisma,
   ): Promise<void> { ... use `client.iapDeletedBinding.upsert` ... }
   ```

   And the runbook example becomes `await writeAccountDeletionTombstones(userId, tx)`.

2. Or do both upserts inside an internal `prisma.$transaction([upsert1, upsert2])` (Prisma batch transaction, not interactive — atomic, no deadlock risk).

Option 2 is simpler and matches the v1 surface (no external tx callers exist yet). Option 1 is more flexible for the future deletion flow.

Either way, the current sequential implementation has a real "half-tombstoned user" failure mode.

### N3.6 [LOW] Atomic `{ increment: 1 }` confirmation for IapRetryCounter

P5's webhook handler does:

```ts
const counter = await prisma.iapRetryCounter.upsert({
  where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
  create: { source: "iap_apple", tokenHash: bindingHash, attempts: 1 },
  update: { attempts: { increment: 1 }, lastAt: new Date() },
});
```

Question raised in review brief: "Two parallel webhook deliveries hit the same upsert — race the increment?"

**Answer:** Prisma's `{ increment: 1 }` translates to SQL `UPDATE ... SET attempts = attempts + 1`. PostgreSQL guarantees atomicity at the row level for `UPDATE ... SET col = col + N` (read-modify-write under row lock). The `upsert` itself is `INSERT ... ON CONFLICT DO UPDATE` in Postgres — also atomic per row. So:

- Two parallel `create` paths: first wins, second falls through to `update` with `increment: 1`.
- Two parallel `update` paths: each acquires the row lock in turn; each increments by 1.
- No `findUnique`-then-update read-modify-write window — Prisma compiles this directly to SQL.

**Verdict:** ✓ atomic. No race. The Prisma docs confirm: *"increment, decrement, multiply, divide [...] use atomic operations under the hood."*

This is a confirmation, not a finding — but worth recording so a future reviewer doesn't re-litigate.

### N3.7 [NIT] Family Sharing inner JWS signedDate window check

P5 calls `verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" })` on the inner transaction (plan line 3302). This re-applies all 6 checks including the 1h signedDate window (plan lines 1318–1323 with `maxAgeMs = 60 * 60 * 1000` for ASSN context).

**Question:** could a Family Sharing revocation arrive with an older `signedDate`?

The `signedTransactionInfo` JWS in ASSN V2 is freshly signed by Apple when the notification is emitted — its `signedDate` is the notification dispatch time, not the original purchase time. Apple's docs confirm: *"signedDate: The date and time that the App Store signed the JWS Transaction or JWS Renewal Info."* So it should always be fresh (within minutes of dispatch).

Apple's retry window is 5 days; if a notification is delivered 4 days after first attempt, the `signedDate` is still the original signature time. The 1h window WILL fail at retry 25 (hours 1+).

**Severity:** NIT. This is the same behavior round-2 §1 check 5 already documented; not new. The IapRetryCounter cap-trip path catches this (forensic 200 written, retries stop). But there's a window: retries 1-5 within 1h succeed-the-window, but retry 6+ within 1h trips the counter cap. If retries 1-5 all happen >1h after dispatch (Apple delays first retry by 5 minutes, 15 min, then exponential), retries 4+ might all fail the window check and return 400 instead of 500 — never tripping the counter.

**Walk through:**
- Apple ASSN retry schedule: 1m, 5m, 15m, 30m, 1h, 6h, 24h, 48h, 72h, 96h (10 total over 5 days).
- The 1h-window threshold trips on retry 5 (the 6h delay attempt) — that JWS has `signedDate` from the original 1m attempt, now 6h old.
- For retries 5–10, the `verifyAndDecodeTransaction` throws `expired_receipt` (HttpError 400) at plan line 1322. The handler's outer catch at lines 3373–3380 returns 400 — no counter increment, no dedup row.
- Apple sees 400 → stops retrying immediately (400 ≠ retry-eligible).

**So Family Sharing notifications that arrive after the 1h window terminate cleanly via 400.** The counter never trips because Apple stops on 400. ✓ Acceptable.

**Verdict:** NIT, recorded for trace.

---

## 4. Internal consistency checks

### 4.1 signedDate window enforcement path

Spec §5.2 check 5 (10min ASC / 1h ASSN window) is enforced in:
- `apple-client.ts verifyAndDecodeTransaction` — manual check at plan lines 1318–1323.
- The SDK's `verifyAndDecodeNotification` does NOT re-enforce this on the outer envelope (notification has its own signedDate but the spec window is on inner transaction).
- The inner `signedTransactionJws` is re-validated through `verifyAndDecodeTransaction` (plan line 3311) — six checks, including signedDate window.

**Verdict:** ✓ window enforced on inner transaction; envelope signedDate not relevant.

### 4.2 `verifyAndDecodeRenewalInfo` does NOT re-run checks 3-6

P3's renewal verifier (plan lines 1425–1431) calls `this.verifier.verifyAndDecodeRenewalInfo(jws)` (SDK method). The SDK validates the cert chain + alg (checks 1, 2). Renewal info JWS payloads do NOT carry bundleId / environment / appAccountToken claims (those are transaction-info concepts), so checks 3, 4, 6 cannot apply. Check 5 (signedDate window) is enforced if the SDK does so — Apple's SDK does check signedDate freshness on renewal info too.

**Verdict:** ✓ defense-in-depth-acceptable. Renewal info is read only by `getSubscriptionStatus` which is called from a webhook-or-checkout path; the parent context has already validated the transaction's appAccountToken before reaching renewal.

### 4.3 Dedup-after-success sequence trace

Trace through Apple webhook (plan lines 3274–3381):

1. `verifyApplePayload(body.signedPayload, ...)` — verifies envelope, extracts `notificationUUID`.
2. `prisma.webhookEvent.findUnique({ where: { id: eventId } })` — dedup check.
   - If hit: return 200 immediately.
3. Family-sharing branch (if applicable): verify inner tx, updateMany sub → canceled, write dedup row with `type: "family_sharing_revoked"`, return 200. ✓
4. `verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" })` — six-check on inner.
5. Lookup userId by subscription / user binding / tombstone.
6. If !userId: IapRetryCounter upsert with `{ increment: 1 }`.
   - If `counter.attempts > 5`: write dedup row with `type: "unattributable_giveup"`, return 200. Subsequent retries hit step 2 short-circuit. ✓
   - If `counter.attempts ≤ 5`: return 500. NO dedup row written. Apple retries the same UUID → step 6 again, counter increments. ✓
7. `syncSubscriptionFromIAP(...)` — upsert subscription, write user binding.
8. `prisma.webhookEvent.create({ data: { id: eventId, source: "iap_apple", type: notification.notificationType } })` — dedup row.
9. Return 200.

**Failure mode:** what if step 7 succeeds but step 8 throws (DB error)? Apple retries the same UUID:
- Step 2: dedup check finds no row → continue.
- Step 4-7: re-runs the sync. `syncSubscriptionFromIAP` is documented as idempotent (upsert in Task 7 Step 7.6).
- Step 8: retries the dedup `create`.

**Side-effects beyond the upsert?** None today. The only writes inside `syncSubscriptionFromIAP` are:
- `prisma.subscription.upsert(...)` — idempotent.
- `prisma.user.update({ data: { iapAppleAccountToken: ... } })` — idempotent (same token, same user).
- `googleClient.acknowledgeIfPending(...)` — Apple path doesn't acknowledge; Google's `_acknowledge` is itself idempotent on Play Developer API.

**Verdict:** ✓ no double-side-effects. The "step 7 succeeds, step 8 fails" replay is safe.

### 4.4 Counter table — what if userId is FOUND by step 5 between cap-trip and giveup row?

Race: thread A at attempts=5 increments to 6, writes giveup row, returns 200. Thread B (concurrent retry) at attempts=6 increments to 7, attempts to write giveup row → unique constraint violation on `WebhookEvent.id` (same `eventId`). The handler's outer catch returns 500. Apple retries. Now thread A's giveup row IS in place; thread B's step 2 dedup check hits, returns 200.

**Edge:** thread B logs a 500 once before the dedup eventually stabilizes. Acceptable; counter cap is best-effort backpressure, not exactness.

### 4.5 Cap-trip giveup row's `id` collides with the legitimate next-delivery dedup

When the user later DOES checkout (registers their `iapAppleAccountToken`), and Apple sends a NEW notification for the same purchase with a NEW notificationUUID, the new UUID generates a different `eventId` → no collision. ✓

But: the OLD giveup row's `eventId = "apple:<old-uuid>"` would short-circuit *that* specific UUID forever, even if the user later registers. That's intentional — that specific notification is "given up on" because we capped retries. Apple's next notification (new UUID) goes through fresh.

**Verdict:** ✓ correct.

---

## 5. Pino redact rules consolidated

P1's Task 0.4 (plan lines 161–176) — current canonical list:

```
env.APPLE_ASC_PRIVATE_KEY
env.GOOGLE_SERVICE_ACCOUNT_JSON
*.APPLE_ASC_PRIVATE_KEY
*.GOOGLE_SERVICE_ACCOUNT_JSON
*.private_key
*.purchaseToken
*.signedTransactionInfo
*.signedRenewalInfo                    ← round-2 §8.1
*.signedPayload                         ← round-2 §8.1
*.appAccountToken
*.receipt
*.jwsRepresentation                     ← round-2 §8.1
*.body.appAccountToken                  ← round-2 §8.2
*.body.obf                              ← round-2 §8.2
```

**All round-2 §8.1 and §8.2 additions: PRESENT in Task 0.4.**

**BUT** Task 3.8 (plan lines 898–907) has the OLDER 9-entry list that does NOT include the new entries. See finding **N3.3** above — this is a regression hazard.

---

## 6. GDPR / retention surface

Spec §12.1 says "PII-null + retain 6 years." P8 Task 14:
- `writeAccountDeletionTombstones` writes tombstones (the *webhook recognition* side).
- The runbook (lines 4271–4296) tells future deletion-flow implementer to: "null out PII fields per spec §12.1 retention guidance" — but the helper doesn't do this.

**Question raised in review brief:** "Is the runbook the right surface, or should the helper actually do the PII-null itself?"

**Answer:** the runbook is the right surface for v1 because:
1. The deletion *flow* doesn't exist yet — there's no caller, no test bed.
2. PII-null is column-by-column ownership: `Subscription.sourceCustomerId`, future fields. The IAP module shouldn't dictate the full deletion semantic for OTHER subsystems (Plaid, Chat, etc.).
3. The helper has one focused responsibility (write tombstones) which is unambiguously IAP-scoped.

The runbook explicitly lists `sourceCustomerId` as the v1 PII field to null (line 4291–4292). Future v1.5 additions need re-evaluation by whoever adds them.

**Verdict:** ✓ surface choice is correct. Helper stays focused.

**One nit:** the runbook example at line 4279 calls `writeAccountDeletionTombstones(userId)` *inside* `prisma.$transaction` — but as flagged in **N3.5**, the helper uses the global `prisma`, not `tx`. The runbook example is technically misleading. Fix N3.5 and the runbook becomes correct.

---

## 7. Other observations

### 7.1 [NIT] Self-review §"Placeholder scan" mentions `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>`

Plan line 4362: *"One known gap acknowledged inline: the Apple G3 root cert PEM is a placeholder `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>` in Task 4 Step 4.6"* — but P3 moved this to `apple-roots.ts` and the placeholder marker is now in Step 4.6b (line 1458–1461). The self-review wasn't updated.

**Severity:** NIT. The plan's overall narrative still notes "this is a placeholder" — direction is right, file path is stale.

### 7.2 [NIT] `iap_acknowledge_ok` log line referenced in Gate 3 but not emitted in code

Plan line 4116 (Gate 3 verification): *"Within 5 minutes: API calls `purchases.subscriptionsv2.acknowledge` (verify via API log line `iap_acknowledge_ok`)."*

`_acknowledge` in google-client.ts (plan lines 1684–1695) doesn't emit any log line. The `iap_acknowledge_ok` string appears nowhere else in the plan.

**Severity:** NIT. The smoke checklist references a log line that the implementation doesn't emit. Either add `app.log.info({ purchaseToken: <REDACTED>, productId }, "iap_acknowledge_ok")` in `_acknowledge`, or update the checklist to check the actual signal (e.g., "Google Play Console shows acknowledgement state ACKNOWLEDGED").

Also note the same line says `purchases.subscriptionsv2.acknowledge` — but the code (plan line 1685) uses `purchases.subscriptions.acknowledge` (v1, with the productId workaround). This is a stale reference from before P4's fix.

---

## 8. Summary of findings

### Round-2 must-fix verification (10 items)

| Round-2 ID | Sev | Status |
|---|---|---|
| CRITICAL 1.1 — Apple root cert PEM + SPKI validation | CRIT | **FIXED** |
| CRITICAL 2.3 — Apple ASSN uses verifyAndDecodeNotification | CRIT | **FIXED** |
| HIGH 3.1 — acknowledgeIfPending no double-fetch | HIGH | **FIXED** |
| HIGH 3.2 — Google _acknowledge correct subscriptionId | HIGH | **FIXED** |
| HIGH 4.1 — WebhookEvent.body migration in Task 2 | HIGH | **FIXED** |
| HIGH 4.3 — Dedup vs retry-counter separation | HIGH | **FIXED** |
| HIGH 10.1 — Mobile sha256 top-level import | HIGH | **FIXED** |
| HIGH 11.1 — react-native-iap pin + runtime appAccountToken check | HIGH | **PARTIAL** (pin landed; runtime check skipped — risk now LOW) |
| HIGH 12.1 — Account-deletion tombstone helper + runbook | HIGH | **FIXED** |
| HIGH 15.2 — E_USER_CANCELLED / E_ALREADY_OWNED distinct UI | HIGH | **FIXED** |

### Round-2 MEDIUM/LOW verification

| Round-2 ID | Status |
|---|---|
| MED 1.2 — alg=ES256 explicit rejection test | DEFERRED (acceptable) |
| MED 1.3 — ASC inner JWS checks 3-6 re-run | **PARTIAL** (prose vs code mismatch — see N3.2) |
| MED 2.1 — OIDC issuer flexibility | DEFERRED (acceptable) |
| MED 4.1 — WebhookEvent.body in redact paths | **FIXED** |
| MED 7.1 — buildMeBody caller enumeration | **FIXED** |
| MED 7.2 — filterEnvironmentRows type narrowing | **FIXED** |
| MED 8.1 — signedPayload/signedRenewalInfo/jwsRepresentation in redact | **FIXED** |
| MED 9.2 — Plugin parser collision risk | DEFERRED (acceptable) |
| MED 10.2 — Cross-platform parity test | **FIXED** |
| MED 15.1 — ApiErrorCode → status code mapping | **FIXED** |
| MED 15.3 — Family Sharing flips status to canceled | **FIXED** |

### New findings introduced by P-patches

| ID | Sev | Issue |
|---|---|---|
| N3.1 | LOW | validateAppleRoots() at module load — fail-loud-at-deploy acceptable, doesn't leak PEM content |
| N3.2 | MED | getSubscriptionStatus code block in plan still shows `_decodeAndVerifyJws` despite prose instruction to update |
| N3.3 | MED | Task 0.4 (P1) and Task 3.8 redact configs diverge — Task 3.8 has stale shorter list, implementer may overwrite |
| N3.4 | LOW | Mobile binding-parity test ships with `<paste from server test on first run>` placeholders without explicit guidance comment |
| N3.5 | HIGH | writeAccountDeletionTombstones not transactional across apple+google upserts; runbook's $transaction example doesn't protect inner upserts |
| N3.6 | (info) | IapRetryCounter `{ increment: 1 }` confirmed atomic at SQL layer — no race |
| N3.7 | NIT | Family Sharing inner JWS signedDate window check at retries 6+ produces 400 (not 500) — terminates Apple retries cleanly. Acceptable. |
| 7.1 | NIT | Self-review §"Placeholder scan" references stale file path |
| 7.2 | NIT | Gate 3 verification references `iap_acknowledge_ok` log line + `subscriptionsv2.acknowledge` — neither matches the code |

---

## 9. Required before implementation (action list)

**MUST fix (HIGH):**

1. **N3.5** — Make `writeAccountDeletionTombstones` either accept an optional `tx` client or batch the two upserts in `prisma.$transaction([...])`. Update the runbook example to match.

**SHOULD fix (MEDIUM):**

2. **N3.2** — Update the `getSubscriptionStatus` code block at plan lines 1359–1360 to use the dedicated decoders (`verifyAndDecodeTransaction` + `verifyAndDecodeRenewalInfo`); remove the trailing prose-only instruction at line 1434.
3. **N3.3** — Reconcile Task 0.4 and Task 3.8 redact lists. Recommend: mark Task 3.8 as "no-op — redact already configured in Task 0.4" OR update Task 3.8 to match Task 0.4's full list.

**MAY fix (LOW/NIT):**

4. **N3.4** — Add a SETUP comment to the mobile binding-parity placeholders.
5. **7.1** — Update self-review placeholder-scan reference to point at `apple-roots.ts` (Step 4.6b) instead of Step 4.6.
6. **7.2** — Either emit `iap_acknowledge_ok` log line in `_acknowledge`, or rewrite Gate 3 to verify acknowledgement via Play Console state. Also fix the stale `subscriptionsv2.acknowledge` reference.

The HIGH 11.1 "runtime appAccountToken pre-check" gap from round-2 stays as LOW; the version pin closes the practical risk. Worth a follow-up issue but not blocking.

---

## Verdict

**APPROVE WITH CHANGES.**

Round-2's two CRITICALs are *closed* with real, well-architected fixes (boot-time SPKI validation, dedicated notification verifier). The HIGH set is 9-of-10 fully fixed; the one PARTIAL (runtime appAccountToken pre-check) is no longer HIGH given the version pin. The patches introduce one new HIGH (`writeAccountDeletionTombstones` non-atomicity) and two MEDIUMs, all text-level fixes.

The plan is implementation-ready once:
- **N3.5** is fixed (helper transactionality).
- **N3.2** and **N3.3** are reconciled (prose vs code, redact list duplication).

The remaining items can land as follow-up commits during implementation; none are architectural.

**The author has demonstrated unusually high engagement with security feedback across three rounds.** This is a well-reviewed plan.
