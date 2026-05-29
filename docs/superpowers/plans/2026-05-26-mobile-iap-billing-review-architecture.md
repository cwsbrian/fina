# Plan review — Mobile IAP Billing (architecture)

**Plan under review:** `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md`
**Spec (source of truth):** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
**Spec R2 reviews:** architecture-r2 + security-r2 (both APPROVE WITH CHANGES)
**Reviewer role:** Plan/architecture reviewer — does the plan correctly implement the spec, are tasks well-decomposed, do the code blocks compile against the real codebase + real third-party libraries
**Date:** 2026-05-26

---

## TL;DR

The plan is structurally sound — 13 tasks, dependency graph correct, every spec section gets a slot, tests-first throughout. But there are six **BUG**-class issues that will block the implementer the moment they sit down to code, and three **CONSIDER**-class issues that affect spec fidelity / future maintenance. The biggest is **Task 6 uses the wrong Apple SDK decoder for webhook payloads** (`verifyAndDecodeTransaction` instead of `verifyAndDecodeNotification`), which means the webhook signature path will fail outright on real ASSN payloads.

Verdict at the bottom: **APPROVE WITH CHANGES**.

---

## 1. Spec coverage walk-through

I walked §3–§14 against the plan and the self-review.

| Spec section | Plan task(s) | Verdict |
|---|---|---|
| §3 shared lib (productIds, namespace, schemas, errors) | T1 | ✓ |
| §3 schema (User.iap*, Subscription.environment, IapDeletedBinding) | T2 | ✓ |
| §3 trust-chain (binding tokens = identifiers, not authenticators) | T1.6 comment in namespace.ts | ✓ |
| §4 mobile library + Expo Go warning | T11 (install + binding + client + CLAUDE.md note) | ✓ |
| §4 plan picker + empty-state fallback + Restore button on plan | T12.1 | ✓ |
| §4 More tab Restore row + Manage Billing sku derivation | T12.3 / T12.4 | ✓ |
| §5.1 env vars + base64-OR-raw GOOGLE_SERVICE_ACCOUNT_JSON + redactEnv | T3 | ✓ |
| §5.1 503 `iap_not_configured` 가드 | T3.6 (requireIapEnv throws HttpError(503)) | ✓ |
| §5.1 boot-time errors MUST NOT echo env values | T3.5 has a test asserting no leak; impl uses key-only messages | ✓ |
| §5.2 Apple JWS 6 mandatory checks | T4 + T4 test | ✓ (but see BUG-1 below) |
| §5.2 Apple Family Sharing subtype ignore | T10.2 webhook handler | ✓ |
| §5.2 Google v2 `subscriptionsv2.get` + acknowledge + `linkedPurchaseToken` chain | T5 + T7 | ✓ (but see BUG-3) |
| §5.2 `syncSubscriptionFromIAP` discriminated-union args, `expected*` optional on webhook | T7 | ✓ |
| §5.3 routes (checkout + restore) — 409 ladder, mandatory token check, restore partial-success | T9 | ✓ |
| §5.3 webhook routes — 4-step userId resolution + retry-cap + tombstone | T10 | ✓ |
| §5.3 raw-body parser per-plugin | T10.2 `addContentTypeParser` | ✓ |
| §5.4 Apple status table + offerType fail-closed | T4 status-mapping.ts | ✓ |
| §5.4 Google status table (incl. CANCELED+expiryTime split, ON_HOLD product decision) | T4 status-mapping.ts | ✓ |
| §6 Apple deterministic appAccountToken (uuidv5) | T7 binding.ts + T11 mobile binding | ✓ |
| §6 ASC API round-trip rationale | implicit in T4 `getSubscriptionStatus` | ✓ |
| §7 Google obfuscatedAccountId = sha256(userId) | T7 + T11 binding | ✓ |
| §7 acknowledge AFTER upsert | T7 sync-sub.ts step 6 + comment | ✓ |
| §7 `linkedPurchaseToken` chain rewrite | T7 sync-sub.ts | ✓ |
| §8 Stripe-always-wins, sandbox env filter | T8 precedence.ts | ✓ |
| §10 testing strategy | every code task carries Vitest tests | ✓ |
| §11 launch gates manual checklist | T13 | ✓ |
| §12.1 GDPR retention + IapDeletedBinding | T2 schema; webhook reads tombstone in T10. Account-deletion *write* path correctly deferred. | ✓ |
| §12.2 account merge / userId migration | spec marks manual-only; plan doesn't add code — correct OOS handling | ✓ |
| §12.3 webhook trust-chain (no expected-token check on webhook) | T10.2 comment `// webhook path does NOT pass expectedAppAccountToken (spec §12.3)` and T7 design (optional `expected*`) | ✓ |

