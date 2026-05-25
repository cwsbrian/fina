# Plan 1P-cron-push-firing-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1O (channel-gate coverage for 6 sendXxxPush wrappers). Closes the caller→callee loop — Plan 1P tests the 2 cron jobs that fire those wrappers.

## 1. Goal & scope

Two daily cron jobs that push notifications currently have **zero** test coverage:

| File | LOC | Wrapper called | Branches |
|---|---|---|---|
| `apps/api/src/cron/jobs/trial-expiring.ts` | 56 | `sendTrialExpiringPush` | no-candidates / consumed-filter / expired / no-threshold-match / already-pushed / 5d / 3d / 1d |
| `apps/api/src/cron/jobs/goal-milestones.ts` | 61 | `sendGoalMilestonePush` | no-goals / archived / target≤0 / no-milestone / already-notified / fan-out / lastMilestonePct-update |

Add ~16 tests across 2 commits. Test the cron logic (filter predicate, threshold gating, state update) — NOT the wrappers (already covered by Plan 1N/1O) and NOT the savings computation (separate concern).

**Out of scope:**
- `computeGoalSavings` correctness — its own gap; mocked in this plan so the cron's milestone-crossing logic can be tested in isolation.
- `push-receipts.ts` — different concern (Expo receipt API polling); separate plan.
- `scheduled-spend-match.ts` — already invoked in `cron.scheduler.test.ts`; deferred.
- Scheduler-registration tests (`cron.scheduler.test.ts` already covers both crons via `vi.mock`).
- Timezone edge cases on `daysLeft` computation — Plan 1P uses UTC msLeft arithmetic only.

## 2. Shared library touchpoints

**없음.** Both cron jobs consume internal API (`@fina/api`-only). `THRESHOLDS` ([5,3,1]) and `MILESTONES` ([100,75,50,25]) are file-local consts; no consumer outside the cron. Pure test addition in `apps/api`.

## 3. Production change

**없음.** No edits to `trial-expiring.ts`, `goal-milestones.ts`, `goals/savings.ts`, or `push/send.ts`.

## 4. Test files

### T1 — `apps/api/tests/cron.trial-expiring.test.ts` (new, 8 tests)

**Mock pattern**: partial `vi.mock("../src/push/send.js", ...)` replacing `sendTrialExpiringPush` with `vi.fn().mockResolvedValue({ sent: 0, failed: 0 })`. Other exports preserved via `...actual`. `afterEach(vi.clearAllMocks)` — NOT `restoreAllMocks` (would restore the real wrapper, breaking subsequent tests in singleFork mode). Plan 1M precedent (`push.anomaly.test.ts:50-70`).

```ts
import { afterEach, beforeEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

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
```

**Helper** — minimal user fixture:
```ts
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
      id, email: `${id}@t.co`, name: `Trial ${userCounter}`,
      trialEndsAt: opts.trialEndsAt,
      trialConsumed: opts.trialConsumed ?? false,
      lastTrialPushDays: opts.lastTrialPushDays ?? null,
    },
  });
  return id;
}
```

**8 test scenarios:**

| # | Setup | Expected |
|---|---|---|
| 1 | No users → run | 0 push calls |
| 2 | trialEndsAt past (msLeft < 0) | 0 calls |
| 3 | trialConsumed: true, trialEndsAt 3d future | 0 calls (filtered by query) |
| 4 | daysLeft = 4 (no threshold match) | 0 calls |
| 5 | daysLeft = 5, lastTrialPushDays: null → push | 1 call(env, userId, 5); DB `lastTrialPushDays === 5` |
| 6 | daysLeft = 5, lastTrialPushDays: 5 | 0 calls (already pushed) |
| 7 | daysLeft = 3, lastTrialPushDays: 5 → push | 1 call(env, userId, 3); DB updated to 3 |
| 8 | daysLeft = 1 (final 24h) → push | 1 call(env, userId, 1); DB updated to 1 |

Set `trialEndsAt` precisely: `new Date(Date.now() + dayCount * 86_400_000 - 60_000)` (subtract 1 minute so `Math.ceil` lands exactly on `dayCount`).

**Commit:** `test(api): cron/trial-expiring — 8 tests covering threshold gating + state`

### T2 — `apps/api/tests/cron.goal-milestones.test.ts` (new, 8 tests)

**Mock pattern**: BOTH `sendGoalMilestonePush` AND `computeGoalSavings` mocked via partial vi.mock. The cron's milestone-crossing logic depends on the returned savings; we control it directly per test rather than seeding 5-table allocation graphs.

