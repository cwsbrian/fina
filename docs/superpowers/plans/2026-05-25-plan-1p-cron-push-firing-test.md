# Plan 1P — Cron push-firing test coverage (trial-expiring + goal-milestones)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add direct-function-call test coverage for `runTrialExpiring` and `runGoalMilestones` cron jobs. 18 tests across 2 commits. Closes Plan 1O caller→callee follow-up.

**Architecture:** Partial `vi.mock` replaces `sendXxxPush` + `computeGoalSavings` with `vi.fn()` so cron logic is tested in isolation against real Postgres. `afterEach(vi.clearAllMocks)` preserves the mocked exports across tests. Plan 1M `push.anomaly.test.ts` is the verbatim precedent.

**Tech Stack:** Vitest 1.x, prisma (real Postgres :5433), partial `vi.mock` with `importOriginal + ...actual` spread.

---

## File Structure

- **Create:** `apps/api/tests/cron.trial-expiring.test.ts` — Task 1.
- **Create:** `apps/api/tests/cron.goal-milestones.test.ts` — Task 2.

No edits to production code. No edits to `@fina/shared`.

---

## Task 1: `cron.trial-expiring.test.ts` (9 tests)

**Files:**
- Create: `apps/api/tests/cron.trial-expiring.test.ts`

- [ ] **Step 1: Read precedent**

Read `apps/api/tests/push.anomaly.test.ts` lines 1-70 — note the `vi.mock(..., importOriginal)` partial-spread pattern and `afterEach(vi.clearAllMocks)`. Read `apps/api/src/cron/jobs/trial-expiring.ts` end-to-end (56 LOC). Understand the THRESHOLDS=[5,3,1] gate.

**Guardrail:** Do NOT edit `apps/api/src/cron/jobs/trial-expiring.ts` or `apps/api/src/push/send.ts` — production code is unchanged.

- [ ] **Step 2: Create the test file**

Write the file with this header (verbatim):

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
    sendTrialExpiringPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

let userCounter = 0;

async function createTrialUser(opts: {
  trialEndsAt: Date | null;
  trialConsumed?: boolean;
  lastTrialPushDays?: number | null;
}): Promise<string> {
  userCounter++;
  const id = `te-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@t.co`,
      name: `Trial ${userCounter}`,
      trialEndsAt: opts.trialEndsAt,
      trialConsumed: opts.trialConsumed ?? false,
      lastTrialPushDays: opts.lastTrialPushDays ?? null,
    },
  });
  return id;
}

/** Build a trialEndsAt that places daysLeft exactly at `dayCount` after
 *  Math.ceil. Subtract 1 hour so the ceil rounds up cleanly. */
function trialEndsAtForDaysLeft(dayCount: number): Date {
  return new Date(Date.now() + dayCount * 86_400_000 - 3_600_000);
}

describe("runTrialExpiring", () => {
  // 9 tests below
});
```

Then add the 9 `it()` blocks below inside the describe:

**Test 1 — no candidates:**
```ts
  it("no candidates → no push", async () => {
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 2 — trial already expired:**
```ts
  it("trialEndsAt in the past → no push", async () => {
    await createTrialUser({ trialEndsAt: new Date(Date.now() - 86_400_000) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 3 — trialConsumed:true filters out:**
```ts
  it("trialConsumed=true → filtered out by query", async () => {
    await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(3),
      trialConsumed: true,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 4 — daysLeft=4 no threshold:**
```ts
  it("daysLeft=4 (no threshold) → no push", async () => {
    await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(4) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 5 — daysLeft=5 first push:**

**TypeScript note** (per R2 review): `mock.calls[0]` is `tuple | undefined` under `noUncheckedIndexedAccess` (this repo has it). Destructure to keep TS happy:

```ts
  it("daysLeft=5, never pushed → push + lastTrialPushDays=5", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(5) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 5]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(5);
  });
```

**Test 6 — daysLeft=5 already pushed:**
```ts
  it("daysLeft=5, lastTrialPushDays=5 → no push (already sent)", async () => {
    await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(5),
      lastTrialPushDays: 5,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });
```

**Test 7 — daysLeft=3 lastPushed=5 → push for new threshold:**
```ts
  it("daysLeft=3, lastTrialPushDays=5 → push + lastTrialPushDays=3", async () => {
    const userId = await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(3),
      lastTrialPushDays: 5,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 3]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(3);
  });
```

**Test 8 — daysLeft=1 final 24h:**
```ts
  it("daysLeft=1 (final 24h) → push + lastTrialPushDays=1", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(1) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 1]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(1);
  });
