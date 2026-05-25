# Plan 1O-push-wrapper-gate-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1N-notification-prefs-test (shipped). Closes the follow-up item §7 of plan 1N: "Other 6 `sendXxxPush` wrappers exhaustive gate coverage."

## 1. Goal & scope

`apps/api/src/push/send.ts` exports 8 `sendXxxPush` wrappers. Plan 1N spot-checked the channel-gate behavior on 2 (`sendBriefPush` / `morningBrief`, `sendLargeChargePush` / `largeCharges`). 6 wrappers remain with **zero** channel-gate test coverage:

| Wrapper | Channel key | Wrapper signature |
|---|---|---|
| `sendBankReconnectPush` | `bankReconnect` | `(env, userId, institutionName)` |
| `sendTrialExpiringPush` | `trialExpiring` | `(env, userId, daysLeft)` |
| `sendGoalMilestonePush` | `goalMilestones` | `(env, userId, goalTitle, pct)` |
| `sendTransactionAddedPush` | `transactionAdded` | `(env, userId, merchant, amount, categoryName)` |
| `sendProductUpdatePush` | `productUpdates` | `(env, userId, title, body)` |
| `sendWorkspaceInvitePush` | `workspaceInvites` | `(env, userId, inviterName, workspaceName)` |

Gate code (`isChannelEnabled(userId, channel)` → `sendToUserDevices`) is **byte-identical** across all 8 wrappers — only `channel` key, `dataType`, and `title`/`body` formatting differ.

Add 6 smoke tests — one disabled-channel assertion per wrapper. The enabled-path is implicitly covered: every wrapper shares the same `sendToUserDevices(env, userId, payload)` call site that Plan 1N's enabled tests (`sendBriefPush` + `sendLargeChargePush` with default prefs) already exercise.

**Out of scope:**
- Enabled-path tests per wrapper (gate is the only branch — payload formatting belongs in a separate plan if anyone cares).
- Title/body/dataType payload-content assertions (already implicit in the prod code; would only catch typo regressions, low value).
- `isChannelEnabled` direct unit test (private function — exercised via 8 wrappers).
- New channel additions or schema changes.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. `NotificationPrefs` keys already include all 6 channels under test. T0 unit tests in `libs/shared/src/notifications.test.ts` (Plan 1N T1) already cover the resolver. Pure test addition in `apps/api`.

## 3. Production change

**없음.** `apps/api/src/push/send.ts` unchanged. Test-only.

## 4. Test additions — `apps/api/tests/push.send.test.ts`

Extend the existing `describe("channel gate (notificationPrefs)", ...)` block (currently 4 tests, lines 152-206) with 6 new tests. **One commit.**

### Pattern (identical for each wrapper)

```ts
it("send<Wrapper> respects <channel>: false (no Expo call)", async () => {
  const { Expo } = await import("expo-server-sdk");
  const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
  const u = await makeUserWithDevices(
    [{ token: "ExponentPushToken[gate-<short>-off]", platform: "ios" }],
    { <channel>: false },
  );

  const { send<Wrapper> } = await import("../src/push/send.js");
  await send<Wrapper>(testEnv(), u.id, /* wrapper-specific args */);

  expect(spy).toHaveBeenCalledTimes(0);
});
```

### Per-wrapper invocations

| # | Test description | Wrapper call |
|---|---|---|
| 1 | `sendBankReconnectPush respects bankReconnect: false (no Expo call)` | `sendBankReconnectPush(testEnv(), u.id, "Chase")` |
| 2 | `sendTrialExpiringPush respects trialExpiring: false (no Expo call)` | `sendTrialExpiringPush(testEnv(), u.id, 3)` |
| 3 | `sendGoalMilestonePush respects goalMilestones: false (no Expo call)` | `sendGoalMilestonePush(testEnv(), u.id, "Emergency Fund", 50)` |
| 4 | `sendTransactionAddedPush respects transactionAdded: false (no Expo call)` | `sendTransactionAddedPush(testEnv(), u.id, "Coffee", "5.50", "Food")` |
| 5 | `sendProductUpdatePush respects productUpdates: false (no Expo call)` | `sendProductUpdatePush(testEnv(), u.id, "New feature", "Try it now")` |
| 6 | `sendWorkspaceInvitePush respects workspaceInvites: false (no Expo call)` | `sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family")` |

### Setup/teardown — reused as-is

File header at `push.send.test.ts:1-51` already provides:
- `vi.mock("expo-server-sdk", ...)` at module scope (Expo class with prototype methods)
- `beforeEach(truncateAll)`, `afterEach(vi.restoreAllMocks)`, `afterAll(disconnect)`
- `makeUserWithDevices(tokens, notificationPrefs?)` helper accepting optional `notificationPrefs` (added in Plan 1N T3)

No helper changes. No new mock setup. No new `vi.mock` calls. No production code.

**Commit:** `test(api): push/send channel gate — 6 remaining sendXxxPush wrappers`

## 5. Risks

| Risk | Mitigation |
|---|---|
| Schema drift — a new channel added later without test | `NotificationPrefs` is a typed contract in `@fina/shared`; new channels surface as TS errors in route + UI before this test file. |
| Wrapper signature mismatch — e.g. `sendGoalMilestonePush` requires `pct: number` not string | All 6 signatures explicitly listed in §1 table and §4.1 invocations. Verified against `apps/api/src/push/send.ts` lines 163-300. |
| `sendTrialExpiringPush` builds title from `daysLeft` (1 → "tomorrow", else "in N days") — branch coverage missing | Out of scope — purely string-formatting; if gate=false, that code path is unreachable anyway. |
| `restoreAllMocks` vs `clearAllMocks` confusion | `restoreAllMocks` is correct here — module-level `vi.mock("expo-server-sdk")` is preserved (mocks aren't restored by `restoreAllMocks`; only spies are). The 4 existing channel-gate tests already use this same pattern. |
| Token uniqueness — concurrent tests in same file | Each test uses a unique `gate-<short>-off` literal; `makeUserWithDevices` generates unique user id via `Date.now() + Math.random()`. |
| Test isolation — singleFork mode | `truncateAll` in `beforeEach` clears DB; `restoreAllMocks` in `afterEach` clears spies. Same pattern as Plan 1N — proven. |

## 6. Success criteria

- 6 new tests pass.
- All 10 existing `push.send.test.ts` tests still pass.
- Full `@fina/api` suite regression: 0 fail.
- Typecheck baseline unchanged.
- 1 commit, test-only.

## 7. Follow-ups (별도 plans)

- Enabled-path per-wrapper tests (assert dataType + title/body formatting per channel). Low priority — only catches formatting typos.
- HTTP route integration tests covering each wrapper's caller (e.g., POST /workspaces/{id}/invites firing `sendWorkspaceInvitePush`).
- Mobile `/notifications` UI screen tests.
- `NotificationPrefsSchema` PATCH validation tests (non-boolean values, malformed JSON).
