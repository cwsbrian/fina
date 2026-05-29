# Plan review — Mobile IAP Billing (architecture R3)

**Plan under review:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md` (HEAD `90676b4`)
**Prior review (R2):** `docs/superpowers/plans/2026-05-26-mobile-iap-billing-review-architecture.md`
**Patch commits inspected:** `a074ff0` (P1) → `90676b4` (P8) — 8 commits
**Reviewer role:** Round-3 verifier — confirm R2 must-fixes closed, surface regressions
**Date:** 2026-05-26

---

## TL;DR

The author closed 6 of the 7 BUG-class items from R2 cleanly. **The remaining hole is BUG-2 (apple roots placeholder): the chosen design — throw at module load — makes _every_ test that imports `apple-client.ts` (transitively, through the routes) fail at import time, not just the dedicated `apple-roots.test.ts`.** That cascades through Tasks 4, 7, 9, 10, 11+ in tests-first execution and will stall the first subagent.

Three smaller new issues introduced by the patches:

- **NEW-1 (BUG):** Vitest configs don't pick up the test paths the plan invents. `apps/api/vitest.config.ts` includes only `tests/**/*.test.ts`, but Task 8 puts the precedence test at `apps/api/test/billing/precedence.test.ts` (singular) and the run command uses `test/iap/...` (singular) throughout. `libs/shared/vite.config.ts` includes only `src/**/*.{test,spec}.*`, but Task 1 places shared tests at `libs/shared/test/iap/*.test.ts`.
- **NEW-2 (BUG):** Three test files still call `await resetTestDb()` despite the import line being `import { truncateAll } from "../helpers/db.js"`. P1 fixed two of them; three call sites slipped through.
- **NEW-3 (NIT):** Task 0 typo line 37: "All tests live in `apps/api/tests/iap/` (NOT `apps/api/tests/iap/`)" — same path on both sides; the parenthetical was meant to say `apps/api/test/iap/`.

Verdict: **APPROVE WITH CHANGES** (3 small fixes from a clean state).

---

## 1. R2 must-fix verification

### BUG-1 — Apple ASSN should use `verifyAndDecodeNotification` / renewal-info should use `verifyAndDecodeRenewalInfo`

**FIXED.** `AppleClient` now exposes both methods (plan lines 1398-1431). `verifyApplePayload` delegates to `appleClient.verifyAndDecodeNotification` (line 1929). The T6.1 test fake mocks `verifyAndDecodeNotification` and asserts `out.notificationUUID === "uuid-1"` (line 1805) — implementation maps `n.notificationUUID` from the SDK's notification shape, so the assertion passes.

The plan also instructs (line 1434): "Also update `getSubscriptionStatus` to call the dedicated decoders (replace the two `_decodeAndVerifyJws` calls with `verifyAndDecodeTransaction` for `signedTransactionInfo` and `verifyAndDecodeRenewalInfo` for `signedRenewalInfo`)." This is a textual instruction only — the code block at lines 1359-1360 still shows the old `_decodeAndVerifyJws` form, so the implementer has to apply the instruction by hand. **Minor NIT:** rewrite the code block to show the corrected form instead of leaving prose-after-the-fact.

### BUG-2 — Apple root cert placeholder → fail-fast + SPKI hash pinning

**PARTIAL.** The mechanism is right (SPKI SHA-256 pinning, module-load `validateAppleRoots()` throws on placeholder) — but the placement creates a new problem.

`apple-client.ts` line 1212 imports `APPLE_ROOT_CERTS` and runs `validateAppleRoots()` at module load (line 1251). This is correct fail-fast behaviour for production. But the test design has tests at:
- `apps/api/tests/iap/apple-client.test.ts` line 1127 — imports `AppleClient` directly.
- `apps/api/tests/iap/sync-sub.test.ts` — transitively pulls `apple-client.ts` (via `routes/billing-iap.ts` is NOT imported here, but the `import type { AppleClient }` is type-only; OK).
- `apps/api/tests/iap/billing-iap.routes.test.ts` — calls `buildApp` which registers `billingIapRoutes`, and that route file does `import { AppleClient } from "../iap/apple-client.js"` at line 2845 (runtime import).
- `apps/api/tests/iap/billing-iap-webhook.test.ts` — same situation via the webhook route file at line 3241.

Every one of those tests trips `validateAppleRoots()` at import time. Step 4.6c says "This test FAILS on a fresh checkout (placeholder still in place) — by design" — that's fine for the dedicated cert-validation test, but the same throw blocks Tasks 4.5 / 7.5 / 9.1 / 10.1. The plan's stated execution order is "drop in real PEM at install time" — but the plan doesn't make this an explicit Task 4 Step (4.1 installs the SDK, no step says "install the cert + hash"). A subagent following the plan literally will fail Step 4.5 with `Error: APPLE_ROOT_CERTS contains a placeholder` at import time.

**Recommended fix:** add an explicit Step 4.1b "INSTALLER ACTION: drop the real Apple Inc. Root CA G3 PEM into `apps/api/src/iap/apple-roots.ts` and paste its SPKI SHA-256 into the pin set. The openssl pipeline is in the file header." Or: change `validateAppleRoots()` to skip when `NODE_ENV === "test"` AND a test-only override file is present (less clean).

### BUG-3 — Google `_acknowledge` empty subscriptionId → use productId

**FIXED.** `_acknowledge(purchaseToken, productId)` signature now requires productId (line 1684). `acknowledgeIfPending` accepts `{purchaseToken, productId, acknowledgementState}` (line 1731-1739) and passes productId through. Callers (sync-sub.ts line 2476-2480) construct the object correctly with the productId from `v2.productId`. T7.5 test asserts the exact call shape including `productId: "pro_monthly"` (line 2237-2241). ✓

### BUG-4 — Test helpers don't exist

**MOSTLY FIXED.** `buildApp(env, opts?)` is introduced in Task 0 (lines 125-146). The plan's intro (line 35-41) names real helpers (`truncateAll`, `signUpAndGetCookie`, `testEnv`). Test files now live in `apps/api/tests/iap/` (plural). However, see **NEW-1** + **NEW-2** below — the `cd` commands in Steps 2.6 / 3.4 / 3.7 / 4.4 / 4.7 / 5.4 / 6.3 / 7.4 / 7.7 / 8.3 / 8.6 / 9.5 / 10.4 all use `test/iap/...` (singular) which won't match the actual file location `tests/iap/...`. And three test files still call `resetTestDb()` instead of `truncateAll()`.

### BUG-5 — Pino redact target doesn't exist

**FIXED.** Step 0.4 (lines 150-180) edits `server.ts:82` (which is the actual location of the inline `logger:` field) and replaces `{ level: "info" }` with a full object that carries `redact.paths`. The redact path list is comprehensive (covers env keys, JWS / purchaseToken / appAccountToken / receipt). The dangling Step 3.8 (lines 887-911) still shows the old "find Pino init" prose and gives an example wrapping `pino({...})` that doesn't match this codebase's inline form — but Step 0.4 lands the real change first, so Step 3.8 is effectively a no-op. **NIT:** delete Step 3.8 or rewrite it as "verify the redact paths from Step 0.4 cover the env vars added in Step 3.1."

### BUG-6 — `react-native-iap` 15.x removed `requestSubscription`

**FIXED.** Step 11.1 (line 3502) pins `react-native-iap@^14` with explicit rationale. Verified via `npm view react-native-iap@^14`: latest is `14.7.20`. `requestSubscription({sku, appAccountToken, obfuscatedAccountIdAndroid})` is present in 14.x. ✓

### BUG-A — T8 → T9 dependency

**FIXED.** Dependency graph (lines 21-27) now shows `8 → 9` sequentially. `buildMeBody` is explicitly `export async function buildMeBody(userId, runtimeEnv)` in Step 8.4 (line 2630-2633). T9 imports it via dynamic `await import("./billing.js")` (lines 2907, 2948) — that compiles regardless of T8's land order at the type-checker level, but the call signature is consistent across T8 + T9. ✓

### CONSIDER items

- **WebhookEvent.body migration placement:** **FIXED.** Folded into Task 2 Step 2.3 (line 548-556). Single migration.
- **T4.6 / T7.6 / T10.2 step granularity:** **NOT ADDRESSED.** Still ~165 / ~170 / ~200 lines per step. R2 ranked this as NIT, so unchanged status is acceptable.
- **T6.1 verifyApplePayload happy-path test:** **FIXED.** Fake now uses `verifyAndDecodeNotification` returning the flat shape `{notificationUUID, signedTransactionJws, raw, ...}` that the impl reads directly. Assertion `out.notificationUUID === "uuid-1"` lines up with impl's `notificationUUID: n.notificationUUID`. ✓
- **T10.1 retry-cap test:** **FIXED.** P5 rewrote both the impl (split dedup vs counter) and the test (single notificationUUID across retries). Traced: attempts 1-5 each upsert with `attempts={increment:1}` so the row goes 1,2,3,4,5 → `6 > 5` is FALSE for all five (`attempts > MAX_UNKNOWN_RETRIES`), so 500 returned. Attempt 6 increments to 6 → `6 > 5` TRUE → write giveup dedup row + return 200. Attempt 7 finds the giveup row in the dedup check (line 3292) and returns `{ok: true}`. Test expects exactly this sequence (lines 3106-3128). ✓
- **T7.5 acknowledge-ordering test:** **NOT ADDRESSED.** Still asserts `expect(order).toEqual(["ack"])` without recording the upsert event. R2 called this NIT, so unchanged status is acceptable.

---

## 2. Dependency graph + cross-task coupling

P2 introduced `IapRetryCounter` in Task 2 Step 2.3 (lines 534-545), and P5 references it in Task 10 Steps 10.2 (lines 3344-3348, 3429-3433). The model lands in the same migration as `IapDeletedBinding`, so Prisma Client regenerates with both before any Task 10 import. ✓

P3 creates `apple-roots.ts` in Task 4 Step 4.6b (line 1438). Task 4 commit Step 4.8 (line 1521) says:

```
git add apps/api/package.json apps/api/src/iap/apple-client.ts apps/api/src/iap/status-mapping.ts apps/api/tests/iap/apple-client.test.ts apps/api/tests/iap/status-mapping.test.ts
```

**BUG:** `apple-roots.ts` and `apple-roots.test.ts` are missing from the `git add` list. Task 4.6b/4.6c create them, but Step 4.8 doesn't stage them. **Fix:** append `apps/api/src/iap/apple-roots.ts apps/api/tests/iap/apple-roots.test.ts` to the git-add command.

---

## 3. New issues from the patches

### NEW-1 (BUG): Vitest config mismatches for the invented test paths

**API side.** `apps/api/vitest.config.ts:18` has `include: ["tests/**/*.test.ts"]`. The plan creates files at `apps/api/tests/iap/*.test.ts` (correct) but Task 8 (Step 8.1 line 2511) creates `apps/api/test/billing/precedence.test.ts` (singular — wrong directory). That test will never run with the current vitest config.