```

**Test 9 — error path (state-leak prevention):**
```ts
  it("push throws → logError, no state mutation", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(5) });
    vi.mocked(sendMod.sendTrialExpiringPush).mockRejectedValueOnce(new Error("boom"));
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);  // does NOT throw — catch swallows
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(1);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBeNull();  // state NOT advanced on failure
  });
```

- [ ] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/cron.trial-expiring.test.ts`
Expected: `Tests  9 passed (9)`.

If FAIL: read first error, fix one test, rerun. Common gotchas:
- `Date.now()` drift across the await between `trialEndsAtForDaysLeft` and `runTrialExpiring` → if drift > 1h, daysLeft slips. Unlikely but possible on heavily loaded CI.
- `vi.clearAllMocks` not restoring the mock — that's intentional; `clearAllMocks` clears call history, NOT the implementation.
- `mockRejectedValueOnce` not propagating — verify `vi.mocked()` returns the spy.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "cron.trial-expiring" | head -5`
Expected: 0 lines (no errors in the new file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/tests/cron.trial-expiring.test.ts
git commit -m "$(cat <<'EOF'
test(api): cron/trial-expiring — 9 tests covering threshold gating + state + error containment

Closes Plan 1O caller→callee follow-up part 1/2. Partial vi.mock for
sendTrialExpiringPush; cron logic tested in isolation against real DB.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Branch confirmation: `git branch --show-current` must show `worktree-plan-1p-cron-push-firing-test`, NOT `main`.

---

## Task 2: `cron.goal-milestones.test.ts` (9 tests)

**Files:**
- Create: `apps/api/tests/cron.goal-milestones.test.ts`

- [ ] **Step 1: Read precedent + production code**

Read `apps/api/src/cron/jobs/goal-milestones.ts` end-to-end (61 LOC). Note: `MILESTONES = [100, 75, 50, 25] as const` is DESCENDING. `MILESTONES.find(m => pct >= m)` returns the **first** match — for pct=60, returns 50 (because [100,75 fail, 50 matches]). For pct=80, returns 75. For pct=100, returns 100.

Read `apps/api/src/goals/savings.ts:91` — confirm `computeGoalSavings(workspaceId: string, goalId: string): Promise<number>`.

Read `apps/api/prisma/schema.prisma` lines around `model Goal` (around line 470) — confirm `dueDate DateTime @db.Date` is REQUIRED.

**Guardrail:** Do NOT edit `apps/api/src/cron/jobs/goal-milestones.ts`, `apps/api/src/goals/savings.ts`, or `apps/api/src/push/send.ts`.

- [ ] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";
import * as savingsMod from "../src/goals/savings.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendGoalMilestonePush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

vi.mock("../src/goals/savings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goals/savings.js")>();
  return {
    ...actual,
    computeGoalSavings: vi.fn(),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

let userCounter = 0;
let wsCounter = 0;

async function createUser(): Promise<string> {
  userCounter++;
  const id = `gm-u-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: { id, email: `${id}@t.co`, name: `GM User ${userCounter}` },
  });
  return id;
}

async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{ wsId: string; userIds: Record<"owner" | "editor" | "viewer", string | undefined> }> {
  wsCounter++;
  const ws = await prisma.workspace.create({
    data: { id: `gm-w-${Date.now()}-${wsCounter}`, name: `GM WS ${wsCounter}`, currency: "CAD" },
  });
  const userIds: Record<"owner" | "editor" | "viewer", string | undefined> = {
    owner: undefined, editor: undefined, viewer: undefined,
  };
  for (const role of roles) {
    const userId = await createUser();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    userIds[role] = userId;
  }
  return { wsId: ws.id, userIds };
}

async function createGoal(opts: {
  workspaceId: string;
  title?: string;
  targetAmount: number;
  lastMilestonePct?: number | null;
  archivedAt?: Date | null;
}): Promise<string> {
  const g = await prisma.goal.create({
    data: {
      workspaceId: opts.workspaceId,
      title: opts.title ?? "Test Goal",
      targetAmount: new Prisma.Decimal(opts.targetAmount),
      dueDate: new Date(Date.now() + 30 * 86_400_000),  // 30d future
      lastMilestonePct: opts.lastMilestonePct ?? null,
      archivedAt: opts.archivedAt ?? null,
    },
  });
  return g.id;
}

describe("runGoalMilestones", () => {
  // 9 tests below
});
```

Then add the 9 `it()` blocks below:

**Test 1 — no goals:**
```ts
  it("no goals → no push", async () => {
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });
```

**Test 2 — archived goal:**
```ts
  it("archived goal → filtered out by query", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({
      workspaceId: wsId, targetAmount: 100,
      archivedAt: new Date(Date.now() - 86_400_000),
    });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });
