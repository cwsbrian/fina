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

Gate code (`isChannelEnabled(userId, channel)` → `sendToUserDevices`) is **structurally identical** across all 8 wrappers — only `channel` key, `dataType`, and `title`/`body` formatting differ.

Add **12 smoke tests** — one disabled-channel assertion + one enabled (default) assertion per wrapper. R2 spec review caught that disabled-only tests would miss a wrapper with broken `sendToUserDevices` wiring (e.g., wrong `userId` variable, accidental early-return before the call). The paired enabled assertion closes that gap with minimal LOC overhead.

Structured as **6 nested describes** (one per wrapper) inside the existing `describe("channel gate (notificationPrefs)", ...)` block — improves diagnostic clarity on failures vs 12 sibling `it()` blocks with near-identical names.

**Out of scope:**
- Title/body/dataType payload-content assertions (already implicit in the prod code; would only catch typo regressions, low value).
- `isChannelEnabled` direct unit test (private function — exercised via 8 wrappers).
- New channel additions or schema changes.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. `NotificationPrefs` keys already include all 6 channels under test. T0 unit tests in `libs/shared/src/notifications.test.ts` (Plan 1N T1) already cover the resolver. Pure test addition in `apps/api`.

## 3. Production change

**없음.** `apps/api/src/push/send.ts` unchanged. Test-only.

## 4. Test additions — `apps/api/tests/push.send.test.ts`

Extend the existing `describe("channel gate (notificationPrefs)", ...)` block (currently 4 tests, lines 152-206) with **6 nested `describe` blocks (one per wrapper), 2 tests each**. **One commit.**

### Pattern per nested describe

```ts
describe("send<Wrapper>", () => {
  it("respects <channel>: false (no Expo call)", async () => {
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

  it("default prefs → Expo called once", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t" }]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[gate-<short>-on]", platform: "ios" },
    ]);

    const { send<Wrapper> } = await import("../src/push/send.js");
    await send<Wrapper>(testEnv(), u.id, /* wrapper-specific args */);

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
```

**Enabled-path pattern detail**: the enabled assertion uses `mockResolvedValueOnce([{ status: "ok", id: "t" }])` so the receipt-processing path doesn't throw on the empty default `[]` return. Matches the existing `sendBriefPush > one device — calls Expo once` test at `push.send.test.ts:62-76`.

### Per-wrapper invocations

| # | Wrapper | Channel | Disabled token short | Enabled token short | Args (both tests) |
|---|---|---|---|---|---|
| 1 | `sendBankReconnectPush` | `bankReconnect` | `gate-br-off` | `gate-br-on` | `"Chase"` |
| 2 | `sendTrialExpiringPush` | `trialExpiring` | `gate-te-off` | `gate-te-on` | `3` |
| 3 | `sendGoalMilestonePush` | `goalMilestones` | `gate-gm-off` | `gate-gm-on` | `"Emergency Fund", 50` |
| 4 | `sendTransactionAddedPush` | `transactionAdded` | `gate-ta-off` | `gate-ta-on` | `"Coffee", "5.50", "Food"` |
| 5 | `sendProductUpdatePush` | `productUpdates` | `gate-pu-off` | `gate-pu-on` | `"New feature", "Try it now"` |
| 6 | `sendWorkspaceInvitePush` | `workspaceInvites` | `gate-wi-off` | `gate-wi-on` | `"Alice", "Family"` |

### Setup/teardown — reused as-is

File header at `push.send.test.ts:1-51` already provides:
- `vi.mock("expo-server-sdk", ...)` at module scope (Expo class with prototype methods)
- `beforeEach(truncateAll)`, `afterEach(vi.restoreAllMocks)`, `afterAll(disconnect)`
- `makeUserWithDevices(tokens, notificationPrefs?)` helper accepting optional `notificationPrefs` (added in Plan 1N T3)

No helper changes. No new mock setup. No new `vi.mock` calls. No production code.

**Commit:** `test(api): push/send channel gate — 6 remaining sendXxxPush wrappers (12 tests)`

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

- 12 new tests pass (6 nested describes × 2 tests).
- All 10 existing `push.send.test.ts` tests still pass.
- Full `@fina/api` suite regression: 0 fail.
- Typecheck baseline unchanged.
- 1 commit, test-only.

## 7. Follow-ups (별도 plans)

- Payload-content assertions per wrapper (assert `dataType` + `title`/`body` formatting). Low priority — only catches formatting typos.
- HTTP route integration tests covering each wrapper's caller (e.g., POST /workspaces/{id}/invites firing `sendWorkspaceInvitePush`).
- Mobile `/notifications` UI screen tests.
- `NotificationPrefsSchema` PATCH validation tests (non-boolean values, malformed JSON).
