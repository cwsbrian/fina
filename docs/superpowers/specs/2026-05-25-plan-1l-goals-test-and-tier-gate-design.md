# Plan 1L-goals-test-and-tier-gate Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1K-cleanup-test-baseline (shipped `07ba65c`) restored green baseline. Now adding coverage to an untested area + closing a tier-gate gap.

## 1. Goal & scope

`apps/api/src/routes/goals.ts` (273 lines, 6 routes) currently has **zero test coverage** despite active recent development (commits `82bcfbd`, `c1e3c64`, `c30b99e`, etc.). This plan:

1. **Adds Pro-tier gate to 3 LLM-touching routes** (POST create / PATCH update / POST strategy). User decision: free tier reads + deletes goals; Pro-only for create/modify operations because both auto-create and update flow through `generateAndStoreGoalStrategy`.
2. **Tightens `CreateGoalBody.dueDate` + `PatchGoalBody.dueDate` validation** to require ≥ 1 calendar month from today (user request). 31→28/30 day overflows clamp to last day of target month.
3. **Adds comprehensive test suite** (`apps/api/tests/goals.routes.test.ts`, ~24 tests): per-route auth / role / tier / validation / workspace-mismatch / happy-path / cross-workspace isolation.

**Route Pro-gate matrix:**
| Route | Method | Path | Tier gate |
|---|---|---|---|
| List | GET | `/workspaces/:id/goals` | free |
| Detail | GET | `/workspaces/:id/goals/:goalId` | free |
| Create | POST | `/workspaces/:id/goals` | **Pro-only** (auto-triggers LLM strategy) |
| Update | PATCH | `/workspaces/:id/goals/:goalId` | **Pro-only** (user-explicit: modifications are Pro) |
| Strategy regen | POST | `/workspaces/:id/goals/:goalId/strategy` | **Pro-only** (explicit LLM regen) |
| Delete | DELETE | `/workspaces/:id/goals/:goalId` | free (user-explicit: cleanup must work) |

**Cron impact**: `goal-milestones` (daily 10:10 UTC) calls pure `computeGoalSavings` — no LLM, no DB writes to goals — free tier continues to get milestone notifications on existing goals. **Zero change.**

**Out of scope:**
- `computeGoalSavings` unit tests (`apps/api/src/goals/savings.ts`, 226 lines) — separate plan.
- `generateAndStoreGoalStrategy` integration test (Gemini prompt engineering) — separate plan.
- `goal-milestones` cron tests — separate plan.
- Mobile UI Pro-gate enforcement — already handled via trial-end locked screen (user confirmed).

## 2. Shared library touchpoints

**`libs/shared/src/schemas/goals.ts`** — extend `CreateGoalBody.dueDate` + `PatchGoalBody.dueDate` with refine for "≥ 1 calendar month from today":

```ts
import { z } from "zod";

const GOAL_TITLE_MAX_LEN = 80;
const GOAL_DESCRIPTION_MAX_LEN = 280;
const GOAL_MAX_AMOUNT = 9_999_999.99;

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Minimum due date: today + 1 calendar month (UTC). Overflow guard: e.g.
 *  Jan 31 + 1m → Feb 31 → Mar 3 (JS auto-rolls). Clamp to last day of
 *  intended target month so the user-visible rule stays "next month, same
 *  day or last day of that month if shorter". */
export function minDueDateOneMonthUTC(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const t = new Date(Date.UTC(y, m + 1, d, 0, 0, 0, 0));
  if (t.getUTCMonth() !== (m + 1) % 12) {
    t.setUTCDate(0);  // clamp to last day of intended target month
  }
  return t;
}

const DueDateMinOneMonth = DateOnly.refine(
  (s) => {
    const dueDate = new Date(`${s}T00:00:00.000Z`);
    return dueDate.getTime() >= minDueDateOneMonthUTC().getTime();
  },
  { message: "dueDate must be at least 1 calendar month from today" },
);

export const CreateGoalBody = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
  targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT),
  savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
  dueDate: DueDateMinOneMonth,
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchGoalBody = z
  .object({
    title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
    targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
    dueDate: DueDateMinOneMonth.optional(),
    icon: z.string().max(40).optional().nullable(),
    color: z.string().max(20).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .strict();
```