```

**Test 3 — targetAmount=0:**
```ts
  it("targetAmount=0 → continue (no push)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 0 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });
```

**Test 4 — pct<25 no milestone:**
```ts
  it("saved=20 of 100 (pct=20) → no milestone crossed", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(20);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });
```

**Test 5 — pct=30 first milestone + signature pin:**
```ts
  it("saved=30 of 100, prev=null → push at pct=25 + signature pinned", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds.owner!;  // helper guarantees owner exists when in roles array
    const goalId = await createGoal({ workspaceId: wsId, title: "Vacation", targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(30);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    const pushCalls = vi.mocked(sendMod.sendGoalMilestonePush).mock.calls;
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toEqual([env, ownerId, "Vacation", 25]);

    // Signature pin per R2 review — guards against rename / arg-order drift.
    const savingsCalls = vi.mocked(savingsMod.computeGoalSavings).mock.calls;
    expect(savingsCalls[0]).toEqual([wsId, goalId]);

    const fresh = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(fresh.lastMilestonePct).toBe(25);
  });
```

**Test 6 — pct=60 prev=50 → milestone=50:**
```ts
  it("saved=60 of 100, prev=50 → push at pct=50 (first MILESTONES match)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const goalId = await createGoal({ workspaceId: wsId, targetAmount: 100, lastMilestonePct: 50 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(60);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    // MILESTONES=[100,75,50,25].find(m=>60>=m) → 50 (first match).
    // crossed=50 vs previous=50 → 50 <= 50 means "already notified" → SKIP.
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(fresh.lastMilestonePct).toBe(50);  // unchanged
  });
```

**Test 7 — fan-out across owner+editor (exclude viewer):**
```ts
  it("owner+editor+viewer + saved=100 → 2 pushes (viewer excluded)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds.owner!;
    const editorId = userIds.editor!;
    await createGoal({ workspaceId: wsId, title: "Done", targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    const calls = vi.mocked(sendMod.sendGoalMilestonePush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([ownerId, editorId].sort());
    // Both calls carry pct=100
    expect(calls.every((c) => c[3] === 100)).toBe(true);
  });
```

**Test 8 — already notified at higher milestone:**
```ts
  it("saved=60, lastMilestonePct=75 → no push (crossed=50 <= 75)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 100, lastMilestonePct: 75 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(60);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });
```

**Test 9 — error path containment + iteration continues (order-agnostic per R2):**
```ts
  it("push throws on one goal → logError + iteration continues to the other", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    const goalA = await createGoal({ workspaceId: wsId, title: "A", targetAmount: 100 });
    const goalB = await createGoal({ workspaceId: wsId, title: "B", targetAmount: 100 });

    // Both goals report saved=100 → both should cross 100% milestone.
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);

    // First push throws, subsequent pushes succeed. (Which goal is "first"
    // depends on findMany's scan order — we don't assume.)
    vi.mocked(sendMod.sendGoalMilestonePush)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ sent: 0, failed: 0 });

    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);  // does NOT throw

    // Both goals attempted (push called for both).
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(2);

    // Exactly one goal's state was advanced; the other was preserved.
    // Order-agnostic assertion — robust to Postgres scan-order shifts.
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

- [ ] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/cron.goal-milestones.test.ts`
Expected: `Tests  9 passed (9)`.

If FAIL: read first error. Common gotchas:
- `prisma.goal.create` missing `dueDate` → check helper.
- `Prisma.Decimal` import path → `import { Prisma } from "@prisma/client"`.
- `computeGoalSavings` mock not returning → use `mockResolvedValue`, not `mockReturnValue` (it's async).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "cron.goal-milestones" | head -5`
Expected: 0 lines.

- [ ] **Step 5: Full file run together — verify no leak between T1 and T2**

Run: `pnpm --filter @fina/api exec vitest run tests/cron.trial-expiring.test.ts tests/cron.goal-milestones.test.ts`
Expected: `Tests  18 passed (18)`. Mock isolation across files verified.

- [ ] **Step 6: Commit**

```bash
git add apps/api/tests/cron.goal-milestones.test.ts
git commit -m "$(cat <<'EOF'
test(api): cron/goal-milestones — 9 tests covering threshold gating + fan-out + error containment

Closes Plan 1O caller→callee follow-up part 2/2. Partial vi.mock for
sendGoalMilestonePush + computeGoalSavings; cron logic + member fan-out
tested in isolation. Test #5 pins computeGoalSavings call signature.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

Branch confirmation: `git branch --show-current` must show `worktree-plan-1p-cron-push-firing-test`.