Coverage is comprehensive. No spec section is silently dropped.

---

## 2. Dependency graph correctness + hidden cross-task coupling

The graph at the top of the plan is **mostly correct** but understates two real couplings:

### BUG-A: Task 8 buildMeBody signature change is a load-bearing precondition for Task 9, not parallel

The graph shows `8 (buildMeBody) ‖ 9 (routes) ‖ 10 (webhooks)`. But Task 8 step 8.4 changes the signature `buildMeBody(userId)` → `buildMeBody(userId, runtimeEnv)` (the plan even calls this out: "change `buildMeBody(userId)` → `buildMeBody(userId, runtimeEnv)`"). Task 9 step 9.4 then writes `export async function buildMeBody`, and Task 9's checkout / restore handlers (T9.2) call `await buildMeBody(userId, cfg.apple.env)` — that call site only compiles after T8 has landed.

**Effect:** if T9 starts while T8 is still in flight, T9's tests will compile-error on the `buildMeBody` call. The dependency graph should show `8 → 9` (sequential), not `8 ‖ 9`.

**Severity: BUG (won't compile).** Fix: redraw the graph as `7 → 8 → 9` and `7 → 8 → 10` so Task 8's `buildMeBody` export + signature change ships before Task 9's route uses it. Or split Task 8 into 8a (precedence pure helper, parallel-safe) and 8b (`buildMeBody` rewire, must be sequential).

### CONSIDER: Task 7 depends on Task 4 + Task 5 (both, not either)

Graph shows `7 (sync-sub)` after `6 (webhook-verify)`. Real dependency is `7` after both `4 (apple-client)` and `5 (google-client)` because T7's `SyncDeps` types are `Pick<AppleClient, ...>` + `Pick<GoogleClient, ...>` (T7.6 lines 13-15 of sync-sub.ts). The graph hides this — 4 and 5 are marked parallel (✓) but the implicit fan-in to 7 isn't drawn.

NIT, not blocking.

---

## 3. Bite-sized granularity (skill says 2-5 min/step)

Most steps are 2-5 min. Three are clear outliers and should be split:

### NIT: Task 4 Step 4.6 — `apple-client.ts` is ~165 lines including ASC roundtrip + JWS validation

This is one of the most complex pieces of code in the plan. The status-mapping helper has already been carved out (good), but `verifyAndDecodeTransaction` (with six checks) + `getSubscriptionStatus` (which decodes both `signedTransactionInfo` and `signedRenewalInfo`) + `appleStatusFromCode` are bundled into one step. Suggest splitting:
- 4.6a: constructor + `_decodeAndVerifyJws` seam + `verifyAndDecodeTransaction` (the 6 checks).
- 4.6b: `getSubscriptionStatus` + `appleStatusFromCode`.

Each piece has its own slice of tests in 4.5, so this is a clean split.

### NIT: Task 10 Step 10.2 — `billing-iap-webhook.ts` is ~200 lines for both Apple + Google with 4-step resolution

Split into 10.2a (Apple webhook + 4-step) and 10.2b (Google webhook + 4-step). Each is testable independently against the same `buildApp`.

### CONSIDER: Task 7 Step 7.6 — `sync-sub.ts` is ~170 lines including Apple + Google + linkedPurchaseToken chain

Could split into 7.6a (Apple syncApple) and 7.6b (Google syncGoogle + linkedPurchaseToken handling), each with their own test slice from 7.5. Not strictly required — the test design already separates the two — but would tighten the iteration loop.

---

## 4. Code block correctness — spot checks against the real libraries

I downloaded the actual `@apple/app-store-server-library@3.1.0`, `googleapis@172.0.0`, and `react-native-iap@15.3.1` typedefs to verify.

### BUG-1 (HIGH): Task 6 webhook-verify uses the wrong Apple decoder

The plan's Task 6 `verifyApplePayload` (lines 1571-1574) decodes the ASSN signedPayload via `appleClient._decodeAndVerifyJws`, which Task 4 (line 1070-1073) defines as a wrapper around `this.verifier.verifyAndDecodeTransaction(jws)`. But Apple's SDK exports a **dedicated** `verifyAndDecodeNotification(signedPayload)` method on `SignedDataVerifier` — confirmed in `package/dist/jws_verification.d.ts` line 78:

```ts
verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
```

`ResponseBodyV2DecodedPayload` is a different shape (`notificationUUID`, `notificationType`, `subtype`, `data`, `version`) from `JWSTransactionDecodedPayload` (`originalTransactionId`, `bundleId`, `productId`, ...). The transaction validator will refuse the notification payload at runtime because the shape doesn't pass the `JWSTransactionDecodedPayloadValidator` (the SDK validates body shape after JWS chain verification).

**Effect:** Webhook payloads from Apple will fail signature/shape verification with a confusing error, but the plan's tests (T6.1) mock the decode to return a notification-shaped object, so the unit tests will pass while production blows up.

The plan acknowledges this in a comment at line 1567-1570 ("Apple's SDK exposes a notification-specific decoder; if not used, the appleClient's underlying _decodeAndVerifyJws (a JWS verifier) works for both transaction and notification payloads because ASSN signs with the same chain") — this comment is technically true about the *chain* but wrong about the *payload validator*.

**Fix:** Add a method `verifyAndDecodeNotification(jws)` on `AppleClient` that calls `this.verifier.verifyAndDecodeNotification(jws)` and returns the typed result. Task 6 should consume that, not `_decodeAndVerifyJws`. Similarly, `getSubscriptionStatus` in Task 4 currently calls `_decodeAndVerifyJws(item.signedRenewalInfo)` — Apple ships a dedicated `verifyAndDecodeRenewalInfo` (line 69 of the d.ts). Use it.

### BUG-2 (MEDIUM): Task 4 apple-client uses placeholder root cert that will fail boot

`apple-client.ts` line 1024-1030 has `<<<APPLE_WWDR_G3_ROOT_PEM_HERE>>>`. The plan's self-review acknowledges this. But `SignedDataVerifier`'s constructor expects `Buffer[]` of DER-encoded root certs — the comment in the SDK says "A list of DER-encoded root certificates" while the plan code wraps a placeholder PEM string in a Buffer. The plan's note "Apple's library expects raw DER/PEM bytes per cert" is slightly off: the SDK actually accepts PEM (it converts internally via `X509Certificate`), so PEM-as-Buffer is fine in practice — but the *placeholder string* will cause the constructor to throw on first AppleClient instantiation at runtime. T4 tests pass because they mock `_decodeAndVerifyJws`, not the SDK constructor.

**Effect:** The first time `requireIapEnv()` runs in a non-mocked context (Task 9 route hitting the real env), Fastify will throw on AppleClient construction. The plan's T13 gate 1 (manual smoke) is the only place this surfaces.

**Fix:** Either (a) add a Step 4.0 "download Apple G3 root and inline" with the actual PEM (the spec §5.2 check 2 mandates SPKI-pinned root in code anyway), or (b) make the cert load from a separate file (`apps/api/src/iap/apple-roots.ts`) and add a TODO marker that a subagent dispatcher can fail-fast on (e.g., `if (env === "production") throw…`).

The current marker is also too soft — a `<<<…>>>` literal will silently load as a malformed cert and fail with an opaque SDK error, not a clear "you forgot to drop in the cert" boot error.

### BUG-3 (LOW-MEDIUM): Task 5 google-client `_acknowledge` calls v1 path with empty subscriptionId

Plan code (T5 step 5.3 line ~1334-1343):

```ts
await this.androidPublisher.purchases.subscriptions
  .acknowledge({
    packageName: this.cfg.packageName,
    subscriptionId: "", // v1 endpoint requires subId; v2 doesn't surface it cleanly — pass empty
    token: purchaseToken,
    requestBody: {},
  })
```

I verified against `googleapis@172.0.0`: `Resource$Purchases$Subscriptionsv2` (v2 class) has `cancel`, `defer`, `get`, `revoke` but **NOT** `acknowledge` — confirmed. So the plan correctly falls back to the v1 `purchases.subscriptions.acknowledge`. The v1 docstring in the typedefs explicitly notes "Since May 21, 2025, subscription_id is not required" — so an empty string IS acceptable today.

But: spec §7 says "`purchases.subscriptionsv2.acknowledge`" (line 184) — which doesn't exist on v2. The plan correctly routes around the spec error here, but the implementer reading this code with the v2-says-spec mismatch in their head will wonder if the v1 call is a hack. **NIT:** Add a comment citing the May 2025 Google deprecation that allows `subscriptionId: ""`.

Also, the spec at §11 step 2 (Google ops) requires the `androidpublisher.subscriptions.update` scope (plural) — for the v1 acknowledge endpoint. The plan doesn't re-verify this in code (which is correct — it's a Play Console grant), but the manual checklist Task 13 should call it out. Currently T13 doesn't mention scopes. **NIT.**