`minDueDateOneMonthUTC` exported so other consumers (mobile UI date picker) can use the same source of truth for the minimum date.

**`libs/shared/src/index.ts`**: 변경 없음. `export * from "./schemas/goals.js"` already exists from prior commits (verify with `grep "schemas/goals" libs/shared/src/index.ts`); wildcard auto-flows the new export.

**No other shared changes.** No new DTO, no new error codes (reuses `invalid_body`, `upgrade_required`, `not_found`, `workspace_mismatch`).

**CLAUDE.md rule**: shared changes commit first (T1), production + test consumer commits second (T2, T3).

## 3. Production change — Pro-gate on goals.ts

3 routes get the gate inserted **AFTER** the workspace-mismatch check (mirrors `budget-plans.ts:170-178` + `budgets.ts:37-41,90-94` existing pattern — verified via R2). Order: `requireWorkspaceContext` → `workspace_mismatch` 400 → `effectiveTier` → `upgrade_required` 402 → handler body.

This ordering means a Free-tier user with a wsId mismatch still gets `400 workspace_mismatch` (not 402). Matches `budget-plans` test expectations.

Add import:
```ts
import { effectiveTier } from "../auth/tier.js";
```

Gate snippet (insert into POST create, PATCH update, POST /strategy):
```ts
const tier = await effectiveTier(ctx.session.userId);
if (tier.tier !== "pro") {
  return reply.code(402).send({ error: "upgrade_required" });
}
```

**Do NOT add to**: GET list, GET detail, DELETE (free tier per user decision).

## 4. Test file (new) — `apps/api/tests/goals.routes.test.ts`

Follows the `recurring.routes.test.ts` + `budget-plans.routes.test.ts` pattern:
- Shared `app` via `beforeAll(buildApp)`, `afterAll(close + disconnect)`, `beforeEach(truncateAll)`.
- `setupProUser(email)`: signup → bootstrap → trial active.
- `setupFreeUser(email)`: signup → bootstrap → expire trial + mark consumed.
- Local helpers, not exported to other test files (matches existing pattern).

**Test breakdown (~24 tests):**

**GET list** (3):
- 401 no session
- 200 happy path (empty list initially after truncate)
- 200 happy path with seeded goal via direct `prisma.goal.create` (avoids Pro setup since GET is free; same workspace as the user)

**GET detail** (3):
- 401 no session
- 200 happy path
- 404 not_found on bogus goalId

**POST create** (6):
- 401 no session
- 400 invalid_body (missing required fields)
- 400 invalid_body (dueDate < 1 calendar month from today, e.g., today+15d)
- 400 workspace_mismatch (path vs X-Workspace-Id header)
- **402 upgrade_required for Free tier (trial expired + consumed)**
- 201 happy path (Pro): row persisted, `generateAndStoreGoalStrategy` fire-and-forget called once with `created.id`

**PATCH update** (7):
- 401 no session
- 404 not_found (bogus goalId)
- 400 invalid_body (dueDate < 1 calendar month from today)
- **402 upgrade_required for Free tier**
- 200 happy path (Pro) — title-only patch: returns goal with updated title, other fields untouched
- 200 happy path (Pro) — dueDate extension to today+45d (well past 1-month floor): returns goal with new dueDate
- 200 happy path (Pro) — archived=true toggle: returns goal with `archivedAt` set

**POST /strategy regen** (4):
- 401 no session
- 404 not_found
- **402 upgrade_required for Free tier**
- 200 happy path (Pro): synchronous `generateAndStoreGoalStrategy` called once, return updated goal

