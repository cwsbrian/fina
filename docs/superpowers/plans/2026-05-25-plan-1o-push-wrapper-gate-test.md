# Plan 1O — Push wrapper channel-gate test coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add channel-gate test coverage for the 6 remaining `sendXxxPush` wrappers (12 tests total — disabled + enabled per wrapper), closing Plan 1N §7 follow-up.

**Architecture:** Pure test addition. Extend the existing `describe("channel gate (notificationPrefs)", ...)` block in `apps/api/tests/push.send.test.ts` with 6 nested describes — one per wrapper, each with one disabled-pref test (spy NOT called) and one default-pref test (spy called once). Reuse existing `makeUserWithDevices(tokens, notificationPrefs?)` helper and module-level `vi.mock("expo-server-sdk")` setup as-is.

**Tech Stack:** Vitest 2.x, prisma (real Postgres :5433), `vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")`, no shared lib changes, no production changes.

---

## File Structure

- **Modify:** `apps/api/tests/push.send.test.ts` — append 6 nested describes inside the existing `channel gate (notificationPrefs)` block (currently ends at line 206). No other file touched.

---

## Task 1: 6 wrappers × {disabled, enabled} — 12 tests

**Files:**
- Modify: `apps/api/tests/push.send.test.ts` (append before final `});` of channel-gate block at line 206)

- [ ] **Step 1: Read current state**

Run: `wc -l apps/api/tests/push.send.test.ts`
Expected: `206 apps/api/tests/push.send.test.ts`. Last meaningful line is `});` at 206 closing the `channel gate (notificationPrefs)` describe.

**Guardrail:** Do NOT edit `apps/api/src/push/send.ts` — production code stays unchanged. The pre-existing `logInfo` meta label `"trialExpiringPush"` on `send.ts:186` (vs channel key `"trialExpiring"`) is intentional out-of-scope cosmetic noise; leave it.

- [ ] **Step 2: Insert 6 nested describes inside `channel gate (notificationPrefs)`**

Locate the end of the last existing `it()` body — the line containing `expect(spy).toHaveBeenCalledTimes(1);` (around line 204) followed by `});` on the next line — and the OUTER `});` on line 206 that closes the `channel gate (notificationPrefs)` describe. Insert the 6 nested describes AFTER the last existing `it()`'s closing `});` and BEFORE the outer `});` on line 206.

Existing 4 sibling `it()` blocks in the channel-gate describe stay as-is (2-space indent, NOT nested in sub-describes). The 6 new nested describes use 2-space indent for `describe`, 4-space for `it`, 6-space for body — exactly as shown in the snippet.

```ts
  describe("sendBankReconnectPush", () => {
    it("respects bankReconnect: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-br-off]", platform: "ios" }],
        { bankReconnect: false },
      );

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-br" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-br-on]", platform: "ios" },
      ]);

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendTrialExpiringPush", () => {
    it("respects trialExpiring: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-te-off]", platform: "ios" }],
        { trialExpiring: false },
      );

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 3);

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-te-on]", platform: "ios" },
      ]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 3);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendGoalMilestonePush", () => {
    it("respects goalMilestones: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-gm-off]", platform: "ios" }],
        { goalMilestones: false },
      );

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Emergency Fund", 50);

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-gm-on]", platform: "ios" },
      ]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Emergency Fund", 50);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendTransactionAddedPush", () => {
    it("respects transactionAdded: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-ta-off]", platform: "ios" }],
        { transactionAdded: false },
      );

      const { sendTransactionAddedPush } = await import("../src/push/send.js");
      await sendTransactionAddedPush(testEnv(), u.id, "Coffee", "5.50", "Food");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-ta-on]", platform: "ios" },
      ]);

      const { sendTransactionAddedPush } = await import("../src/push/send.js");
      await sendTransactionAddedPush(testEnv(), u.id, "Coffee", "5.50", "Food");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendProductUpdatePush", () => {
    it("respects productUpdates: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-pu-off]", platform: "ios" }],
        { productUpdates: false },
      );

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "New feature", "Try it now");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-pu" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-pu-on]", platform: "ios" },
      ]);

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "New feature", "Try it now");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendWorkspaceInvitePush", () => {
    it("respects workspaceInvites: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-wi-off]", platform: "ios" }],
        { workspaceInvites: false },
      );

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-wi" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-wi-on]", platform: "ios" },
      ]);

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });
```

- [ ] **Step 3: Verify file structure**

Run: `grep -c "^  describe(" apps/api/tests/push.send.test.ts`
Expected: `6` (the 6 new nested describes; outer `channel gate` describe is at column 0).

Run: `grep -n "channel gate (notificationPrefs)" apps/api/tests/push.send.test.ts`
Expected: 1 match at line 152.

- [ ] **Step 4: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/push.send.test.ts`
Expected:
- Test Files: 1 passed
- Tests: **22 passed** (10 existing + 12 new)
- All 6 nested describes report 2 tests each

If FAIL: read error, fix the test that broke. Common failure modes:
- Wrong channel key spelling → check `libs/shared/src/notifications.ts` `NotificationPrefs` keys
- Wrong wrapper arg order/types → check `apps/api/src/push/send.ts` line 163-300
- Spy isolation leak → confirm `afterEach(vi.restoreAllMocks)` is present at line 28
- Mock import path → confirm `vi.mock("expo-server-sdk")` at line 12

- [ ] **Step 5: Full API suite regression check**

Run: `pnpm --filter @fina/api test 2>&1 | tail -30`
Expected:
- Existing baseline maintained (no NEW failures introduced)
- Any pre-existing flakes (e.g., me.test.ts known issues) acceptable as-is
- `push.send.test.ts: 22 passed` line visible

If a NON-push test newly fails, halt and report — likely unrelated drift; do not paper over.

- [ ] **Step 6: Typecheck regression**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit`
Expected: 0 errors. (apps/api has no `typecheck` npm script; tsc is invoked directly. `tsconfig.spec.json` includes the test files.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/tests/push.send.test.ts
git commit -m "$(cat <<'EOF'
test(api): push/send channel gate — 6 remaining sendXxxPush wrappers (12 tests)

Closes Plan 1N §7 follow-up. Adds disabled-channel + default-pref (enabled)
smoke assertions for sendBankReconnectPush, sendTrialExpiringPush,
sendGoalMilestonePush, sendTransactionAddedPush, sendProductUpdatePush,
sendWorkspaceInvitePush. 6 nested describes inside existing channel-gate
block. Pure test addition.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Expected: 1 file changed, ~155 insertions (12 tests × ~12 lines + describe wrappers).