### BUG-4 (HIGH): Task 9/10 tests assume a `buildApp` helper signature that doesn't exist

Plan test code (T9 step 9.1 line 2347, T10 step 10.1 line 2631):

```ts
app = await buildApp({ iap: { appleClient: fakeAppleClient, googleClient: fakeGoogleClient } });
```

I checked `apps/api/src/server.ts`: the real signature is `buildApp(env: Env): Promise<FastifyInstance>` — takes `env`, not an options bag. Every existing test (`tests/billing-webhook.test.ts`, `tests/auth.session.test.ts`, etc.) calls `buildApp(env)` with the project's test-env helper.

Plan also references `import { resetTestDb, makeAuthedSession } from "../testdb.js"` and `import { buildApp } from "../helpers/build-app.js"` — none of these files exist:
- `apps/api/tests/helpers/db.ts` exports `truncateAll` (not `resetTestDb`).
- `apps/api/tests/helpers/auth.ts` exports `signUpAndGetCookie` (not `makeAuthedSession`).
- There is no `apps/api/tests/testdb.ts` or `helpers/build-app.ts`.
- Tests live in `apps/api/tests/` not `apps/api/test/iap/`.

**Effect:** Every test in Tasks 9, 10 (and 2.5, 7.5 which also use `resetTestDb` + `testdb`) will fail to import on first run. The implementer has to invent a `buildApp({iap: deps})` overload — but `buildApp` doesn't currently support dep injection at all.

