# Plan 1T-notify-transaction-added-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1S (HTTP→push integration). Closes cross-cutting review (R2) gap #1.

## 1. Goal & scope

R2 post-merge review identified 2 remaining gaps in the push subsystem:

1. **`notifyTransactionAdded` helper** at `apps/api/src/push/transaction-added.ts` (42 LOC) — membership fan-out + `excludeUserId` skip + try/catch swallow. Plan 1S verified the HTTP layer CALLS it; the helper's internals are untested.
2. **`sendTransactionAddedPush` payload shape** — Plan 1N tests `sendBriefPush` end-to-end through `sendToUserDevices`, but the other 7 wrappers' specific `title`/`body`/`dataType` formatting is untested (only the channel-gate Plan 1O verified).

Add **2 tasks** in 2 commits:
- **T1**: `tests/push.transaction-added.test.ts` (new) — **6 tests** for `notifyTransactionAdded` internals (R2 added "solo actor" common case).
- **T2**: extend `tests/push.send.test.ts` — 3 payload-shape tests for `sendTransactionAddedPush` (pins `title`, `body`, `dataType` format strings against accidental edits).

**Intentional design note (R2 review)**: `notifyTransactionAdded` notifies **all roles** (owner + editor + viewer) — unlike `goal-milestones` and `anomaly` which filter to owner+editor. This is **intentional**: read-only viewers still want awareness of spending activity. Do NOT "fix" via consistency PR.

**Out of scope:**
- Payload-shape tests for the other 6 wrappers (`sendBankReconnectPush`, `sendTrialExpiringPush`, etc.) — same code path, low marginal value. T2's spot-check of `sendTransactionAddedPush` proves the wrappers can vary independently.
- `sendToUserDevices` internal-function direct tests (`Expo.isExpoPushToken` filter, malformed-token skip, chunk loop, ticket dispatch) — already covered by Plan 1N's `sendBriefPush` tests in `push.send.test.ts`.
- Plaid-sync → anomaly integration (`daily-refresh.ts:108`) — separate Plan 1U candidate.
- `webhook-item.ts:35 sendBankReconnectPush` integration — separate Plan 1U candidate.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. Pure test addition.

## 3. Production change

**없음.** `transaction-added.ts` and `send.ts` unchanged.

## 4. Test files

### T1 — `apps/api/tests/push.transaction-added.test.ts` (new, 5 tests)

**Mock pattern**: partial `vi.mock("../src/push/send.js", ...)` replacing `sendTransactionAddedPush` with `vi.fn().mockResolvedValue({sent: 0, failed: 0})`. Other exports preserved via `...actual`. `afterEach(vi.clearAllMocks)`. Plan 1M precedent.

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendTransactionAddedPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });
```

**Helpers**: inline `createUser`, `createWorkspace`, `createMembership` — same shape as Plan 1P's `setupWorkspaceWithRoles` (will be extracted post-1T per R1 review recommendation).

```ts
let counter = 0;

async function createUser(): Promise<string> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `nta-u-${Date.now()}-${counter}`,
      email: `nta-${Date.now()}-${counter}@t.co`,
      name: `NTA User ${counter}`,
    },
  });
  return u.id;
}

