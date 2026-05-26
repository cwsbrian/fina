# Plan 1U — fail-stop fix + factories + 7 wrapper payloads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Production fix for fail-stop fan-out bug in 3 helpers + test contract updates + factories.ts extraction + 7-wrapper payload-shape coverage. 4 tasks, 4 commits.

**Architecture:**
- T1 adds per-recipient try/catch around `await sendXxxPush(...)` in `transaction-added.ts`, `anomaly.ts`, `goal-milestones.ts`. Updates Plan 1T test 5 + Plan 1P test 9 to match new semantics. Adds test 10 to cover the still-live per-goal catch path.
- T2 extracts `apps/api/tests/helpers/factories.ts` and migrates 4 newer test files.
- T3 adds payload-shape tests for the 7 remaining wrappers via a new `firstPushMessage(spy)` helper.
- T4 closeout — optional inline design-intent comment in `transaction-added.ts:26`.

**Tech Stack:** Vitest 2.x, prisma, real Postgres, partial vi.mock patterns.

---

## File Structure

- **Modify (prod, T1)**: `apps/api/src/push/transaction-added.ts`, `apps/api/src/push/anomaly.ts`, `apps/api/src/cron/jobs/goal-milestones.ts`.
- **Modify (test, T1)**: `apps/api/tests/push.transaction-added.test.ts`, `apps/api/tests/cron.goal-milestones.test.ts`.
- **Create (T2)**: `apps/api/tests/helpers/factories.ts`.
- **Modify (T2)**: `apps/api/tests/push.transaction-added.test.ts`, `apps/api/tests/cron.goal-milestones.test.ts`, `apps/api/tests/cron.push-receipts.test.ts`, `apps/api/tests/push.send.test.ts`.
- **Modify (T3)**: `apps/api/tests/push.send.test.ts` (append new describe + helper).
- **Modify (T4, optional)**: inline comments only.

---

## Task 1: Production fix + test contract updates (1 commit)

**Files:**
- Modify: `apps/api/src/push/transaction-added.ts` (lines 26-35)
- Modify: `apps/api/src/push/anomaly.ts` (lines 87-95)
- Modify: `apps/api/src/cron/jobs/goal-milestones.ts` (lines 43-45)
- Modify: `apps/api/tests/push.transaction-added.test.ts` (test 5)
- Modify: `apps/api/tests/cron.goal-milestones.test.ts` (test 9 + ADD test 10)

- [x] **Step 1: Read production + tests**

Read all 5 files to understand the current shape. Note especially:
- `transaction-added.ts`: outer try/catch at L21-41. For-loop L26-35. Inner await L28-34.
- `anomaly.ts`: outer try L31-101. Fan-out for-loop L87-95.
- `goal-milestones.ts`: outer for-loop over goals at L28; inner try/catch per goal L29-59; fan-out L43-45; `lastMilestonePct` update L46-49 AFTER fan-out.
- `push.transaction-added.test.ts:115`: test 5 `mockRejectedValueOnce(boom)` + `expect(...).toHaveBeenCalledTimes(1)`.
- `cron.goal-milestones.test.ts` (around L195-209): test 9 with `mockRejectedValueOnce(boom).mockResolvedValue(...)` + order-agnostic state assertion.

- [x] **Step 2: Apply production fix to `transaction-added.ts`**

Edit `apps/api/src/push/transaction-added.ts` for-loop. Replace:
```ts
    for (const m of members) {
      if (args.excludeUserId && m.userId === args.excludeUserId) continue;
      await sendTransactionAddedPush(
        env,
        m.userId,
        args.merchant,
        args.amount.toFixed(2),
        args.categoryName,
      );
    }
```
With:
```ts
    for (const m of members) {
      if (args.excludeUserId && m.userId === args.excludeUserId) continue;
      try {
        await sendTransactionAddedPush(
          env,
          m.userId,
          args.merchant,
          args.amount.toFixed(2),
          args.categoryName,
        );
      } catch (err) {
        logError(
          { workspaceId: args.workspaceId, recipientUserId: m.userId, err },
          "transaction-added push to recipient failed",
        );
      }
    }
```

