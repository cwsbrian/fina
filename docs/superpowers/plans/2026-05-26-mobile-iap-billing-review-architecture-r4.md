# Plan review — Mobile IAP Billing (architecture R4)

**Plan under review:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md` (HEAD `158669a`)
**Prior reviews:** R1 → R2 → R3 (`…-mobile-iap-billing-review-architecture-r3.md`)
**Patch commits inspected:** `8fc2230` (P9) → `5c68280` (P10) → `0d41e33` (P11) → `158669a` (P11b)
**Reviewer role:** Round-4 verifier — confirm R3 must-fixes closed, surface regressions from P9-P11b
**Date:** 2026-05-26

---

## TL;DR

P9-P11b close 5 of the 8 R3 must-fix items cleanly (NEW-2, NEW-3, NEW-4, NEW-5, N3.2, N3.5). NEW-1 (vitest path consistency) is **PARTIAL** — the API side is now right, but two run-commands inside Task 1 still target `tests/iap/...` for files that actually live at `libs/shared/src/iap/...`, AND one command at line 423 still uses the old singular `test/schemas/iap.test.ts`. N3.3 (redact list divergence) is FIXED. N3.4 (mobile parity placeholders) is FIXED — but it introduced a new exposure: **the mobile parity test file imports `node:crypto`, and `apps/mobile/` has no Vitest configuration at all** (no `vitest.config.ts`, no `"test"` script in `package.json`, project.json defines only `typecheck`). The Step 11.5b run command `cd apps/mobile && npx vitest run …` will fail at the no-config stage long before crypto-import time.

The Apple roots placeholder (R3 BUG-2 PARTIAL) is now correctly framed by P11b as an explicit installer gate — the self-review's "fail by design" framing matches the test code: the test checks for `<<<` AND `INSTALLER` markers, both of which the placeholder file contains, so the test fails until the installer drops in the real PEM. This is the desired behaviour for forcing installer action.

Two genuinely new findings:

- **NEW-6 (BUG):** No `apps/mobile/vitest.config.ts` exists and `apps/mobile/package.json` has no `vitest` dev-dep, no `"test"` script. Steps 11.5 + 11.5b's `cd apps/mobile && npx vitest run …` commands will exit with "no vitest binary" / "no config" before the test file is even parsed. Task 11 needs an explicit "add mobile vitest config" step OR move the parity test into `libs/shared` only (which already has a working config).
- **NEW-7 (NIT):** Task 1's three `npx vitest run …` commands at lines 242, 281, 320 use `tests/iap/...` (plural) but the files now live at `libs/shared/src/iap/...` (P9's correct change to file paths). The commands should be `src/iap/productIds.test.ts` etc. Line 423 still uses singular `test/schemas/iap.test.ts` — P9 missed this one.

Verdict: **APPROVE WITH CHANGES** — three mechanical patches.

---

## 1. R3 must-fix verification

### NEW-1 — Vitest paths consistent

**PARTIAL.**

API side (R3's main complaint): **FIXED.** Every API-side run command and git-add list now uses `tests/iap/...` (plural) — verified line 186 (`tests/iap/buildApp-iap.test.ts`), 623 (`tests/iap/schema.smoke.test.ts`), 718, 884, 1095, 1498, 1730, 1996, 2077, 2471, 2960, 3459, 4333. Task 8's `tests/billing/precedence.test.ts` is also right (line 2601). The Task 0 line-37 self-reference is also fixed (see NEW-3 below).

Shared lib side: **PARTIAL.** P9 moved the files to the colocated path `libs/shared/src/iap/productIds.test.ts` (matches `notifications.test.ts` existing pattern + matches `vite.config.ts:21` `include: ["src/**/*.{test,spec}…"]`). The Task 1 "**Files:**" block at lines 207-209 lists the correct paths. The git-add at line 463 stages `libs/shared/src/iap` (the directory — picks up everything). BUT:

| Line | Command | Problem |
|---|---|---|
| 242 | `cd libs/shared && npx vitest run tests/iap/productIds.test.ts` | File is at `src/iap/productIds.test.ts`, not `tests/iap/…`. Vitest config includes only `src/**/*.{test,spec}.*` |
| 281 | `npx vitest run tests/iap/productIds.test.ts` | Same |
| 320 | `npx vitest run tests/iap/namespace.test.ts` | Same |
| 423 | `npx vitest run test/schemas/iap.test.ts` | Singular `test/` AND outside `src/`; should be `src/schemas/iap.test.ts` |

The vitest binary would resolve via `npx`, then exit with "No test files found" on each.

**Fix:** rewrite the four commands to `npx vitest run src/iap/productIds.test.ts` (and equivalents). Quick sed-style replacement.

### NEW-2 — All `resetTestDb()` call sites replaced

**FIXED.** `grep -n "resetTestDb" plan.md` returns only the P9 revision-history line at 4386 — no live call sites remain. Verified: line 577 (`schema.smoke.test.ts`) → `await truncateAll();`; line 2106-2107 (`sync-sub.test.ts`) → `await truncateAll();`; line 2715-2716 (`billing-iap.routes.test.ts`) → `await truncateAll();`; line 3001 (`billing-iap-webhook.test.ts`) → `await truncateAll();`; line 4162 (`account-deletion.test.ts`) → `await truncateAll();`. All consistent with `import { truncateAll } from "../helpers/db.js"`.

The R3 "missing `testEnv` import" follow-up is also fixed: line 2707 imports `testEnv` in routes test, line 3003 uses `testEnv()` in webhook test (the webhook test file's imports aren't shown in the plan, but the constructed call site presumes `testEnv()` is imported — small omission noted; the plan's intent is that the implementer adds the standard import from `../helpers/test-env.js`, which is the convention stated at line 42).

### NEW-3 — Line 37 self-defeating typo fixed

**FIXED.** Line 37 now reads: `All tests live in apps/api/tests/iap/ (plural tests, matches apps/api/vitest.config.ts include: ["tests/**/*.test.ts"]).` — explanatory parenthetical replaces the broken `(NOT apps/api/tests/iap/)` self-reference.

### NEW-4 — Step 4.8 git-add includes apple-roots files

**FIXED.** Line 1505 stages all three apple-roots-related paths plus the existing apple-client paths:

```
git add apps/api/package.json apps/api/src/iap/apple-client.ts apps/api/src/iap/status-mapping.ts apps/api/src/iap/apple-roots.ts apps/api/tests/iap/apple-client.test.ts apps/api/tests/iap/status-mapping.test.ts apps/api/tests/iap/apple-roots.test.ts
```

Both `apple-roots.ts` and `apple-roots.test.ts` are present.

### NEW-5 — Dead Step 3.8 redact block removed

**FIXED.** Line 887-895 now reads:

```
- [ ] **Step 3.8: Run full API test suite (smoke)**

