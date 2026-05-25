# Plan 1N-notification-prefs-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1M-anomaly-test (shipped `1fe0d45`). Continues the test-coverage backfill for previously-uncovered notification surface.

## 1. Goal & scope

`notification_prefs` system has 3 untested layers:
- `libs/shared/src/notifications.ts` — `resolveNotificationPrefs(stored)` pure function + `DEFAULT_NOTIFICATION_PREFS` constant + `NotificationPrefsSchema` zod. **0 tests currently**.
- `apps/api/src/routes/me.ts` — PATCH /me partial-merge logic + GET /me resolved prefs return. Not exercised in `me.test.ts`.
- `apps/api/src/push/send.ts` — `isChannelEnabled(userId, channel)` gate applied in 8 `sendXxxPush` wrappers. `push.send.test.ts` tests Expo SDK behavior but not channel gating.

This plan adds ~15 tests across 3 commits to close all three gaps.

**Out of scope:**
- Exhaustive per-channel sweep on `sendXxxPush` (gate code identical across 8 wrappers — spot check 2 representative channels: morningBrief + largeCharges).
- Direct unit test of `isChannelEnabled` (private file-scoped function — tested via public wrapper behavior).
- Mobile `/notifications` UI screen tests — separate plan.
- New notification channel additions/removals — schema is stable.

## 2. Shared library touchpoints

**No new exports.** `libs/shared/src/notifications.ts` already exports all consumers need (`DEFAULT_NOTIFICATION_PREFS`, `NotificationPrefs`, `NotificationPrefsSchema`, `NotificationPrefsPatch`, `resolveNotificationPrefs`). T1 creates a sibling test file at `libs/shared/src/notifications.test.ts` consuming the existing exports.

CLAUDE.md "shared first" rule technically applies, but since T1 doesn't change the shared API, downstream T2/T3 don't depend on T1 ordering. Commit order chosen for clean revert paths: T1 (shared test) → T2 (me.routes) → T3 (push.send gate).

## 3. Production change

**없음.** All 3 tasks are pure test additions. `notifications.ts`, `me.ts`, `push/send.ts` production code unchanged.

## 4. Task breakdown

### T1: `libs/shared/src/notifications.test.ts` (NEW, 7 tests)

Pure-function unit tests for `resolveNotificationPrefs`:

```ts
import { describe, expect, it } from "vitest";
import { resolveNotificationPrefs, DEFAULT_NOTIFICATION_PREFS } from "./notifications.js";

describe("resolveNotificationPrefs", () => {
  it("null → all defaults", () => {
    expect(resolveNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("undefined → all defaults", () => {
    expect(resolveNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("non-object inputs (string/number/array) → all defaults", () => {
    expect(resolveNotificationPrefs("foo")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs(42)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs([])).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("empty object → all defaults", () => {
    expect(resolveNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("partial { morningBrief: false } → that key false, others default", () => {
    const out = resolveNotificationPrefs({ morningBrief: false });
    expect(out.morningBrief).toBe(false);
    expect(out.largeCharges).toBe(true);
    expect(out.bankReconnect).toBe(true);
    expect(out.workspaceInvites).toBe(true);
    expect(out.trialExpiring).toBe(true);
    expect(out.goalMilestones).toBe(true);
    expect(out.transactionAdded).toBe(true);
    expect(out.productUpdates).toBe(true);
  });

  it("non-boolean values for known keys are ignored (use default)", () => {
    const out = resolveNotificationPrefs({ morningBrief: "yes", largeCharges: 0 });
    expect(out.morningBrief).toBe(true);
    expect(out.largeCharges).toBe(true);
  });

  it("unknown keys are silently dropped from the result", () => {
    const out = resolveNotificationPrefs({ foo: false, bar: true, morningBrief: false });
    expect(out.morningBrief).toBe(false);
    expect((out as Record<string, unknown>).foo).toBeUndefined();
    expect((out as Record<string, unknown>).bar).toBeUndefined();
  });
});
```

**Run via**: `pnpm --filter @fina/shared exec vitest run`.

**Commit**: `test(@fina/shared): resolveNotificationPrefs unit tests`

### T2: `apps/api/tests/me.test.ts` extension (4 tests)

Append a new `describe("notificationPrefs", ...)` block after existing tests:

1. **"PATCH applies new prefs (single field)"**: signUp → PATCH `{ notificationPrefs: { morningBrief: false } }` → 200 → GET /me returns `notificationPrefs.morningBrief === false` + all other 7 keys true (defaults).

2. **"PATCH merges with existing prefs (incremental)"**: signUp → PATCH `{ morningBrief: false }` → PATCH `{ largeCharges: false }` → GET /me returns both `false`, other 6 true.

