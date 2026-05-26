# Plan 1T — notifyTransactionAdded + sendTransactionAddedPush payload tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 9 tests covering R2 cross-cutting gaps: 6 for `notifyTransactionAdded` fan-out internals + 3 for `sendTransactionAddedPush` payload shape. 2 tasks, 2 commits.

**Architecture:** T1 uses partial `vi.mock("../src/push/send.js")` replacing `sendTransactionAddedPush` with `vi.fn` (Plan 1M precedent). T2 extends existing `push.send.test.ts` — uses the module-level `vi.mock("expo-server-sdk")` and per-test `vi.spyOn(Expo.prototype, ...)` already present in the file (Plan 1N precedent).

**Tech Stack:** Vitest 2.x, prisma, Expo SDK mock.

---

## File Structure

- **Create:** `apps/api/tests/push.transaction-added.test.ts` — Task 1.
- **Modify:** `apps/api/tests/push.send.test.ts` — Task 2 (append new describe block).

No production code changes.

---

## Task 1: `push.transaction-added.test.ts` (6 tests, 1 commit)

**Files:**
- Create: `apps/api/tests/push.transaction-added.test.ts`

- [x] **Step 1: Read precedent + production**

Read these:
- `apps/api/src/push/transaction-added.ts` (42 LOC) — full function. Note:
  - L22: `prisma.membership.findMany({where: {workspaceId}})` — NO role filter (fans out to viewer too — INTENTIONAL).
  - L27: `if (args.excludeUserId && m.userId === args.excludeUserId) continue` — actor skip.
  - L28-34: `await sendTransactionAddedPush(env, m.userId, args.merchant, args.amount.toFixed(2), args.categoryName)`.
  - L21-41: outer `try/catch` wraps for-loop — fail-stop on any throw (latent bug; pinned by test 5).
- `apps/api/tests/push.anomaly.test.ts:13-24` — partial vi.mock + clearAllMocks pattern.

**Guardrail:** Do NOT edit any production file. Test-only addition.

- [x] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { notifyTransactionAdded } from "../src/push/transaction-added.js";
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