async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{ wsId: string; userIds: string[] }> {
  counter++;
  const ws = await prisma.workspace.create({
    data: { id: `nta-w-${Date.now()}-${counter}`, name: `NTA WS ${counter}`, currency: "CAD" },
  });
  const userIds: string[] = [];
  for (const role of roles) {
    const userId = await createUser();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    userIds.push(userId);
  }
  return { wsId: ws.id, userIds };
}
```

**5 test scenarios:**

| # | Setup | Expected |
|---|---|---|
| 1 | Workspace with NO memberships | `sendTransactionAddedPush` called 0 times. |
| 2 | 1 member + no `excludeUserId` | Called once. Args: `(env, ownerId, "Coffee", "5.50", "Food")`. `amount.toFixed(2)` → string. |
| 3 | 3 members (owner, editor, viewer) + `excludeUserId = ownerId` | Called 2 times. `calls.map(c => c[1]).sort()` = `[editorId, viewerId].sort()`. (Note: notifyTransactionAdded does NOT filter by role — sends to ALL non-excluded members regardless of role, unlike anomaly/goal which filter to owner+editor.) |
| 4 | 3 members + `excludeUserId` matches NONE (random uuid not in workspace) | Called 3 times. All members notified. |
| 5 | 2 members. `vi.mocked(sendMod.sendTransactionAddedPush).mockRejectedValueOnce(new Error("boom"))` — first call rejects, fallback resolves. | Called 1 time (first only — loop exits when send throws; outer try/catch swallows). **Test pins fail-stop semantics — see §7 follow-up about latent bug**. |
| 6 | **Solo actor (common case)**: 1 member who IS the only owner, `excludeUserId = ownerId`. | Called 0 times. Manual-tx-by-solo-workspace-owner correctly skips self-notify. |

**Note on test 5**: the production try/catch wraps the ENTIRE for-loop including the per-user sends. If one `sendTransactionAddedPush` rejects, the catch fires and the loop ends. This is "fail-stop" semantics, NOT per-user error containment. Test 5 pins this behavior. The same pattern exists in `anomaly.ts` and `goal-milestones.ts` — R2 review flagged this as a latent bug (transient DB error drops tail members from the fan-out). See §7 for the follow-up.

**Commit:** `test(api): notifyTransactionAdded — 6 tests covering fan-out + exclude + error containment + solo actor`

### T2 — `apps/api/tests/push.send.test.ts` extension (3 payload-shape tests)

Append to the existing `describe("channel gate (notificationPrefs)", ...)` block OR add a new sibling describe `describe("sendTransactionAddedPush payload shape", () => {})` for clarity.

**Mock pattern**: reuse the existing `vi.mock("expo-server-sdk")` factory at file top. Per-test `vi.spyOn(Expo.prototype, "sendPushNotificationsAsync")` captures the payload. Same as Plan 1O.

**3 test scenarios:**

| # | Setup | Expected |
|---|---|---|
| 1 | 1 UserDevice + default prefs. Call `sendTransactionAddedPush(env, u.id, "Starbucks", "5.50", "Coffee")`. | Spy called once. The first arg (chunk array) contains 1 message with: `title === "Starbucks · $5.50"`, `body === "New transaction · Coffee"`, `data.type === "transaction-added"`. |
| 2 | Same but with `categoryName = null`. | Message has `body === "New transaction"` (no category suffix). |
| 3 | Verify `priority: "high"` and `sound: "default"` are set (regression guard against accidental removal in payload defaults). | Message has `priority === "high"`, `sound === "default"`. |

**Note**: these tests use the EXISTING `makeUserWithDevices` helper. Add to a new `describe("sendTransactionAddedPush payload shape", () => {...})` block placed AFTER the existing `channel gate` block.

**Commit:** `test(api): push/send — sendTransactionAddedPush payload-shape coverage (3 tests)`

## 5. Risks

| Risk | Mitigation |
|---|---|
| `transaction-added.ts` does NOT filter by role (sends to all members) — production reality. Plan 1S notifyTransactionAdded test asserted `excludeUserId: ownerId` matches "all OTHER members". | T1 test 3 explicitly seeds owner+editor+viewer and asserts viewer IS included (just not the excluded actor). |
| `amount.toFixed(2)` — production at `transaction-added.ts:32` formats `args.amount` (number). T1 test 2 passes `5.5` (number) → expects `"5.50"`. | Helper arg uses literal `5.5`. |
| Production try/catch is at the FUNCTION level — one push throw halts the loop, NOT per-iteration containment. | T1 test 5 explicitly pins this behavior. |
| T2 payload-shape assertions — production string template at `send.ts:74-78` and wrapper at `send.ts:258-262`. Brittle to format changes. | Acceptable — that IS the contract this plan locks. Format changes should require updating these tests. |
| T2 assertion via spy.mock.calls — chunk is array of 1 message. Plan: `expect(spy).toHaveBeenCalledTimes(1); const calls = spy.mock.calls; const firstCall = calls[0]!; const chunk = firstCall[0] as Array<unknown>; const msg = chunk[0]; expect(msg).toEqual(expect.objectContaining({title, body, data, priority, sound}));` Non-null assertion `!` on `calls[0]` is sound because we asserted `toHaveBeenCalledTimes(1)` first. | Spec documents this exact indexing pattern under `noUncheckedIndexedAccess`. |
| Singleton `counter` module global in T1 — Plan 1Q precedent shows this is safe under `truncateAll` per beforeEach. | Helper declares `let counter = 0` at module scope. |
| Helper `setupWorkspaceWithRoles` duplicates Plan 1P. R1 review flagged this. | Acknowledged. Extract to `tests/helpers/factories.ts` in a separate refactor PR (not this plan). |

## 6. Success criteria

- T1: 6 new tests pass.
- T2: 3 new tests pass (push.send.test.ts goes from 22 to 25 tests).
- Full `@fina/api` suite regression: 0 new fails.
- Typecheck baseline unchanged.
- 2 commits, test-only.

## 7. Follow-ups (별도 plans)

- **Latent bug — fail-stop fan-out**: `notifyTransactionAdded`, `anomaly.checkLargeChargeAndPush`, `goal-milestones.runGoalMilestones` all share the "outer try/catch wraps the entire for-loop" pattern. A transient DB error or unhandled rejection on member 1 silently halts pushes to members 2..N. Consider per-iteration try/catch in fan-out helpers. Plan 1T pins current behavior as the contract — fix is a separate decision.
- **Plan 1U (R2 #2-4)**: Plaid-sync→anomaly integration (`daily-refresh.ts:108`), Plaid webhook→sendBankReconnect (`webhook-item.ts:35`), `scheduled-spend-match` cron behavior.
- **`tests/helpers/factories.ts` extraction** (R1 review): `createTestUser`, `createTestWorkspace`, `setupWorkspaceWithRoles`, `createTestCategory`. Migrate 3 newest files; rest stay until they need a touch.
- **Brittleness fixes** (R2 review): `goals.savings.test.ts` proration assertions → `toBeCloseTo`; `http.push-integration.test.ts` tuple assertions → `calls[0]?.[1]` style.
- **Payload-shape tests for the other 6 wrappers** — low priority (catches typos only).