3. **"GET returns fully-populated prefs (defaults for unset)"**: signUp → no PATCH → GET /me → `notificationPrefs` has all 8 keys, all `true` (defaults).

4. **"PATCH silently drops unknown keys (zod .partial() schema)"**: signUp → PATCH `{ notificationPrefs: { unknown: false, morningBrief: false } }` → 200 → GET /me `notificationPrefs.morningBrief === false`, no `unknown` key in returned blob.

**Commit**: `test(api): PATCH /me notificationPrefs partial merge + GET resolved prefs`

### T3: `apps/api/tests/push.send.test.ts` extension (4 tests)

Add channel gate spot check at end of existing describe block. Setup: create user via direct `prisma.user.create` (minimal `{ id, email, name }`) → set `notificationPrefs` field via `prisma.user.update` → create device → call `sendXxxPush`.

1. **"sendBriefPush respects morningBrief: false → no Expo call, logs skip"**:
   - Setup user with `notificationPrefs: { morningBrief: false }` + 1 device.
   - `vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")` to verify NO call.
   - Call `sendBriefPush(env, userId, "brief text")`.
   - Assert `sendPushNotificationsAsync` was NOT called.
   - (Optional) Spy `logInfo` and assert "push skipped — channel disabled" was logged.

2. **"sendBriefPush respects morningBrief: true (default null prefs) → Expo called once"**:
   - Setup user with `notificationPrefs: null` (or omit, defaults apply) + 1 device.
   - Call `sendBriefPush(env, userId, "brief text")`.
   - Assert `sendPushNotificationsAsync` called exactly once.

3. **"sendLargeChargePush respects largeCharges: false → no Expo call"**:
   - Same shape, channel: `largeCharges`. Wrapper signature: `sendLargeChargePush(env, userId, merchant, amount, categoryName)`.

4. **"sendLargeChargePush respects largeCharges: true (default) → Expo called once"**:
   - Default prefs (null). Assert 1 call.

**Mock pattern**: `push.send.test.ts` already mocks `expo-server-sdk` at module scope (prototype-method Expo class). New tests use existing mock + `vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")` per test. `afterEach(() => vi.restoreAllMocks())` already in file.

**Commit**: `test(api): push/send channel gate — spot check morningBrief + largeCharges`

## 5. Risks

| Risk | Mitigation |
|---|---|
| T2 PATCH merge order: `{ ...current, ...body.notificationPrefs }` per `me.ts:183-186` — body keys win. | Test #2 explicitly asserts cumulative merge (both `morningBrief: false` AND `largeCharges: false` persist after 2 sequential PATCHes). |
| T1 vite.config pattern `src/**/*.test.ts` may not pick up new file | Verified — pattern matches `src/notifications.test.ts`. Run `pnpm --filter @fina/shared exec vitest run` to confirm. |
| T3 test #1 mock — does NOT call Expo? Need to verify spy NOT called, but the test should NOT call the route layer either — direct function call only. | `sendBriefPush` is a public export; can call directly with env + userId. Pattern matches existing push.send.test.ts tests. |
| T3 mocked Expo state shared across tests in singleFork mode | `afterEach(restoreAllMocks)` already present — handled. |
| T3 test #1 + #3 verify NO call to Expo, but other test assertions in same file might leak | `vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")` is per-test; cleared by restoreAllMocks afterEach. |
| User fixture in T3 needs `id`, `email`, `name`, AND `notificationPrefs` JSON | `prisma.user.create({ data: { id, email, name } })` then `prisma.user.update({ where: { id }, data: { notificationPrefs: { morningBrief: false } } })`. 2-step setup. |
| me.test.ts existing `signUpAndGetCookie` helper — does it expose ability to set notificationPrefs? | `signUpAndGetCookie` returns `{ userId, email, cookie }`. T2 tests use `prisma.user.update` directly to set notificationPrefs on the signed-up user, then GET via cookie. |

## 6. Success criteria

- T1: 7 tests pass in libs/shared (`pnpm --filter @fina/shared exec vitest run` shows green).
- T2: existing me.test.ts tests still pass + 4 new tests green.
- T3: existing push.send.test.ts tests still pass + 4 new tests green.
- Full API suite regression: 0 fail.
- Typecheck baseline unchanged across 3 packages.
- 3 commits, one per task.

## 7. Follow-ups (별도 plans)

- Other 6 `sendXxxPush` wrappers exhaustive gate coverage if production regression observed.
- Mobile `/notifications` UI tests.
- Notification analytics (per-channel send/skip counts).
- `NotificationPrefsSchema` validation tests (currently `.partial()` — could test that PATCH rejects non-boolean values via 400 invalid_body).