describe("notifyTransactionAdded", () => {
  // 6 tests below
});
```

**6 test bodies:**

**Test 1 — no members:**
```ts
  it("workspace with 0 memberships → no push", async () => {
    const ws = await prisma.workspace.create({
      data: { id: `nta-empty-${Date.now()}`, name: "Empty WS", currency: "CAD" },
    });
    await notifyTransactionAdded(env, {
      workspaceId: ws.id,
      merchant: "Coffee",
      amount: 5.5,
      categoryName: "Food",
    });
    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 2 — 1 member, no exclude:**
```ts
  it("1 member, no excludeUserId → push called with toFixed(2) amount", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds[0]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Coffee",
      amount: 5.5,
      categoryName: "Food",
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, ownerId, "Coffee", "5.50", "Food"]);
  });
```

**Test 3 — owner+editor+viewer, exclude owner (actor):**
```ts
  it("owner+editor+viewer + excludeUserId=owner → 2 pushes (editor+viewer, NOT viewer-filtered)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds[0]!;
    const editorId = userIds[1]!;
    const viewerId = userIds[2]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Restaurant",
      amount: 50,
      categoryName: null,
      excludeUserId: ownerId,
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(2);
    // Viewer IS notified (intentional — read-only members want awareness).
    expect(calls.map((c) => c[1]).sort()).toEqual([editorId, viewerId].sort());
  });
```

**Test 4 — excludeUserId matches none:**
```ts
  it("excludeUserId matches no member → all notified", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor"]);
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Shop",
      amount: 10,
      categoryName: null,
      excludeUserId: "user-not-in-workspace",
    });
    const calls = vi.mocked(sendMod.sendTransactionAddedPush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([...userIds].sort());
  });
```

**Test 5 — fail-stop on push throw:**
```ts
  it("first push throws → loop exits, 2nd member NOT attempted, error swallowed", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner", "editor"]);
    vi.mocked(sendMod.sendTransactionAddedPush).mockRejectedValueOnce(new Error("boom"));

    // Should NOT throw.
    await expect(
      notifyTransactionAdded(env, {
        workspaceId: wsId,
        merchant: "X",
        amount: 1,
        categoryName: null,
      }),
    ).resolves.toBeUndefined();

    // Fail-stop semantics: 2nd member never attempted.
    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(1);
  });
```

**Test 6 — solo actor (common case):**
```ts
  it("solo owner is the actor (excludeUserId=ownerId) → 0 pushes", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds[0]!;
    await notifyTransactionAdded(env, {
      workspaceId: wsId,
      merchant: "Bookstore",
      amount: 25,
      categoryName: "Books",
      excludeUserId: ownerId,
    });
    expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(0);
  });
```

- [x] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/push.transaction-added.test.ts`
Expected: `Tests  6 passed (6)`.

- [x] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "push.transaction-added" | head -5`
Expected: 0 lines.

- [x] **Step 5: Commit**

Branch confirmation: `git branch --show-current` must show `worktree-plan-1t-notify-transaction-added-test`.

```bash
git add apps/api/tests/push.transaction-added.test.ts
git commit -m "$(cat <<'EOF'
test(api): notifyTransactionAdded — 6 tests covering fan-out + exclude + error containment + solo actor

Closes R2 cross-cutting review gap #1 part 1/2. Pins viewer-inclusion as
intentional (vs anomaly/goal-milestones owner-editor filter). Pins fail-stop
semantics — see plan §7 for the latent bug follow-up.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `push.send.test.ts` extension (3 tests, 1 commit)

**Files:**
- Modify: `apps/api/tests/push.send.test.ts` (append new describe block AFTER existing `channel gate (notificationPrefs)` block)

- [ ] **Step 1: Read existing file structure**

Read `apps/api/tests/push.send.test.ts` end-to-end (~22 tests currently). Note:
- Module-level `vi.mock("expo-server-sdk")` at lines 12-25 — defines Expo class with prototype `sendPushNotificationsAsync` returning `[]`.
- `afterEach(vi.restoreAllMocks)` at line 28 — restores per-test prototype spies.
- `makeUserWithDevices(tokens, notificationPrefs?)` helper at lines 31-51 — creates User + UserDevice rows.
- Existing channel-gate block closes around line 386 with `});`. Insert new describe AFTER that closing `});` (sibling-level).

`sendTransactionAddedPush` (production at `send.ts:245-263`):
- Builds title `${merchant} · $${amount}` and body `New transaction${where}` where `where = categoryName ? \` · ${categoryName}\` : ""`.
- Calls `sendToUserDevices(env, userId, {title, body, dataType: "transaction-added"})`.
- `sendToUserDevices` builds carrier message with `data: { type: payload.dataType }`, `priority: "high"`, `sound: "default"`.

- [ ] **Step 2: Append new describe block**

Locate the closing `});` of the `channel gate (notificationPrefs)` block. Insert AFTER that closing brace (sibling of `describe("channel gate ...")` and `describe("sendBriefPush")`):

```ts
describe("sendTransactionAddedPush payload shape", () => {
  it("title='$merchant · $$amount', body='New transaction · category', dataType='transaction-added'", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-1" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-1]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Starbucks", "5.50", "Coffee");

    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    expect(chunk).toHaveLength(1);
    const msg = chunk[0]!;
    expect(msg).toEqual(expect.objectContaining({
      title: "Starbucks · $5.50",
      body: "New transaction · Coffee",
      data: { type: "transaction-added" },
    }));
  });

  it("categoryName=null → body='New transaction' (no category suffix)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-2" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-2]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Anon Shop", "1.00", null);

    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    const msg = chunk[0]!;
    expect(msg).toEqual(expect.objectContaining({
      title: "Anon Shop · $1.00",
      body: "New transaction",
    }));
  });

  it("priority='high', sound='default' (regression guard against payload defaults change)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-3" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-3]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Test", "1.00", null);

    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    const msg = chunk[0]!;
    expect(msg).toEqual(expect.objectContaining({
      priority: "high",
      sound: "default",
    }));
  });
});
```

- [ ] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/push.send.test.ts`
Expected: `Tests  25 passed (25)` (22 existing + 3 new).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "push.send" | head -5`
Expected: 0 lines.

- [ ] **Step 5: Commit**

```bash
git add apps/api/tests/push.send.test.ts
git commit -m "$(cat <<'EOF'
test(api): push/send — sendTransactionAddedPush payload-shape coverage (3 tests)

Closes R2 cross-cutting review gap #1 part 2/2. Pins title/body/dataType
format strings + priority/sound payload defaults. Catches typo regressions
in this wrapper specifically.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