Pino redact paths are already wired in Step 0.4 (Task 0). No additional logger configuration needed here.

cd apps/api && npx vitest run
Expected: zero new failures (pre-existing tests untouched).
```

The dead "find Pino init / `import pino`" prose is gone. Step 3.8 is now a smoke-run step with a one-line cross-reference to Step 0.4.

### N3.2 — `getSubscriptionStatus` uses dedicated decoders

**FIXED.** Lines 1343-1344:

```ts
const verifiedTx = await this.verifyAndDecodeTransaction(item.signedTransactionInfo, { context: "asc-api" });
const renewal = await this.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
```

Both `_decodeAndVerifyJws` calls (the issue R3 flagged) are replaced with the public dedicated decoders. The companion comment (lines 1335-1342) explains why the dedicated decoders matter ("DO NOT use `_decodeAndVerifyJws` — that's the generic JWS seam used only by the public verifier methods").

This also closes the R3 prose-vs-code-block divergence noted as a NIT.

### N3.3 — Redact list divergence

**FIXED.** Only one redact list exists in the plan (Step 0.4, lines 161-178) — list covers env keys (`APPLE_ASC_PRIVATE_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`), wildcard env (`*.APPLE_ASC_PRIVATE_KEY`, etc.), service-account `private_key`, and PII fields (`*.purchaseToken`, `*.signedTransactionInfo`, `*.signedRenewalInfo`, `*.signedPayload`, `*.appAccountToken`, `*.receipt`, `*.jwsRepresentation`, `*.body.appAccountToken`, `*.body.obf`). There's no competing list in Task 3.

### N3.4 — Mobile parity test placeholders replaced

**FIXED on the textual front.** Step 11.5b lines 3601-3613 now computes the expected values inline using the same primitives the server uses:

```ts
const FIXTURE_USER_ID = "fixture-user-id";
const EXPECTED_APPLE = uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE);
const EXPECTED_GOOGLE = createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex");
```

No literal-pinned hex strings remain. The accompanying note at lines 3625-3629 explains "mobile test runs under Vitest's Node environment (not the React Native runtime), so `node:crypto` is available" — but see **NEW-6 (BUG)** below for the broken assumption.

### N3.5 — `writeAccountDeletionTombstones` in `prisma.$transaction([batch])`

**FIXED.** Lines 4240-4248:

```ts
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