Run commands also use `test/...` (singular) throughout — e.g. Step 4.7 (line 1514) `npx vitest run test/iap/apple-client.test.ts`. The actual file is at `tests/iap/...`. The run will print `No test files found, exiting with code 1`. Every Task 2–10 verify step has this problem.

**Shared lib side.** `libs/shared/vite.config.ts:22` has `include: ["src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"]`. Existing convention puts tests next to source (e.g. `libs/shared/src/notifications.test.ts`). The plan creates `libs/shared/test/iap/productIds.test.ts` (line 213) — outside `src/`, so vitest won't pick it up.

**Fix options:**
1. **API:** rename Task 8 path to `apps/api/tests/billing/precedence.test.ts`; replace all `test/iap/...` and `test/billing/...` run commands with `tests/iap/...` / `tests/billing/...`. The git-add commands at Steps 2.7, 3.10, 4.8, 5.5, 6.4, 7.8, 8.7, 9.6, 10.5, 14.7 also need the path fix.
2. **Shared:** move tests inline: `libs/shared/src/iap/productIds.test.ts` next to `productIds.ts`, `libs/shared/src/iap/namespace.test.ts`, `libs/shared/src/schemas/iap.test.ts`, `libs/shared/src/iap/binding-parity.test.ts`.

### NEW-2 (BUG): Three test files still call `resetTestDb()`