- [x] **Step 3: Apply production fix to `anomaly.ts`**

Edit `apps/api/src/push/anomaly.ts` for-loop at lines 87-95. Replace:
```ts
    for (const m of memberships) {
      await sendLargeChargePush(
        env,
        m.userId,
        args.merchant ?? "An unusual charge",
        args.amount.toFixed(2),
        categoryName,
      );
    }
```
With:
```ts
    for (const m of memberships) {
      try {
        await sendLargeChargePush(
          env,
          m.userId,
          args.merchant ?? "An unusual charge",
          args.amount.toFixed(2),
          categoryName,
        );
      } catch (err) {
        logError(
          { transactionId: args.transactionId, recipientUserId: m.userId, err },
          "large-charge push to recipient failed",
        );
      }
    }
```

- [x] **Step 4: Apply production fix to `goal-milestones.ts`**

Edit `apps/api/src/cron/jobs/goal-milestones.ts` for-loop at lines 43-45. Replace:
```ts
      for (const m of memberships) {
        await sendGoalMilestonePush(env, m.userId, g.title, crossed);
      }
```
With:
```ts
      for (const m of memberships) {
        try {
          await sendGoalMilestonePush(env, m.userId, g.title, crossed);
        } catch (err) {
          logError(
            { cron: CRON_NAME, goalId: g.id, recipientUserId: m.userId, err },
            "goal-milestone push to recipient failed",
          );
        }
      }
```

- [x] **Step 5: Update Plan 1T test 5 in `push.transaction-added.test.ts`**

Find the existing test 5:
```ts
  it("first push throws → loop exits, 2nd member NOT attempted, error swallowed", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    vi.mocked(sendMod.sendTransactionAddedPush).mockRejectedValueOnce(new Error("boom"));

    await expect(
      notifyTransactionAdded(env, { workspaceId: wsId, merchant: "X", amount: 1, categoryName: null }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(1);
  });
```

Replace with (rename + body changes + logError spy):
```ts
  it("first push throws → caught + logged, 2nd member still attempted (per-recipient containment)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    const logErrorSpy = vi.spyOn(loggerMod, "logError");
    vi.mocked(sendMod.sendTransactionAddedPush).mockRejectedValueOnce(new Error("boom"));

    await expect(
      notifyTransactionAdded(env, { workspaceId: wsId, merchant: "X", amount: 1, categoryName: null }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(2);
    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ recipientUserId: expect.any(String) }),
      expect.stringContaining("recipient"),
    );
  });
```

Also add the import at the top of the file (near the other imports):
```ts
import * as loggerMod from "../src/logger.js";
```

- [x] **Step 6: Update Plan 1P test 9 in `cron.goal-milestones.test.ts`**

Find the existing test 9 (around lines 195-210). The current body uses order-agnostic state sort. Replace the assertion block:
```ts
    // Before:
    const states = [a.lastMilestonePct, b.lastMilestonePct].sort(
      (x, y) => (x ?? -1) - (y ?? -1),
    );
    expect(states).toEqual([null, 100]);

    // After:
    // Per-recipient containment — even though one push threw, BOTH goal.update
    // calls fire because the inner catch lets the per-member loop complete.
    expect(a.lastMilestonePct).toBe(100);
    expect(b.lastMilestonePct).toBe(100);
```

Update the `it()` title from "push throws on one goal → logError + iteration continues to the other" to "push throws on one goal → caught + iteration continues, BOTH goals advance".

- [x] **Step 7: ADD test 10 to `cron.goal-milestones.test.ts`**