**Fix:** The plan needs a precursor step (call it Task 0 or a sub-step of Task 3) that:
1. Extends `buildApp` to accept an optional second argument `opts: { iap?: { appleClient, googleClient, oidcClient } }` and decorates `app.fina.iap` from that.
2. Either points the plan's `resetTestDb`/`makeAuthedSession` references at the real helpers (`truncateAll`, `signUpAndGetCookie`) or creates a thin compat layer.
3. Uses `apps/api/tests/` (existing dir), not `apps/api/test/iap/` (non-existent).

This is the single biggest correctness gap. A subagent executing Task 2.5 will hit "Cannot find module '../testdb.js'" immediately.

### BUG-5 (MEDIUM): Task 3 step 3.8 "extend Pino redact config" — there is no redact config to extend

Plan instructs editing the Pino init in `server.ts` to add `redact.paths`. The actual config at `apps/api/src/server.ts:84` is:

```ts
logger: env.NODE_ENV === "test" ? false : { level: "info" },
```

— no `redact` block at all. Adding one is fine but the plan's diff doesn't account for needing to *introduce* the config object first, and the plan's example (lines 698-715) uses an outer `pino({...})` call that doesn't exist in this codebase (Fastify uses inline `logger: {...}` not standalone `pino()`).

**Fix:** Step 3.8 should say: "Edit `apps/api/src/server.ts:84` — replace `{ level: 'info' }` with `{ level: 'info', redact: { paths: [...], censor: '[REDACTED]' } }`." And the test for it should mock Pino + verify the redact wiring (currently there's no test for this — Step 3.8 has no Step 3.7-style assertion).

### CONSIDER: Task 10 WebhookEvent.body column added mid-task

Step 10.3 (line 3022-3031) says: "If the existing schema doesn't have `body` on `WebhookEvent` (it doesn't — re-read `schema.prisma:711-720`), add it as part of this task's migration." I confirmed via `schema.prisma:711-720`: WebhookEvent has `id`, `source`, `type`, `receivedAt` — no `body`. So the column DOES need to be added.

But this is a migration buried inside Task 10. Spec §3 doesn't mention it. Two issues:
1. The migration ought to be in Task 2 (the one migration task) so we have a single Prisma migration for the IAP work — adding two migrations (one in T2 + one in T10) is messier.
2. T10's tests (T10.1 lines 2701-2702 and 2918-2919) write `body: { appAccountToken: ... }` — these will fail until T10.3 runs, but T10's own test step 10.5 (which says "PASS 8/8") doesn't gate on it.

**Fix:** Fold T10.3 into T2.2/T2.3. Single migration. Document the `body Json?` addition in §3 of the spec (or accept that the plan adds it without spec coverage).

### BUG-6 (HIGH): Task 11 mobile uses `requestSubscription` — removed in react-native-iap 15.x

Plan code (T11 step 11.6 lines 3215-3218):

```ts
const purchase = await requestSubscription({
  sku: args.productId,
  appAccountToken,
});
```

`react-native-iap` latest is 15.3.1 (verified via `npm view`). I extracted the 15.3.1 typedefs: `requestSubscription` **does not exist** — replaced by `requestPurchase(MutationField<'requestPurchase'>)`. 15.x is a `nitro`-based rewrite with a completely different API surface.

The plan's spec (§4) says ">= 12.x" but the plan's install command in step 11.1 is just `npm install react-native-iap`, which gets `latest` (15.3.1 today). The plan needs to either:
- Pin to `react-native-iap@^14` (last version with `requestSubscription`), OR
- Rewrite T11.6 against the 15.x `requestPurchase` API.

This is the second-biggest landmine: as written, T11 fails `npm install` → import → first test cycle.

**Fix:** `npm install react-native-iap@^14 --workspace=apps/mobile` in step 11.1, AND verify 14.x's `requestSubscription` signature still accepts `appAccountToken` (iOS) + `obfuscatedAccountIdAndroid` (Android) — both fields landed in 12.10+ per the changelog.

---

## 5. Type / signature consistency

### Apple `verifyAndDecodeTransaction(jws, opts?)` flow

- T4 defines: `verifyAndDecodeTransaction(jws: string, opts: { context?: VerifyContext } = {})` (line 1078-1080).
- T7 calls: `verifyAndDecodeTransaction(args.receipt, { context })` (line 2001). ✓
- T10 calls: `verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" })` (line 2885). ✓

Consistent.

### `syncSubscriptionFromIAP(cfg, args, deps)` flow

- T7 defines: `syncSubscriptionFromIAP(cfg, args, deps)` (line 1990-1994).
- T9 calls (checkout): `syncSubscriptionFromIAP(cfg, {platform:'ios', receipt, userId, productId, expectedAppAccountToken, context:'checkout'}, deps)` (line 2499). ✓
- T9 calls (restore): same shape, `context:'restore'`. ✓
- T10 calls (Apple webhook): `syncSubscriptionFromIAP(cfg, {platform:'ios', receipt: notification.signedTransactionJws, userId, context:'assn'}, deps())` (line 2923). ✓ — note: omits `expectedAppAccountToken`, which the spec §12.3 + T7 design explicitly allow. Good.
- T10 calls (Google webhook): `syncSubscriptionFromIAP(cfg, {platform:'android', receipt: note.payload.purchaseToken, userId, context:'rtdn'}, deps())` (line 3000). ✓

Consistent.

### `buildMeBody(userId, runtimeEnv)` flow — see BUG-A above. **The signature change in T8 must land before T9's import.**

### IapDeletedBinding shape

- T2 defines `model IapDeletedBinding` with `source`, `tokenHash`, `userIdHash?`, `deletedAt`, `@@unique([source, tokenHash])` (line 349-363).
- T10 reads via `where: { source_tokenHash: { source: "iap_apple", tokenHash: ... }}` (line 2902-2904). ✓ — Prisma's composite-unique key name is `source_tokenHash` per Prisma convention (`@@unique([source, tokenHash])` → `source_tokenHash`). Correct.

Consistent.

### `deriveAppleToken` / `deriveGoogleToken` flow (API + mobile)

- API T7: `deriveAppleToken(userId) = uuidv5(userId, IAP_NAMESPACE)`. ✓
- API T7: `deriveGoogleToken(userId) = sha256(userId)`. ✓
- Mobile T11: `deriveAppleToken(userId) = uuidv5(userId, IAP_NAMESPACE)`. ✓
- Mobile T11: `deriveGoogleToken(userId) = sha256Hex(userId)` (sync via `js-sha256`). ✓

Both sides import `IAP_NAMESPACE` from `@fina/shared`. **Critical**: if the constant ever drifts, all bindings break. T1.6 has a test pinning the constant to a fixed UUID. Good.

But note: the mobile `sha256Hex` function (T11.4 line 3138-3144) uses `require("js-sha256")` inside a sync function. The plan's binding test at T11.3 (line 3094-3104) calls `deriveGoogleToken("user-1")` synchronously, asserts hex/64. Under Vitest in a Node environment this works (`require` exists). Under React Native runtime (Hermes), `require` works at the module-loader level but won't load `js-sha256` lazily — the plan needs to `import { sha256 } from "js-sha256"` at module top, not require it lazily. **NIT:** rewrite as a top-level import.

---

## 6. Test correctness

I spot-checked tests for whether they'd fail meaningfully against a no-op implementation.

### CONSIDER: T6.1 verifyApplePayload happy path

The test (line 1441-1445) passes a fake client whose `verifyAndDecodeTransaction` returns `{ raw: { notificationUUID: "uuid-1", data: { signedTransactionInfo: "tx-jws" } } }`. The implementation (T6.2) then calls `decode(signedPayload)` and reads `decoded.notificationUUID`. But the fake returns `{ raw: { notificationUUID: ... } }` — wrapped in `raw`. The implementation accesses `decoded.notificationUUID` (no `.raw`). **The test will fail against the implementation as written** — `decoded.notificationUUID` will be `undefined`, so `String(decoded.notificationUUID ?? "")` = `""`, and the assertion `expect(out.raw.notificationUUID).toBe("uuid-1")` will fail because `out.raw` is the whole `decoded` object, which has `raw.notificationUUID` nested.

Reading more carefully: in T6.2 the implementation does `const decoded = await decode(signedPayload)` — but `decode` in the test is `verifyAndDecodeTransaction` which returns `{ raw: {...} }` shape from T4's `VerifiedAppleTransaction`. Then `decoded.notificationUUID` is undefined and `decoded.data` is undefined, but the `raw: decoded` field at the end captures the wrapper, so `out.raw.raw.notificationUUID === "uuid-1"`. The test assertion `expect(out.raw.notificationUUID).toBe("uuid-1")` would fail.

**Fix:** Either (a) the test's fake should return the inner shape directly, or (b) the implementation should unwrap `decoded.raw` when the SDK returns a `VerifiedAppleTransaction`. Compounded with BUG-1 (wrong decoder method), the whole T6 verifyApplePayload design needs rethinking.

### CONSIDER: T10.1 step-4.4 retry-cap test asserts behavior the impl doesn't quite produce

Test (line 2705-2724): "step 4.4 unknown user returns 500 first time, 200 after 5 retries":

```ts
for (let i = 0; i < 5; i++) {
  const res = await app.inject({
    method: "POST", url: "/webhooks/iap/apple",
    payload: { signedPayload: "fake-jws", notificationUUID: `uuid-4-${i}` },
  });
  expect(res.statusCode).toBe(500);
}
const res6 = await app.inject({ ... payload: { ... notificationUUID: "uuid-4-5" } });
expect(res6.statusCode).toBe(200);
```

But the impl (line 2912-2920) counts retries via `prisma.webhookEvent.count({ where: { source: "iap_apple", type: "unattributable_retry", body: { path: ["appAccountToken"], equals: ... }}})` — and the count threshold is `>= MAX_UNKNOWN_RETRIES` (5). So:

- Call 1: count = 0, write retry row + return 500. count is now 1.
- Call 2: count = 1, write retry row + return 500. count is now 2.
- ...
- Call 5: count = 4, write retry row + return 500. count is now 5.
- Call 6: count = 5 (≥ 5), write giveup + return 200. ✓

This works! But the test's `payload` field `notificationUUID` is ignored by the impl (which reads notificationUUID from the **verified JWS payload**, not the HTTP body). The mock `_decodeAndVerifyJws` returns `notificationUUID: "uuid-4"` for *every* call (one fixed mock). So `eventId = "apple:uuid-4"` will be the **same** across all 6 calls, and the very first dedup check (line 2873-2874) will hit on call 2: `existing = await prisma.webhookEvent.findUnique({where:{id:eventId}})` returns the retry row created in call 1, and the impl `return { ok: true }`. So **the test's "5 retries → 500, then 200" semantics will not be observable** — instead it'll be "1 call → 500, all subsequent → 200 (deduped)".

The test setup tries to use different `notificationUUID` per call via the HTTP body, but the impl reads from the JWS — the HTTP body's `notificationUUID` does nothing.

**Fix:** Either (a) the test should re-mock `_decodeAndVerifyJws` per iteration to return a new notificationUUID, or (b) the test should mock around the dedup check, or (c) the impl should bypass dedup for `unattributable_retry` events. Pick one and document.

### CONSIDER: T10.1 dedup test ("Family Sharing subtype ignored") — actually tests no-crash

Test asserts `expect(res.statusCode).toBe(200)` for the Family Sharing subtype. Impl handles this by creating a `WebhookEvent` with `type: "ignored_family_sharing"` and returning `{ ok: true }`. ✓ Test will pass against the implementation. Good.

### CONSIDER: T7.5 acknowledge-ordering test is weak

Test (line 1887-1911): "acknowledge runs AFTER upsert succeeds (not before)". The assertion is:

```ts
const sub = await prisma.subscription.findFirst({ where: { userId: "u1", sourceSubscriptionId: "pt-2" } });
expect(sub).not.toBeNull();
expect(order).toEqual(["ack"]);
```

This asserts only that ack ran and the sub exists — it doesn't actually verify ordering. The impl could call `acknowledgeIfPending` BEFORE the upsert and this test would still pass (because both happen before the assertion). To genuinely test ordering, the mock should record the order of *both* events:

```ts
fakeGoogleClient.acknowledgeIfPending.mockImplementation(async () => { order.push("ack"); });
// + spy on prisma.subscription.upsert or use a Prisma middleware to record "upsert"
```

The plan's comment "Spy upsert via a Prisma middleware would be heavy; instead, the assertion is: after the call returns, the row exists AND ack ran" — this gives up on the actual ordering assertion. The test is misleading. **NIT:** rename it to "ack runs as part of the sync flow" or strengthen via a Prisma middleware.

### NIT: T8.1 precedence tests skip Stripe-pro vs IAP-pro tiebreak

Tests cover:
- Empty input → null.
- `Stripe wins over IAP even when IAP has higher tier` — checks stripe-lite beats iap-pro. ✓
- `Among non-Stripe, pro beats lite` — iap-lite vs iap-pro. ✓
- `Tiebreak by source: apple > google` — iap_apple-pro vs iap_google-pro. ✓
- `Tiebreak by createdAt ASC` — same source, different createdAt. ✓
- Env filter: 2 tests.

Missing: `stripe-pro vs stripe-lite` (intra-Stripe tiebreak), `stripe-pro vs iap-pro` (Stripe-wins-when-same-tier confirmation), and edge cases like unknown source / unknown tier. The comparator code uses `?? 9` fallbacks which look intentional but aren't exercised. **NIT:** add 2-3 more tests.

---

## 7. Placeholder / TBD scan

Beyond the acknowledged Apple G3 PEM placeholder (BUG-2), I scanned for other implicit TBDs:

- **T11 `js-sha256` install** (line 3147-3150): "Install `js-sha256` if not already present". The plan says "Already in deps because it's used by Better Auth's client. If not, install it." — that's ambiguous. Better Auth doesn't actually use `js-sha256` (Better Auth uses `@noble/hashes` or `crypto.subtle`). **NIT:** drop the speculation, say "Install via `npm install js-sha256 --workspace=apps/mobile`" unambiguously.
- **T8.5** updates `effectiveTier` with `process.env.APPLE_ENV` directly: "(process.env.APPLE_ENV === 'production' ? 'production' : 'sandbox')". The rest of the codebase reads env via `app.fina.env` from validated Zod env. Reading raw `process.env` here is a pattern break. **NIT:** prefer dependency-injected env or top-level `env.js` import.
- **T9.4** says "Add the `runtimeEnv` parameter as introduced in Task 8." — but Task 8 step 8.4 just *describes* the parameter, doesn't show the final `buildMeBody` signature. Plan should give explicit `export async function buildMeBody(userId: string, runtimeEnv: "sandbox" | "production"): Promise<MeDTO>` in T8.4 with the full body. Otherwise the implementer guesses at the right surface.

No outright `TODO` markers; just the soft TBDs above.

---

## 8. YAGNI check

I scanned for v1-scoped overcommitment:

- **`IapDeletedBinding.userIdHash`** field is declared in T2 but never written by any task (T10 only sets `source`, `tokenHash`). Spec §3 line 99 says "Optional SHA-256 of the original userId for support-replay." — fine to ship the column nullable, but flag it as not-yet-populated. **NIT.**
- **`AppleClient._decodeAndVerifyJws` is `protected`** but tests inject around it with `vi.spyOn(c as any, "_decodeAndVerifyJws")`. The cast-to-any pattern is fragile. Could use a dependency-injection constructor argument instead. **NIT, not blocking.**
- **`MAX_UNKNOWN_RETRIES = 5`** (T10 line 2832) — Apple's policy is 5 retries over 3 days, so 5 is the right cap. Google's policy is up to 7 days with exponential backoff (per Pub/Sub default) — 5 may be too tight for Google. **CONSIDER** raising to 7 or making it per-source.
- **`linkedPurchaseToken` chain** is single-level only (per spec §7 + R2 NEW-2 verdict "fine because each link only references the immediate predecessor"). Plan correctly doesn't recurse. ✓

Nothing materially over-built. The plan tracks the spec's v1 scope.

---

## 9. Practical execution risk — where the first agent breaks

Ranked by what a subagent-per-task workflow would hit first:

1. **Task 2.5 schema smoke test** → import error on `../testdb.js` (doesn't exist). First fail. (BUG-4)
2. **Task 3.8 Pino redact extend** → tries to edit a `redact.paths` array that doesn't exist in `apps/api/src/server.ts:84`. Implementer wastes time hunting. (BUG-5)
3. **Task 4.6 apple-client** → SDK loads but the placeholder root cert string will throw on construction. (BUG-2)
4. **Task 6 webhook-verify** → uses `verifyAndDecodeTransaction` for ASSN payloads; unit tests pass but the design is wrong. (BUG-1)
5. **Task 8 + Task 9** → run parallel per the dep graph, but T9 depends on T8's `buildMeBody` signature change. Race. (BUG-A)
6. **Task 9 / 10 tests** → `buildApp({iap:{...}})` overload doesn't exist; need to extend `buildApp` first. (BUG-4)
7. **Task 11.1 install** → `npm install react-native-iap` gets 15.3.1, breaks T11.6. (BUG-6)
8. **Task 10.3 schema migration** → second IAP migration on top of T2's; messy. (CONSIDER)

If I were running this as subagent-driven-development today, I'd land Task 1 and Task 2 clean, then trip on Task 2.5 (test imports) and Task 3.8 (Pino config) before getting to the more interesting Apple/Google client work.

---

## 10. Severity tally

| Severity | Count | Items |
|---|---|---|
| BUG | 6 | A (T8→T9 ordering), 1 (wrong Apple decoder for ASSN), 2 (apple root cert placeholder will throw), 3 (Google v2 acknowledge clarity), 4 (buildApp injection seam + testdb helpers don't exist), 5 (Pino redact target doesn't exist), 6 (react-native-iap 15.x breaking change) |
| CONSIDER | 4 | T7+T10 step granularity; T6/T7/T10 test correctness gaps; WebhookEvent.body migration placement; MAX_UNKNOWN_RETRIES per-source |
| NIT | 9 | T7 dep arrow; T4 split; placeholder strictness; sha256 require→import; T8.5 process.env direct read; T1.6 wording; T8.1 missing tests; T9.4 spec out signature explicitly; userIdHash never written |

---

## Verdict

**APPROVE WITH CHANGES.**

The plan is well-organized and the test-first cadence is right. The spec is fully covered. But six BUG-class issues — three of them landing in the first 3 tasks (T2.5 test imports, T3.8 Pino target, T6 wrong decoder), three more landing as soon as routes/webhooks/mobile start (T8/T9 ordering, T9/T10 `buildApp` injection, T11 react-native-iap 15.x) — will block a subagent dispatcher.

**Before handing this off, the author should:**

1. **(BUG-4)** Add an explicit "Task 0" or extend Task 3 to: (a) introduce a `buildApp(env, opts?)` overload with `app.fina.iap` injection, (b) rename test imports to the real helpers (`truncateAll`, `signUpAndGetCookie`), (c) point tests at `apps/api/tests/` not `apps/api/test/iap/`.
2. **(BUG-A)** Redraw the dependency graph so `8 → 9` and `8 → 10` are sequential, not parallel. OR split T8 into 8a (precedence pure helper, parallel) + 8b (`buildMeBody` rewire, sequential).
3. **(BUG-1)** In Task 6, use `appleClient.verifyAndDecodeNotification()` for ASSN payloads. Add the method to T4's `AppleClient` if not already there. Also use `verifyAndDecodeRenewalInfo()` for `signedRenewalInfo` in T4's `getSubscriptionStatus`.
4. **(BUG-2)** In Task 4, either ship a working PEM up front or fail fast: `if (root.includes("<<<")) throw new Error("Apple WWDR G3 root cert not installed — see https://www.apple.com/certificateauthority/")` inside the constructor.
5. **(BUG-5)** Rewrite Step 3.8 to *introduce* a `redact:{...}` field on the Fastify logger config at `server.ts:84` (the existing inline `{level:'info'}` form), plus a unit test that asserts the redact wiring.
6. **(BUG-6)** Pin Task 11.1 install to `react-native-iap@^14` (or rewrite T11.6 for `requestPurchase` if targeting 15.x). Per spec §4 "Library: `react-native-iap` (community standard…)" — `^14` is consistent with spec's ">= 12.x".
7. **(BUG-3 + CONSIDER WebhookEvent.body)** Fold T10.3 schema additions into Task 2's single migration. Add comment in T5.3 noting May 2025 Google deprecation that allows empty `subscriptionId`.
8. **(test gaps)** Fix T6.1's fake-shape vs impl mismatch, T10.1's retry-cap test (mock `_decodeAndVerifyJws` per call), T7.5's ordering assertion.

Once those land, the plan is ready to execute. The remaining CONSIDERs and NITs are fine to address in the implementing PR.

**Decomposition:** Sound at 13 tasks, but T4.6, T7.6, T10.2 are too large per the 2-5-min-per-step skill — recommend splitting each into 2 sub-steps.

**Spec coverage:** Complete. Self-review at the bottom of the plan accurately tracks the spec; nothing dropped silently.

**Code-block correctness:** Apple SDK API surface (`SignedDataVerifier`, `AppStoreServerAPIClient`) matches the plan's usage *except* for the wrong-decoder issue (BUG-1) and the placeholder cert (BUG-2). Google SDK matches but with the small confusion around v1 vs v2 acknowledge (BUG-3). react-native-iap is the most fragile dependency — 15.x ships incompatible (BUG-6).