This is the **batch-promise** form of `$transaction` — Prisma's array signature accepts `PrismaPromise<T>[]` (which `prisma.iapDeletedBinding.upsert(...)` returns; calling a Prisma delegate method returns a deferred PrismaPromise, not a fired-and-awaited promise, so this batches correctly). Atomic across both upserts at SQL level. ✓

---

## 2. New issues introduced by P9-P11b

### NEW-6 (BUG): `apps/mobile/` has no Vitest setup

**Symptom path:** Steps 11.5 + 11.5b — first runnable mobile test in the plan.

Step 11.5 (line 3559): `cd apps/mobile && npx vitest run src/iap/__tests__/binding.test.ts`
Step 11.5b (line 3634): `cd apps/mobile && npx vitest run src/iap/__tests__/binding-parity.test.ts`

**Observed in repo:**
- `find apps/mobile -name "vitest*"` returns nothing.
- `apps/mobile/package.json` has NO `vitest` dev-dep, NO `"test"` script, and the only test-related deps are `@testing-library/jest-native` + `@testing-library/react-native` (which suggests Jest was originally planned, not Vitest).
- `apps/mobile/tsconfig.spec.json` references `jest.config.ts` and `"types": ["jest", "node"]` — i.e., the project was scaffolded for Jest, never wired.
- `apps/mobile/project.json` defines only a `typecheck` target.

**What happens at execution time:** `npx vitest` will either (a) bootstrap a brand-new Vitest install at the workspace root (likely, since the monorepo has Vitest installed elsewhere), then exit complaining about no config + no test discovery — OR (b) prompt the user to install Vitest. Either way the test never runs. The `node:crypto` parity check inside the file (line 3602) never gets a chance to fail / pass.

**Why the plan's own note doesn't save it:** the note at lines 3625-3629 ("mobile test runs under Vitest's Node environment") presupposes a Vitest config exists. It doesn't.

**Fix options:**

1. **Add an explicit step 11.0** ("create `apps/mobile/vitest.config.ts` with `environment: 'node'`, `include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts']`, plus add `vitest` dev-dep + `"test": "vitest"` script to `apps/mobile/package.json`"). The parity test only needs `node:crypto`, so `environment: 'node'` is correct — no jsdom/jest-environment-react-native gymnastics required.
2. **Delete the mobile-side parity test** and rely on the shared-lib parity test (Step 11.5b libs/shared half) as the single source of truth. Drawback: doesn't catch a divergence where `js-sha256` (Hermes) differs from `node:crypto` for the same UTF-8 input — but `js-sha256` is pure-JS and well-tested, so this is acceptable.
3. **Move the parity check inside the existing binding test** (Step 11.5) and skip the Node `createHash` import — assert deterministic equality only (`expect(deriveAppleToken("x")).toBe("…fixed-hex…")`). Less rigorous but works without any vitest config.

