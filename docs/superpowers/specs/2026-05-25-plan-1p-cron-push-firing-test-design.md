# Plan 1P-cron-push-firing-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1O (channel-gate coverage for 6 sendXxxPush wrappers). Closes the caller→callee loop — Plan 1P tests the 2 cron jobs that fire those wrappers.

## 1. Goal & scope

Two daily cron jobs that push notifications currently have **zero** test coverage:

| File | LOC | Wrapper called | Branches |
|---|---|---|---|
| `apps/api/src/cron/jobs/trial-expiring.ts` | 56 | `sendTrialExpiringPush` | no-candidates / consumed-filter / expired / no-threshold-match / already-pushed / 5d / 3d / 1d |
| `apps/api/src/cron/jobs/goal-milestones.ts` | 61 | `sendGoalMilestonePush` | no-goals / archived / target≤0 / no-milestone / already-notified / fan-out / lastMilestonePct-update |

Add **18 tests** across 2 commits (9 per cron — 8 happy-path + 1 error-path). Test the cron logic (filter predicate, threshold gating, state update, error containment) — NOT the wrappers (already covered by Plan 1N/1O) and NOT the savings computation (separate concern, BUT signature-pinned in 1 test).

**Out of scope:**
- `computeGoalSavings` correctness — its own gap; mocked in this plan so the cron's milestone-crossing logic can be tested in isolation. **One T2 test pins the `(workspaceId, goalId)` call signature** via `vi.mocked(computeGoalSavings).mock.calls[0]` assertion — guards against rename / arg-order drift.
- `push-receipts.ts` — different concern (Expo receipt API polling); separate plan.
- `scheduled-spend-match.ts` — already mocked in `cron.scheduler.test.ts` (registration only); cron logic itself deferred.
- Scheduler-registration tests — `cron.scheduler.test.ts` mocks 5 jobs (daily-refresh, retry-unprocessed, cleanup-events, scheduled-spend-match, daily-brief); `trial-expiring` + `goal-milestones` are NOT registered there yet. Plan 1P tests the job functions directly; registration follow-up is a separate plan.
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
| 9 | daysLeft = 5, push throws (`mockRejectedValueOnce(new Error("boom"))`) | logError called; `lastTrialPushDays` STILL null (no state mutation on failure) |

Set `trialEndsAt` precisely: `new Date(Date.now() + dayCount * 86_400_000 - 3_600_000)` (subtract 1 HOUR so `Math.ceil` lands cleanly on `dayCount` with generous margin against slow test suites; updated from initial 1-minute offset per R2 review).

**Commit:** `test(api): cron/trial-expiring — 9 tests covering threshold gating + state + error containment`

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
| 5 | target=100, saved=30 (pct=30), prev=null | 30 | 1 call(env, ownerId, title, 25); DB `lastMilestonePct=25`. **Also assert `computeGoalSavings.mock.calls[0] === [g.workspaceId, g.id]`** — signature pin per R2 review. |
| 6 | target=100, saved=60 (pct=60), prev=50 | 60 | 1 call with pct=50 (50 is the *first* milestone the for-find loop returns where pct≥50 — `MILESTONES = [100,75,50,25]` searches 100 first, then 75, then 50; pct=60 matches at index 2 → 50). DB `lastMilestonePct=50` |
| 7 | owner+editor+viewer, target=100, saved=100 | 100 | 2 calls (viewer excluded). Assert via Plan 1M precedent: `calls.map(c => c[1]).sort()` matches `[ownerId, editorId].sort()`. Both calls have pct=100. |
| 8 | target=100, saved=60, lastMilestonePct=75 | 60 | 0 calls (`crossed=50 <= previous=75` → already notified) |
| 9 | target=100, saved=100, push throws | 100 | logError called; DB `lastMilestonePct` STILL null (no state mutation on failure). One goal's failure does NOT halt iteration over other goals — assert via 2nd goal that succeeds. |

**Note on test 6 reasoning**: `MILESTONES.find((m) => pct >= m)` — `find` returns the FIRST array element matching, and the array is `[100, 75, 50, 25]`. So for pct=60: 100 fails, 75 fails, 50 matches → returns 50. Verify by reading `goal-milestones.ts:34`.

**Note on Goal schema**: `dueDate DateTime @db.Date` is **REQUIRED** (not nullable) per `schema.prisma:478`. Helper must pass `dueDate: new Date()` or similar. Spec author initially had this wrong (called it `targetDate`, marked nullable) — corrected per R1 review.

**Commit:** `test(api): cron/goal-milestones — 9 tests covering threshold gating + fan-out + error containment`

## 5. Risks

| Risk | Mitigation |
|---|---|
| `Math.ceil(msLeft/86400000)` boundary — at exactly `dayCount * 86_400_000` ms, ceil returns `dayCount`. Offsetting by **-3_600_000ms (1 hour)** ensures we land cleanly inside the threshold band with safety margin against slow test runs (R2 review increased from initial 60_000ms). | Helper docstring + arithmetic per test row. |
| `prisma.user.create` requires only `{id, email, name}` minimum — verified Plan 1M precedent. trial fields all have defaults except `trialEndsAt` (nullable). | Helper sets explicitly. |
| `prisma.goal.create` schema — `workspaceId`, `title`, `targetAmount` (Decimal), **`dueDate` (REQUIRED, @db.Date)**, `archivedAt` (nullable), `lastMilestonePct` (nullable). R1 review caught the misnamed/wrongly-nullable field. | Helper passes `dueDate: new Date(Date.now() + 30 * 86_400_000)` (30d future). |
| `vi.clearAllMocks` vs `restoreAllMocks` — partial mock pattern requires `clearAllMocks` to preserve the replaced export across tests. | Spec §4 mock pattern explicit. Verified per Plan 1M. |
| `computeGoalSavings` mock — need to assert it's CALLED with `(workspaceId, goalId)`. Spec uses `mockResolvedValueOnce` per test → re-mocking each test ensures isolation. | Plan §4 T2 pattern. |
| Fan-out across owner+editor+viewer — verify viewer is excluded. | Test 7 explicitly seeds 3 roles, asserts 2 calls. |
| TZ-sensitivity in `daysLeft` arithmetic — `msLeft = trialEndsAt.getTime() - Date.now()` is UTC; no tz involved. | Out of scope, no risk. |
| Email uniqueness across 16 tests in singleFork | `Date.now() + userCounter` global ensures uniqueness across both test files when run sequentially. |

## 6. Success criteria

- T1: 9 new tests pass.
- T2: 9 new tests pass.
- Full `@fina/api` suite regression: 0 NEW fails (pre-existing baseline failures acceptable).
- Typecheck baseline (currently 119 errors, all in unrelated tests) unchanged.
- 2 commits, one per task.

## 7. Follow-ups (별도 plans)

- `push-receipts.ts` cron — Expo receipt polling, ticket state machine, ~10 tests.
- `computeGoalSavings` directly — competitor allocation algorithm, complex but ungated by this plan.
- `scheduled-spend-match.ts` cron — auto-match logic.
- HTTP integration: cron-fired pushes assert via mocking layer end-to-end.