Insert AFTER the modified test 9. This pins the still-live per-goal catch path:
```ts
  it("computeGoalSavings throws on goal A → per-goal catch + iteration continues to goal B", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    const goalA = await createGoal({ workspaceId: wsId, title: "A", targetAmount: 100 });
    const goalB = await createGoal({ workspaceId: wsId, title: "B", targetAmount: 100 });

    vi.mocked(savingsMod.computeGoalSavings)
      .mockRejectedValueOnce(new Error("DB hiccup"))
      .mockResolvedValue(100);

    await expect(runGoalMilestones(env)).resolves.not.toThrow();

    // Goal A's per-goal catch fired BEFORE the fan-out — no push, no update.
    // Goal B processed normally — 1 push + state advanced.
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(1);

    // Order-agnostic: one goal advanced, one didn't.
    const [a, b] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: goalA } }),
      prisma.goal.findUniqueOrThrow({ where: { id: goalB } }),
    ]);
    const states = [a.lastMilestonePct, b.lastMilestonePct].sort(
      (x, y) => (x ?? -1) - (y ?? -1),
    );
    expect(states).toEqual([null, 100]);
  });
```

- [x] **Step 8: Run affected tests**

Run: `pnpm --filter @fina/api exec vitest run tests/push.transaction-added.test.ts tests/cron.goal-milestones.test.ts tests/push.anomaly.test.ts`
Expected:
- `push.transaction-added.test.ts`: 6/6 (test 5 still passes with new contract)
- `cron.goal-milestones.test.ts`: 10/10 (test 9 updated + test 10 new)
- `push.anomaly.test.ts`: 8/8 (no contract change — anomaly's outer try/catch still works for non-push errors)

- [x] **Step 9: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep -E "push.transaction-added|cron.goal-milestones|push.anomaly|transaction-added\.ts|anomaly\.ts|goal-milestones\.ts" | head -10`
Expected: 0 lines.

Also: `pnpm --filter @fina/api exec tsc -p tsconfig.app.json --noEmit 2>&1 | head -10`
Expected: baseline unchanged (production source typechecks).

- [x] **Step 10: Commit**

Branch confirmation: `git branch --show-current` must show `worktree-plan-1u-failstop-fix-and-coverage`.

```bash
git add apps/api/src/push/transaction-added.ts apps/api/src/push/anomaly.ts apps/api/src/cron/jobs/goal-milestones.ts apps/api/tests/push.transaction-added.test.ts apps/api/tests/cron.goal-milestones.test.ts
git commit -m "$(cat <<'EOF'
fix(push): per-recipient try/catch in 3 fan-out helpers + update test contracts

Closes R2 cross-cutting review follow-up (fail-stop bug). Per-recipient
try/catch in notifyTransactionAdded, checkLargeChargeAndPush, runGoalMilestones
ensures a transient DB error on one member's send doesn't drop the tail of
the fan-out.

Test contracts updated to match new semantics:
- push.transaction-added test 5: 1 → 2 calls; assert logError fires with
  recipientUserId metadata.
- cron.goal-milestones test 9: [null, 100] → [100, 100]; both goal.update
  calls fire because per-recipient catch lets the loop complete.
- cron.goal-milestones test 10 (NEW): computeGoalSavings throws on goal A
  → per-goal catch still fires → goalA state preserved, goalB advances.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extract `tests/helpers/factories.ts` + migrate (1 commit)

**Files:**
- Create: `apps/api/tests/helpers/factories.ts`
- Modify: `apps/api/tests/push.transaction-added.test.ts` (replace inline `createUser`/`setupWorkspaceWithRoles` with imports)
- Modify: `apps/api/tests/cron.goal-milestones.test.ts` (replace inline helpers with imports)
- Modify: `apps/api/tests/push.send.test.ts` (replace `makeUserWithDevices` with import)
- **NOT modified** (per R2 review): `apps/api/tests/cron.push-receipts.test.ts` — tight User+Device+Ticket fixture coupling; defer to Plan 1V era.

- [x] **Step 1: Create `factories.ts`**

```ts
import { prisma } from "../../src/db.js";

let counter = 0;

export async function createTestUser(prefix = "u"): Promise<string> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `${prefix}-${Date.now()}-${counter}`,
      email: `${prefix}-${Date.now()}-${counter}@t.co`,
      name: `Test ${prefix} ${counter}`,
    },
  });
  return u.id;
}

export async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
  prefix = "w",
): Promise<{ wsId: string; userIds: string[] }> {
  counter++;
  const ws = await prisma.workspace.create({
    data: {
      id: `${prefix}-${Date.now()}-${counter}`,
      name: `Test WS ${counter}`,
      currency: "CAD",
    },
  });
  const userIds: string[] = [];
  for (const role of roles) {
    const userId = await createTestUser(`${prefix}-u`);
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    userIds.push(userId);
  }
  return { wsId: ws.id, userIds };
}

export async function createTestCategory(wsId: string, name = "Test Cat"): Promise<string> {
  counter++;
  const c = await prisma.category.create({
    data: { workspaceId: wsId, name: `${name} ${counter}` },
  });
  return c.id;
}

/** Returns the Prisma User object (callers do `u.id`).
 *  Optional notificationPrefs JSON merged in via update. */
export async function makeUserWithDevices(
  tokens: Array<{ token: string; platform: "ios" | "android" }>,
  notificationPrefs?: Record<string, boolean>,
): Promise<import("@prisma/client").User> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `dev-u-${Date.now()}-${counter}`,
      email: `dev-${Date.now()}-${counter}@t.co`,
      name: `Dev User ${counter}`,
    },
  });
  for (const t of tokens) {
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: t.token, platform: t.platform },
    });
  }
  if (notificationPrefs) {
    return await prisma.user.update({
      where: { id: u.id },
      data: { notificationPrefs },
    });
  }
  return u;
}
```

- [x] **Step 2: Migrate `push.transaction-added.test.ts`**

Remove the inline `createUser` (lines ~25-35) + `setupWorkspaceWithRoles` (lines ~37-53) + the `counter` global. Replace with:
```ts
import { setupWorkspaceWithRoles } from "./helpers/factories.js";
```

Update each `setupWorkspaceWithRoles(roles)` call to use the imported version — signatures match.

- [x] **Step 3: Migrate `cron.goal-milestones.test.ts`**

Same migration: remove inline helpers, import from factories.js. Update calls to use `setupWorkspaceWithRoles`. Note: existing helper returned `{ wsId, userIds: Record<...> }` — factory returns `{ wsId, userIds: string[] }`. Update call sites that used `userIds.owner` to use `userIds[0]!`, etc.

This is the LARGEST migration in T2 — careful with helper-shape change. Trace each call site:
- `userIds.owner` → `userIds[0]!` (always exists when "owner" is in roles)
- `userIds.editor` → `userIds[1]!` (when "editor" is 2nd in roles)
- `userIds.viewer` → `userIds[2]!`

- [x] **Step 4: SKIP `cron.push-receipts.test.ts` migration** (per R2 review)

This file's `createUserDevice` + `createTicket` + `mockReceipts` helpers form a tight User+Device+Ticket fixture trio with 11+ call sites and structural divergence (createUserDevice returns just `deviceId`, factory returns `User`). Migrating creates churn without test improvement.

**Decision**: keep `cron.push-receipts.test.ts` inline helpers as-is. Migrate during Plan 1V era when this file is next touched. T2's scope is now **3 test files**, not 4.

- [x] **Step 5: Migrate `push.send.test.ts`**

The `makeUserWithDevices` helper at lines 31-51 is identical to the factories version. Replace with:
```ts
import { makeUserWithDevices } from "./helpers/factories.js";
```

No call-site changes needed — signature matches.

- [x] **Step 6: Run all affected tests**

Run: `pnpm --filter @fina/api exec vitest run tests/push.transaction-added.test.ts tests/cron.goal-milestones.test.ts tests/push.send.test.ts`
Expected: all pass (counts: 6 + 10 + 25 = 41). cron.push-receipts.test.ts unchanged in T2 (10 tests still pass independently).

- [x] **Step 7: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep -E "factories|push.send|push.transaction|cron.goal" | head -10`
Expected: 0 lines.

- [x] **Step 8: Commit**

```bash
git add apps/api/tests/helpers/factories.ts apps/api/tests/push.transaction-added.test.ts apps/api/tests/cron.goal-milestones.test.ts apps/api/tests/push.send.test.ts
git commit -m "$(cat <<'EOF'
refactor(api/tests): extract tests/helpers/factories.ts + migrate 3 test files

createTestUser, setupWorkspaceWithRoles, createTestCategory, makeUserWithDevices
extracted to apps/api/tests/helpers/factories.ts. 3 newer test files migrated
(push.transaction-added, cron.goal-milestones, push.send). cron.push-receipts
deferred (tight User+Device+Ticket fixture coupling). Older Plan 1L-1M tests
stay until next touch.

Net LOC reduction across migrated files. No behavior change.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Payload-shape coverage for 7 remaining wrappers (1 commit)

**Files:**
- Modify: `apps/api/tests/push.send.test.ts` (append helper + new describe block)

- [x] **Step 1: Read current state**

Verify push.send.test.ts ends after the `sendTransactionAddedPush payload shape` describe block from Plan 1T (around line 454). New tests go AFTER it.

- [x] **Step 2: Add `firstPushMessage(spy)` helper**

**Prereq**: T2 commit must be landed (provides the `makeUserWithDevices` factory import that T3 tests use).

Add this import immediately after the existing `import { describe, expect, it, ... } from "vitest"` line at the top of `push.send.test.ts` (R2 review verified that `MockInstance` is NOT currently imported):
```ts
import type { MockInstance } from "vitest";
```

Then add the helper function near the top of the file (after the `makeUserWithDevices` import from factories — itself added in T2):
```ts
function firstPushMessage(spy: MockInstance): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const firstCall = calls[0]!;
  const chunk = firstCall[0] as Array<Record<string, unknown>>;
  expect(chunk.length).toBeGreaterThan(0);
  return chunk[0]!;
}
```

- [x] **Step 3: Append 7-wrapper payload-shape describe block**

After the existing `describe("sendTransactionAddedPush payload shape", ...)` block, add:

```ts
describe("payload-shape coverage for remaining wrappers", () => {
  describe("sendBriefPush", () => {
    it("title='Fina ☀️', dataType='daily-brief', body passthrough", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-br-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[brief-1]", platform: "ios" }]);

      const { sendBriefPush } = await import("../src/push/send.js");
      await sendBriefPush(testEnv(), u.id, "Yesterday looked normal.");

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Fina ☀️",
        body: "Yesterday looked normal.",
        data: { type: "daily-brief" },
      }));
    });
  });

  describe("sendBankReconnectPush", () => {
    it("title + body + dataType pinned", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-bk-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[brc-1]", platform: "ios" }]);

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Reconnect your bank",
        body: "Chase stopped syncing. Open Fina to reconnect.",
        data: { type: "bank-reconnect" },
      }));
    });
  });

  describe("sendTrialExpiringPush", () => {
    it("daysLeft=1 → 'Your trial ends tomorrow'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[te-1]", platform: "ios" }]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 1);

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Your trial ends tomorrow",
        data: { type: "trial-expiring" },
      }));
    });

    it("daysLeft=5 → 'Your trial ends in 5 days'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te-2" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[te-2]", platform: "ios" }]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 5);

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Your trial ends in 5 days",
        data: { type: "trial-expiring" },
      }));
    });
  });

  describe("sendGoalMilestonePush", () => {
    it("pct=100 → 'Goal complete: <title>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[gm-1]", platform: "ios" }]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Vacation", 100);

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Goal complete: Vacation",
        body: "Nice. Open Fina to see what's next.",
        data: { type: "goal-milestone" },
      }));
    });

    it("pct<100 → '<pct>% there on <title>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm-2" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[gm-2]", platform: "ios" }]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Vacation", 50);

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "50% there on Vacation",
        body: "Keep going. Tap to see what's funding it.",
        data: { type: "goal-milestone" },
      }));
    });
  });

  describe("sendLargeChargePush", () => {
    it("title='Unusual charge: $<amount>', body with category", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-lc-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[lc-1]", platform: "ios" }]);

      const { sendLargeChargePush } = await import("../src/push/send.js");
      await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Unusual charge: $200.00",
        body: "Best Buy for Electronics is well above your usual.",
        data: { type: "large-charge" },
      }));
    });

    it("categoryName=null → body without ' for <category>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-lc-2" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[lc-2]", platform: "ios" }]);

      const { sendLargeChargePush } = await import("../src/push/send.js");
      await sendLargeChargePush(testEnv(), u.id, "Anon", "100.00", null);

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Unusual charge: $100.00",
        body: "Anon is well above your usual.",
      }));
    });
  });

  describe("sendProductUpdatePush", () => {
    it("title/body passthrough, dataType='product-update'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-pu-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[pu-1]", platform: "ios" }]);

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "What's new in Fina", "Try the new chat!");

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "What's new in Fina",
        body: "Try the new chat!",
        data: { type: "product-update" },
      }));
    });
  });

  describe("sendWorkspaceInvitePush", () => {
    it("title='Workspace invite', body templated, dataType='workspace-invite'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-wi-1" }]);
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[wi-1]", platform: "ios" }]);

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family Budget");

      expect(firstPushMessage(spy)).toEqual(expect.objectContaining({
        title: "Workspace invite",
        body: "Alice invited you to Family Budget.",
        data: { type: "workspace-invite" },
      }));
    });
  });
});
```

- [x] **Step 4: Run push.send.test.ts**

Run: `pnpm --filter @fina/api exec vitest run tests/push.send.test.ts`
Expected: 25 + 9 = **34 passed** (Plan 1T 3 + 7 wrappers' 9).

- [x] **Step 5: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "push.send" | head -5`
Expected: 0 lines.

- [x] **Step 6: Commit**

```bash
git add apps/api/tests/push.send.test.ts
git commit -m "$(cat <<'EOF'
test(api): payload-shape coverage for 7 remaining sendXxxPush wrappers

Closes R2 cross-cutting review follow-up #3. firstPushMessage(spy) helper
dedupes chunk-indexing pattern. Nested describe block per wrapper:
sendBriefPush, sendBankReconnectPush, sendTrialExpiringPush (1d + 5d branches),
sendGoalMilestonePush (100% + <100%), sendLargeChargePush (with/without
category), sendProductUpdatePush, sendWorkspaceInvitePush. Total 9 tests.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Closeout + design-intent comment (1 commit)

**Files:**
- Modify: `apps/api/src/push/transaction-added.ts` (1-line comment near line 26)

- [x] **Step 1: Add design-intent comment to all 3 files** (per R2 review — make decision concrete)

Add this 2-line comment ABOVE the inner `try` introduced in T1 in all 3 production files (`transaction-added.ts`, `anomaly.ts`, `goal-milestones.ts`):
```ts
// Per-recipient try/catch: a transient error on one member must NOT
// drop the tail of the fan-out (per Plan 1U).
```

Keep verbatim — `git add` step lists all 3 files.

- [ ] **Step 2: Full suite regression**

Run: `pnpm --filter @fina/api test 2>&1 | tail -20`
Expected: full API suite passes (no NEW fails beyond pre-existing baseline).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/push/transaction-added.ts apps/api/src/push/anomaly.ts apps/api/src/cron/jobs/goal-milestones.ts
git commit -m "$(cat <<'EOF'
docs(push): inline design-intent comment for per-recipient try/catch (Plan 1U)

Surfaces the design choice to future maintainers: a transient error on one
recipient must not drop the tail of the fan-out. Pinned by Plan 1U test 5
(push.transaction-added), test 9 + 10 (cron.goal-milestones).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