Recommended: option 1, which is also cheap and reusable for any future mobile unit test.

### NEW-7 (NIT): Task 1 vitest run commands point at wrong path

**Symptom path:** Step 1.2 + 1.4 + 1.7 + 1.10 — the four `npx vitest run` commands inside Task 1.

| Line | Current | Should be |
|---|---|---|
| 242 | `cd libs/shared && npx vitest run tests/iap/productIds.test.ts` | `… src/iap/productIds.test.ts` |
| 281 | `npx vitest run tests/iap/productIds.test.ts` | `npx vitest run src/iap/productIds.test.ts` |
| 320 | `npx vitest run tests/iap/namespace.test.ts` | `npx vitest run src/iap/namespace.test.ts` |
| 423 | `npx vitest run test/schemas/iap.test.ts` | `npx vitest run src/schemas/iap.test.ts` |

P9 correctly moved the file definitions to `src/iap/` (matching `notifications.test.ts`) AND correctly fixed `libs/shared/src/index.ts` re-exports + git-add lines AND the Task 1 "Files:" block. But the run-commands inside the same task still reflect the pre-P9 placement. Vitest's `include: ["src/**/*.{test,spec}.*"]` (vite.config.ts:21) won't match `tests/iap/...` or `test/schemas/...` → "No test files found" exit.

**Fix:** sed `tests/iap/` → `src/iap/` in those three commands and `test/schemas/` → `src/schemas/` in line 423.

### P10 getSubscriptionStatus recursive call — circular / mock concerns (not a bug)

P10 (line 1343) changed `getSubscriptionStatus` to call `this.verifyAndDecodeTransaction(item.signedTransactionInfo, { context: "asc-api" })` recursively — same instance, public method.

**Class init.** The recursion is method-level not import-level; no circular-init concern. The `verifier` and `asc` fields are already constructed before `getSubscriptionStatus` runs.

**Test mocks.** The Step 4.5 tests (line 1133, 1141, 1148, 1155, 1162, 1169) mock the protected `_decodeAndVerifyJws` seam via `vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(...)`. The new path through `getSubscriptionStatus` calls `verifyAndDecodeTransaction` publicly, which internally calls `_decodeAndVerifyJws`. So the mock still catches it. Trace: `getSubscriptionStatus` (real) → `this.verifyAndDecodeTransaction` (real) → `this._decodeAndVerifyJws` (mocked) → returns the canned TX. ✓ The existing Step 4.5 tests don't exercise `getSubscriptionStatus`, so the recursion isn't tested there — `getSubscriptionStatus` is exercised in the webhook tests (Step 10.1) where the **whole AppleClient is replaced by a fake object** with `verifyAndDecodeTransaction`, `verifyAndDecodeNotification`, `verifyAndDecodeRenewalInfo`, `getSubscriptionStatus` all `vi.fn()`-d (lines 2992-2996). So the production recursion path is never exercised in tests — but that's a coverage gap that exists in R1-R3 too; not a P10 regression.

No new finding.

### P10 transaction batch syntax