```ts
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
    computeGoalSavings: vi.fn(),  // per-test override via mockResolvedValueOnce
  };
});
```

**Helpers** — workspace + goal + memberships:
```ts
async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{ wsId: string; userIds: string[] }> { /* ... */ }

async function createGoal(opts: {
  workspaceId: string;
  title?: string;
  targetAmount: number;
  lastMilestonePct?: number | null;
  archivedAt?: Date | null;
}): Promise<string> { /* ... */ }
```

**8 test scenarios:**

| # | Setup | Mocked savings | Expected |
|---|---|---|---|
| 1 | No goals | — | 0 calls |
| 2 | Goal archived | n/a (filtered) | 0 calls |
| 3 | targetAmount=0 | irrelevant | 0 calls (`continue`) |
| 4 | target=100, saved=20 (pct=20) | 20 | 0 calls (no milestone) |
| 5 | target=100, saved=30 (pct=30), prev=null | 30 | 1 call(env, ownerId, title, 25); DB `lastMilestonePct=25` |
| 6 | target=100, saved=60 (pct=60), prev=50 | 60 | 1 call with pct=50 (50 is the *first* milestone the for-find loop returns where pct≥50 — `MILESTONES = [100,75,50,25]` searches 100 first, then 75, then 50; pct=60 matches at index 2 → 50). DB `lastMilestonePct=50` |
| 7 | owner+editor+viewer, target=100, saved=100 | 100 | 2 calls (viewer excluded by `role: in [owner, editor]`); both with pct=100 |
| 8 | target=100, saved=60, lastMilestonePct=75 | 60 | 0 calls (`crossed=50 <= previous=75` → already notified) |

**Note on test 6 reasoning**: `MILESTONES.find((m) => pct >= m)` — `find` returns the FIRST array element matching, and the array is `[100, 75, 50, 25]`. So for pct=60: 100 fails, 75 fails, 50 matches → returns 50. Verify by reading `goal-milestones.ts:34`.

**Commit:** `test(api): cron/goal-milestones — 8 tests covering threshold gating + fan-out`

## 5. Risks

| Risk | Mitigation |
|---|---|
| `Math.ceil(msLeft/86400000)` boundary — at exactly `dayCount * 86_400_000` ms, ceil returns `dayCount`. Offsetting by -60_000ms ensures we land cleanly inside the threshold band. | Helper docstring + arithmetic per test row. |
| `prisma.user.create` requires only `{id, email, name}` minimum — verified Plan 1M precedent. trial fields all have defaults except `trialEndsAt` (nullable). | Helper sets explicitly. |
| `prisma.goal.create` schema — `workspaceId`, `title`, `targetAmount` (Decimal), `targetDate` (nullable), `archivedAt` (nullable), `lastMilestonePct` (nullable). | Helper passes the required minimum. |
| `vi.clearAllMocks` vs `restoreAllMocks` — partial mock pattern requires `clearAllMocks` to preserve the replaced export across tests. | Spec §4 mock pattern explicit. Verified per Plan 1M. |
| `computeGoalSavings` mock — need to assert it's CALLED with `(workspaceId, goalId)`. Spec uses `mockResolvedValueOnce` per test → re-mocking each test ensures isolation. | Plan §4 T2 pattern. |
| Fan-out across owner+editor+viewer — verify viewer is excluded. | Test 7 explicitly seeds 3 roles, asserts 2 calls. |
| TZ-sensitivity in `daysLeft` arithmetic — `msLeft = trialEndsAt.getTime() - Date.now()` is UTC; no tz involved. | Out of scope, no risk. |
| Email uniqueness across 16 tests in singleFork | `Date.now() + userCounter` global ensures uniqueness across both test files when run sequentially. |

## 6. Success criteria

- T1: 8 new tests pass.
- T2: 8 new tests pass.
- Full `@fina/api` suite regression: 0 NEW fails (pre-existing baseline failures acceptable).
- Typecheck baseline (currently 119 errors, all in unrelated tests) unchanged.
- 2 commits, one per task.

## 7. Follow-ups (별도 plans)

- `push-receipts.ts` cron — Expo receipt polling, ticket state machine, ~10 tests.
- `computeGoalSavings` directly — competitor allocation algorithm, complex but ungated by this plan.
- `scheduled-spend-match.ts` cron — auto-match logic.
- HTTP integration: cron-fired pushes assert via mocking layer end-to-end.