**DELETE** (3):
- 401 no session
- 404 not_found (bogus goalId in user's own workspace)
- 204 happy path (**Free tier**): setup creates goal via `prisma.goal.create` direct DB insert (bypassing Pro-gated POST), then user expires trial + sets `trialConsumed=true` to confirm Free, then DELETE returns 204. Cleanup must work for non-Pro per user decision.

**Cross-workspace isolation** (1): user A creates goal G1 in workspace W1; user B (signed in, owns workspace W2) calls `GET /workspaces/W2/goals/G1` (B's own wsId + foreign goalId) → **404 not_found** (goal G1 doesn't exist in W2's scope, the route's `findFirst({ id, workspaceId })` returns null). Verifies workspace scoping at the DB-query level.

**Actual total**: 3 + 3 + 6 + 7 + 4 + 3 + 1 = **27 tests**.

## 5. Test mocking pattern

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";
import * as strategyMod from "../src/goals/generate-strategy.js";

const env = testEnv();

vi.mock("../src/goals/generate-strategy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goals/generate-strategy.js")>();
  return {
    ...actual,
    generateAndStoreGoalStrategy: vi.fn().mockResolvedValue(undefined),
  };
});

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });
// IMPORTANT: clearAllMocks (NOT restoreAllMocks) — the partial vi.mock
// factory above replaces the export with vi.fn(). restoreAllMocks would
// restore the ORIGINAL (Gemini-calling) implementation across tests, which
// would (a) make subsequent tests hit the real Gemini API, (b) break the
// fire-and-forget call-count assertions. clearAllMocks resets call history
// but preserves the mock implementation.
afterEach(() => { vi.clearAllMocks(); });

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
```

`dateOnly(45)` for happy path (well past 1 calendar month, no boundary flake). `dateOnly(15)` for invalid_body. Avoids `vi.useFakeTimers()` to prevent interference with Prisma's internal date handling.

**Call-count assertions** use `vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls` directly:
```ts
expect(vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls.length).toBe(1);
expect(vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls[0]).toEqual([env, expect.any(String)]);
```
No separate `vi.spyOn(strategyMod, ...)` needed — the partial `vi.mock` factory already replaced the export with a `vi.fn()`. `clearAllMocks` in `afterEach` clears mock call history between tests but preserves the mock implementation.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Adding Pro-gate breaks existing mobile UI flow | Mobile already shows locked screen on trial expiry (user confirmed). No regression. |
| 1-month dueDate refine on PATCH could trap users who want to extend a goal | PATCH allows ANY dueDate ≥ 1 month from PATCH-time today. So extending FORWARD is fine; only shrinking BELOW the 1-month floor is rejected. Matches creation rule. |
| Dynamic date in test fixtures (`dateOnly(35)`) could be flaky at month boundaries | `dateOnly(35)` = today+35 days is safely past `minDueDateOneMonthUTC()` for every day of the year (max possible 1-month delta = 31 days, so 35 is always ≥ 4 days past min). Boundary test uses `dateOnly(31)` carefully OR uses an explicit `(min + 1d).toISOString().slice(0,10)`. |
| Pro-gate test for PATCH might pass even without gate if Free user has no goals to patch | Test pre-creates a goal AS PRO USER, then degrades to Free tier, then attempts PATCH on that goal. Or simulates with raw `prisma.goal.create({ ... })` + Free user PATCH. Plan §4 PATCH tests do the latter for clarity. |
| @fina/shared refine logic differs between client (mobile) and server (API) | Single source of truth in `libs/shared/src/schemas/goals.ts` — both consumers import the same refine. Server validates as ground truth even if mobile UI lets user pick an invalid date. |
| TZ edge case: user in Vancouver UTC-7 at 11pm picks "next month" — UTC date already +1 day | Acceptable. Min is computed UTC; client UX picks based on local clock. Off-by-one is a minor convenience issue, not a security/correctness one. |

## 7. Success criteria

- 27 new tests pass, 0 fail.
- 3 routes gated (POST create / PATCH / POST /strategy); 3 routes remain free (GET × 2 / DELETE).
- `dueDate` 1-month refine enforced in both schemas; both web/mobile see the same validation as API.
- Full API suite regression: 0 fail.
- Typecheck baseline unchanged.

## 8. Commits

3 commits (per CLAUDE.md shared-first rule + clean revert paths):
- **T1**: `@fina/shared` — `CreateGoalBody` + `PatchGoalBody` dueDate refine + `minDueDateOneMonthUTC` export.
- **T2**: API — `goals.ts` Pro-gate on 3 LLM-touching routes.
- **T3**: API tests — `goals.routes.test.ts` new file with 27 tests.

## 9. Follow-ups (별도 plan)

- `computeGoalSavings` unit tests (date-boundary, capped 60-month, partial-month spending).
- `generateAndStoreGoalStrategy` integration test (Gemini prompt + JSON parse).
- `goal-milestones` cron tests (milestone threshold trigger + idempotency).
- Mobile date picker: import `minDueDateOneMonthUTC` from `@fina/shared` so picker's min state stays in sync with API enforcement.