`prisma.$transaction([prisma.iapDeletedBinding.upsert(...), prisma.iapDeletedBinding.upsert(...)])` is the correct Prisma batch-transaction form. Each `prisma.model.upsert(args)` returns a `PrismaPromise<T>` (Prisma's deferred-thenable). Confirmed via Prisma's own docs and current behaviour in this repo. ✓

### P11 sandbox-smoke Gate 3 wording

Gate 3 (line 4111) now reads:

> Within 5 minutes: API calls `purchases.subscriptions.acknowledge(packageName, subscriptionId=productId, token)` for the new sub. Verify by directly re-fetching the purchase via `purchases.subscriptionsv2.get` (gcloud CLI or googleapis quickstart) and confirming `acknowledgementState === ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`.

Method separation is now correct: **ack uses v1** (`purchases.subscriptions.acknowledge`), **verification uses v2** (`purchases.subscriptionsv2.get`). This mirrors `google-client.ts` (Task 5 Step 5.3) which uses `subscriptionsv2.get` for the fetch path and `subscriptions.acknowledge` for the ack path (no v2 acknowledge endpoint exists as of `googleapis@^140`). ✓

### P11b self-review note vs the actual test (apple-roots placeholder)

Lines 4366: claims `apple-roots.test.ts` fails on a fresh checkout because the placeholder file contains placeholder markers.

Tracing the test (lines 1473-1480):

```ts
it("contains no placeholder markers", () => {
  for (const pem of APPLE_ROOT_CERTS) {
    const s = pem.toString("utf8");
    expect(s).not.toMatch(/<<</);
    expect(s).not.toMatch(/INSTALLER/);
  }
});
```

And the placeholder file (lines 1441-1448):

```ts
Buffer.from(
  `-----BEGIN CERTIFICATE-----
<<INSTALLER: paste the real Apple Inc. Root CA G3 PEM here. Module-load
 validation will throw "APPLE_ROOT_CERTS contains a placeholder" until
 this is done — that's intentional.>>
-----END CERTIFICATE-----
`,
  "utf8",
),
```

The string contains both `<<` (matches `/<<</`) AND `INSTALLER` (matches `/INSTALLER/`). Both expectations fail → test fails by design. ✓ Matches P11b's claim.

The companion `EXPECTED_APPLE_ROOT_SPKI_SHA256` constant (lines 1456-1460) is `["<INSTALLER_FILL_64_HEX_CHARS>"]` — the second test (line 1482, "every cert parses as X.509 and its SPKI SHA-256 is in the expected pin set") would also throw on `new X509Certificate(pem)` against the non-PEM placeholder text, but that's masked by the placeholder-marker test failing first. Either way, the test suite fails as expected until an installer drops in the real PEM + hash. ✓

**Operational consideration (NIT, not a regression):** the plan doesn't say where Task 4.6b's placeholder gets converted to real PEM in the *executable* task list. Step 4.1 installs the SDK; Step 4.6b creates the placeholder file; Step 4.6c writes the test. There's no Step 4.1b "drop in the real cert" that R3 recommended. This was R3's BUG-2 PARTIAL recommendation; the author chose to leave the gate enforced by the test rather than add an installer step. That's a defensible call — the test failure halts execution at Step 4.7, the implementer cannot proceed without the real cert. Mentioning this is informational only; the design works.

---

## 3. Internal consistency check (post P9-P11b)

### Task numbering

Task list is 0-14 (15 tasks). Dependency graph (lines 16-33) lists 0 → 1 → 2 → 3 → {4,5,6} → 7 → 8 → {9,10} → 11 → 12 → 13 → 14 — consistent. Self-review at lines 4348-4364 references every task by number; spot-checked tasks 4, 5, 6, 7, 8, 9, 10, 11, 12 — all present and numbered correctly.

### Step numbering inside Task 3

Steps go 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8 (now a smoke-run, P11 rewrite), 3.9. No step references the dead Step 3.8 redact block anywhere else in the plan — verified via grep. The R3 NEW-5 fix is internally consistent.

### Step numbering inside Task 4

Steps 4.1, 4.2, 4.3, 4.4, 4.5, 4.6 (impl), 4.6b (apple-roots.ts), 4.6c (apple-roots test), 4.7 (apple-client test run), 4.8 (commit). No gaps. Self-review at line 4366 references "Task 4 Step 4.6b" — exists at line 1420. ✓

### Revision history hash spot-check

Lines 4378-4388 list P1 → P11.

| Tag | Plan hash | git-log hash (90676b4..HEAD) | Match |
|---|---|---|---|
| P9 | `8fc2230` | `8fc2230` | ✓ |
| P10 | `5c68280` | `5c68280` | ✓ |
| P11 | "This commit" | `0d41e33` | implicit ✓ (P11 is the commit that wrote the line "This commit — P11") |
| P11b | not listed in revision history | `158669a` | — the revision history doesn't include P11b yet |

**NIT:** the revision history at the plan footer stops at P11 ("This commit"). P11b (`158669a`) refreshed the self-review placeholder note but did NOT extend the revision history block. Cosmetic — append a P11b line.

### Self-review block

Lines 4348-4364 cover spec §3, §4, §5.1, §5.2, §5.3, §5.4, §6, §7, §8, §10, §11, §12, §12.1, §12.2, §12.3. §1 (goal), §2 (architecture), §9 (pricing parity), §13 (open decisions), §14 (plan slice preview) not enumerated — acceptable, those are non-requirement sections. §12.1 (account deletion + retention) is covered by Task 14. §12.2 (account merge) is documented in the spec as "manual support v1, no code task" — self-review at line 4363 correctly says "documented in spec, no code task (manual support v1)". ✓

---

## 4. Spec coverage final pass

Walking §1-§14 of the spec one more time:

- **§1 Goal:** Tasks 9-12 — end-to-end mobile → API → webhook → MeDTO loop. ✓
- **§2 Architecture:** dependency graph + Task list matches the one-paragraph description. ✓
- **§3 Shared library touchpoints:** Task 1 (productIds + namespace + schemas + errors append). ✓
- **§3 Schema additions:** Task 2 (User.iap*, Subscription.environment, IapDeletedBinding, IapRetryCounter, WebhookEvent.body). ✓
- **§4 Mobile library + config:** Task 11. ✓
- **§5.1 Env vars + boot validation:** Task 3 (env-guard.ts + redactEnv.ts + 503 guard). ✓
- **§5.2 Modules:** apple-client.ts (Task 4), google-client.ts (Task 5), webhook-verify.ts (Task 6), sync-sub.ts (Task 7), precedence.ts (Task 8). ✓
- **§5.3 Routes + 4-step resolution:** Task 9 (checkout/restore) + Task 10 (webhook ladders). ✓
- **§5.4 Status mapping:** status-mapping.ts (Task 4 Step 4.3) — covers all Apple states + Google states. ✓
- **§6 Apple-specific contract:** 6 checks in apple-client (Task 4); Family Sharing → canceled (Task 10 Step 10.2 lines 3282-3293); ASC roundtrip (Task 4 `getSubscriptionStatus`). ✓
- **§7 Google-specific contract:** v2 fetch + acknowledge + linkedPurchaseToken chain (Tasks 5 + 7). ✓
- **§8 Cross-source guard:** Stripe-always-wins in `pickPrimarySub` (Task 8 line 2571); sandbox env filter in `filterEnvironmentRows` (Task 8 lines 2589-2595) applied to buildMeBody + effectiveTier (Task 8 Steps 8.4 + 8.5). ✓
- **§9 Pricing parity:** SKU constants in Task 1 (productIds.ts) — same IDs Apple + Google. ✓ (No separate code task needed.)
- **§10 Testing strategy:** every code task ships its tests in the same Task body. ✓
- **§11 Operational setup:** Task 13 manual smoke gates 1-4; deferred-to-humans setup matches spec. ✓
- **§12 OOS items:** Annual plans / Family Sharing / promo codes / StoreKit 1 — not implemented. ✓
- **§12.1 Account deletion + retention:** Task 14 ships `writeAccountDeletionTombstones` helper + runbook. Schema columns ready (Task 2). When deletion flow is built, the runbook tells it what to do. ✓
- **§12.2 Account merge:** spec explicitly out-of-scope for v1; self-review line 4363 acknowledges. No code task. ✓
- **§12.3 Webhook trust chain:** Task 10 Step 10.2 line 3349-3352 omits `expectedAppAccountToken` on the webhook path, matching §12.3's design (binding pre-verified at checkout). ✓

Spec coverage is **complete**. Nothing new missed by P9-P11b.

---

## 5. Practical execution risk recheck — what trips the first subagent

Ranking what breaks the executing subagent now (R3's was: NEW-1 path > NEW-2 resetTestDb > shared-tests path > apple roots placeholder).

After P9-P11b:

1. **NEW-7 (Task 1.2 — line 242)** — first thing run after Task 0. `cd libs/shared && npx vitest run tests/iap/productIds.test.ts` → "No test files found" exit. Stops the run. **First fail.**
2. **NEW-7 (line 423)** — `npx vitest run test/schemas/iap.test.ts` — second fail in Task 1.
3. **NEW-6 (Task 11.5 — line 3559)** — `cd apps/mobile && npx vitest run …` — there's no vitest config or binary in apps/mobile. Fails on entering Task 11.
4. **Apple roots placeholder gate** — Step 4.7 fails until the installer drops in the real PEM. R3 framed this as a PARTIAL because there's no explicit "install the PEM" step. After P11/P11b, the plan's self-review at line 4366 makes this an explicit gate by design, which is defensible — but the subagent will literally hit this and need to escalate.

#3 (mobile vitest) is genuinely new (P11 introduced the second mobile test file in Step 11.5b, but the same issue applied to Step 11.5's original binding test — pre-existing). #1 and #2 are P9 residue.

Items 1, 2, 4 are first-line obstacles. Item 3 is gated by Tasks 1-10 landing first.

---

## 6. Severity tally (new findings only)

| Severity | Count | Items |
|---|---|---|
| BUG | 1 | NEW-6 (mobile has no Vitest config) |
| NIT | 2 | NEW-7 (Task 1 vitest paths), revision-history missing P11b line |

R3 BUG-2 PARTIAL (apple roots gate) intentionally NOT counted as a new finding — the author's chosen design (test-fails-by-design) is defensible and the test wiring is correct.

---

## Verdict

**APPROVE WITH CHANGES.**

R3 must-fixes closed cleanly on the substance:
- NEW-1: API side **FIXED**; shared lib side **PARTIAL** (4 lines need a path fix).
- NEW-2, NEW-3, NEW-4, NEW-5: **FIXED**.
- N3.2, N3.3, N3.5: **FIXED**.
- N3.4: textually **FIXED** but execution exposed a deeper gap — **NEW-6**.

Three small fixes from a clean state:

1. **NEW-6:** add Step 11.0 to wire mobile Vitest (config + dev-dep + `"test"` script), OR move the parity test entirely into `libs/shared` and delete the mobile-side mirror.
2. **NEW-7:** rewrite four lines (242, 281, 320, 423) so the shared-lib vitest commands use `src/iap/...` / `src/schemas/...` instead of `tests/iap/...` / `test/schemas/...`.
3. **Revision-history NIT:** append a P11b entry to lines 4376-4388 ("`158669a` — P11b — refresh self-review placeholder note for apple-roots.ts gate").

None touch design — paperwork patches. Once applied, the plan executes cleanly through Task 0, Task 1, ..., into Task 4 where the installer hits the apple-roots gate (which is the intended behaviour).

**Spec coverage:** complete.

**Code-block correctness:** Apple + Google SDK usage right; dedicated decoders correctly wired; transaction batching is the correct Prisma form; redact list is comprehensive and de-duplicated; mobile parity test computes expected values inline.

**Decomposition:** unchanged from R3 — Tasks 4, 7, 10 still ship as ~165-200 line steps. Acceptable NIT, decoupled from the must-fix list.