Despite P1's claim of fixing test imports, these three call sites slipped through:
- Plan line 576: `beforeEach(async () => { await resetTestDb(); });` in `tests/iap/schema.smoke.test.ts` — import is `truncateAll`.
- Plan line 2732: `await resetTestDb();` in `tests/iap/billing-iap.routes.test.ts` — import line is missing entirely (not shown in plan, but the import block at line 2719-2725 doesn't pull anything that exposes `resetTestDb`).
- Plan line 3017: `await resetTestDb();` in `tests/iap/billing-iap-webhook.test.ts` — same shape.

`resetTestDb` is not defined or imported anywhere; ReferenceError at first hook invocation. Replace all three calls with `await truncateAll()`.

The route test files also reference `testEnv` (line 2734, 3019) but don't import it. Need an `import { testEnv } from "../helpers/test-env.js";` line in both files.

### NEW-3 (NIT): Self-referential typo in test-infra blurb

Plan line 37: "All tests live in `apps/api/tests/iap/` (NOT `apps/api/tests/iap/`)." Both paths are identical. The parenthetical was clearly meant to forbid the `apps/api/test/iap/` (singular) form. Fix the typo.

### NEW-4 (NIT): Step 4.7 / Step 4.8 don't include the new apple-roots files

Step 4.7 line 1514 only runs `test/iap/apple-client.test.ts`, not `test/iap/apple-roots.test.ts` introduced in 4.6c. Step 4.8 commit list (line 1521) doesn't stage `apple-roots.ts` or `apple-roots.test.ts`. Both need updating.

### NEW-5 (NIT): Step 3.8 is stale

Step 3.8 (lines 887-911) is now redundant — Pino redact was wired in Step 0.4 (lines 150-180). The Step 3.8 prose ("Locate the Pino logger init (search: `pino(` or `import pino`).") will send the implementer hunting for code that doesn't match the codebase's inline-config form. Delete Step 3.8 or replace it with "Confirm Step 0.4's redact paths cover the env vars added in Step 3.1; if not, extend the redact.paths array in `server.ts`."

### NEW-6 (NIT): Restore screen doesn't surface user-cancel — but it doesn't need to

Step 12.2 restore screen doesn't import or handle `IapPurchaseError`. That's correct — Restore calls `listAvailablePurchases()` + `postIAPRestore()`, never `purchaseSubscription()`, so `E_USER_CANCELLED` never surfaces here. No action needed.

---

## 4. Test correctness recheck

### Retry-cap trace (P5)

Walking the impl + test (Step 10.1 lines 3093-3128, impl lines 3339-3360):

| Attempt | Counter before | upsert result | counter > 5? | Response |
|---|---|---|---|---|
| 1 | row absent | create attempts=1 | 1 > 5 = false | 500 |
| 2 | attempts=1 | update → 2 | false | 500 |
| 3 | attempts=2 | update → 3 | false | 500 |
| 4 | attempts=3 | update → 4 | false | 500 |
| 5 | attempts=4 | update → 5 | false | 500 |
| 6 | attempts=5 | update → 6 | 6 > 5 = true | write giveup dedup row, 200 |
| 7 | (dedup hit on eventId) | — | — | 200 (dedup short-circuit at line 3292) |

Test asserts: loop 0..4 (5 iterations) returns 500, attempt 6 returns 200 + forensic row, attempt 7 returns 200. Matches. ✓

### verifyApplePayload happy path

Impl (line 1924-1937) reads `notification.notificationUUID` directly from the mocked `verifyAndDecodeNotification` return value. Test mock returns `{ notificationUUID: "uuid-1", notificationType: "DID_RENEW", signedTransactionJws: "tx-jws", raw: {} }`. Impl returns `{ notificationUUID: n.notificationUUID, notificationType: n.notificationType, ... signedTransactionJws: n.signedTransactionJws, raw: n.raw }`. Assertions `out.notificationUUID === "uuid-1"` + `out.signedTransactionJws === "tx-jws"` pass. ✓

---

## 5. Internal consistency

- **`unattributable_retry` cleanup:** No `unattributable_retry` references remain in the plan. P5 moved retry-count tracking from `WebhookEvent` to `IapRetryCounter`. ✓
- **`Subscription.environment` on create + update:** sync-sub.ts Apple branch (lines 2392, 2399) sets `environment: verified.environment` on create AND on update. Google branch (lines 2432, 2458, 2465) sets it on the linkedPurchaseToken rewrite AND the create AND the update. ✓
- **Revision history block:** Lines 4373-4381 list P1-P8 commits in order. No stray references to old step numbers (e.g. "Step 10.3 register plugin" is now correctly Step 10.3 — register plugin remained step 10.3 because Task 10 added a new 10.2 implementation step but the impl was already 10.2 in the original). ✓
- **`IapDeletedBinding.userIdHash`:** Task 14 now writes `userIdHash` (line 4241) — R2 flagged that the column was never populated. **FIXED.**

---

## 6. P-commit-specific verifications

### P1 (Task 0 buildApp injection)

Step 0.3 (line 138-145) modifies `buildApp` to accept `opts.iap` and decorates `(app as any).fina.iap = opts.iap`. The test in Step 0.1 (line 63-76) asserts `(app as any).fina.iap === mocks` when opts.iap is passed AND `(app as any).fina.iap === undefined` when not. Implementation matches the assertions. ✓

### P3 (Apple roots SPKI pinning + lazy concern)

See **BUG-2 PARTIAL** above. Mechanism correct, placement creates a cascading test failure unless the implementer installs the real PEM before running ANY of Tasks 4-12 tests. Plan needs an explicit installer-action step.

### P4 (Google acknowledge signature)

All callers (sync-sub.ts line 2476-2480) and test (T7.5 line 2237-2241) use the new shape `{purchaseToken, productId, acknowledgementState}`. There are no webhook handlers that call `acknowledgeIfPending` directly — the webhook delegates to `syncSubscriptionFromIAP`, which uses the new shape. ✓

### P5 (retry-counter Prisma `lastAt` field)

Schema (line 541): `lastAt DateTime @default(now())`. Update path (line 3347, 3432): `update: { attempts: { increment: 1 }, lastAt: new Date() }`. `@default(now())` only fires on insert; the update path explicitly sets `lastAt: new Date()`, so the value flows through. No `@updatedAt` needed (that's only when you want auto-update without specifying). ✓

### P6 (filterEnvironmentRows type narrowing)

`filterEnvironmentRows<T extends {environment: string}>` (line 2605-2611). `pickPrimarySub<T extends Sub>` still needs `source/tier/createdAt/environment/sourceSubscriptionId`. Callers in `buildMeBody` (Step 8.4 lines 2647-2648):
- `filterEnvironmentRows(activeSubs, runtimeEnv)` — `activeSubs` is a Prisma `Subscription[]` row, has all required fields incl. environment. T narrows to `Subscription`. ✓
- `pickPrimarySub(filtered)` — `filtered` is `Subscription[]`, conforms to the wider `Sub` constraint. ✓

In `effectiveTier` (Step 8.5 line 2683): `select: { tier: true, environment: true }` — `activeSubs` is now typed `{tier; environment}[]`. `filterEnvironmentRows` accepts this (only needs environment). `computeEffectiveTier(user, filtered)` — the existing helper takes subs with at minimum `tier`. ✓ No type errors.

### P7 (react-native-iap@^14 + IapPurchaseError)

`react-native-iap@14.7.20` is latest in the 14.x line (verified via npm). `requestSubscription` exists with `sku`, `appAccountToken`, `obfuscatedAccountIdAndroid` — all present. ✓ Top-level `import { sha256 } from "js-sha256"` (line 3560) fixes the require-in-Hermes issue. ✓ `IapPurchaseError` is exported from `client.ts` (line 3695-3699) and imported in `app/plan/index.tsx` (line 3847). Restore screen doesn't import it but doesn't need to (see NEW-6). ✓

### P8 (Task 14 tombstone helper + Prisma composite key)

`prisma.iapDeletedBinding.upsert` (line 4239-4243) uses `where: { source_tokenHash: { source, tokenHash } }`. Schema (line 522) has `@@unique([source, tokenHash])` → Prisma generates composite key `source_tokenHash`. Matches Prisma's naming convention. ✓ `userIdHash` is now passed on create. Idempotency via `update: {}` is valid Prisma syntax. ✓

---

## 7. Practical execution risk recheck

Re-ranking what trips the first subagent now (assuming the implementer drops in the real Apple PEM at install time before Task 4 — otherwise that's #1):

1. **NEW-1 (test paths)** — Step 2.6 runs `npx vitest run test/iap/schema.smoke.test.ts`. The vitest config matches `tests/**/*.test.ts` but this command says `test/...` (singular). Vitest exits with "no test files found". First fail.
2. **NEW-2 (resetTestDb call)** — even if the path is right, Step 2.5 / 9.1 / 10.1 fail with `ReferenceError: resetTestDb is not defined`.
3. **NEW-1 (shared tests)** — Step 1.2 runs `npx vitest run test/iap/productIds.test.ts` in `libs/shared`. Shared vitest config only matches `src/**/*.test.ts`. No tests found, even before resetTestDb hits.
4. **BUG-2 PARTIAL (apple roots placeholder)** — if the implementer doesn't install the real PEM before Step 4.5, Tasks 4.5 / 7.5 / 9.1 / 10.1 all import `apple-client.ts` (directly or via routes) and trigger `validateAppleRoots()` → throws at module load → test runner aborts.
5. **NEW-4 (Step 4.8 missing apple-roots files in git add)** — minor; implementer notices on the next `git status`.

If items 1-3 are patched, items 4+ become real "does the code work" questions, not infrastructure stalls.

---

## 8. Severity tally (new findings only)

| Severity | Count | Items |
|---|---|---|
| BUG | 3 | NEW-1 (vitest path mismatch), NEW-2 (resetTestDb call survives in 3 files), BUG-2 PARTIAL (apple roots tests cascade-fail) |
| NIT | 4 | NEW-3 (typo in test-infra blurb), NEW-4 (apple-roots not in git add), NEW-5 (stale Step 3.8), Step 4.6 prose vs code block divergence on `getSubscriptionStatus` |

---

## Verdict

**APPROVE WITH CHANGES.**

The R2 must-fix list is closed cleanly on the substance. The remaining problems are mechanical patches that fit on one page of edits:

1. **NEW-1:** rename `test/...` → `tests/...` throughout the plan run-commands and git-add lists (find/replace in API task sections); move shared tests inline next to `src/iap/`, `src/schemas/iap.ts`, etc.
2. **NEW-2:** replace 3 occurrences of `await resetTestDb()` with `await truncateAll()`; add the missing `testEnv` + `truncateAll` imports in the two route test files.
3. **BUG-2 PARTIAL:** add an explicit Step 4.1b "Install the real Apple Inc. Root CA G3 PEM into `apple-roots.ts` and paste its SPKI SHA-256 into `EXPECTED_APPLE_ROOT_SPKI_SHA256`. Run `npx vitest run tests/iap/apple-roots.test.ts` to confirm." This step gates every downstream test that imports the routes.
4. **NEW-3 / NEW-4 / NEW-5:** typo fix; add `apple-roots.ts` / `apple-roots.test.ts` to Step 4.8's `git add`; delete the dead Step 3.8.
5. Rewrite Step 4.6's `getSubscriptionStatus` code block to use the dedicated decoders directly (currently the post-block prose says "also update" — easier to give the corrected block).

None of these touch design — they're all paperwork. Once applied, the plan executes cleanly.

**Spec coverage:** unchanged from R2 — fully covered.

**Code-block correctness:** Apple + Google SDK usage is now right (BUG-1 fixed, BUG-3 clarified, BUG-2 mechanism right). `react-native-iap` is correctly pinned.

**Decomposition:** unchanged from R2 — three large steps still flagged as NIT.
