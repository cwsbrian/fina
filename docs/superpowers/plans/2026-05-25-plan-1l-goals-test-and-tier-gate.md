# Plan 1L-goals-test-and-tier-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 27-test coverage to `apps/api/src/routes/goals.ts` + Pro-tier gate on POST/PATCH/POST-strategy + `dueDate ≥ 1 calendar month` refine in `@fina/shared`.

**Architecture:** 3 commits, shared-first. T1 extends `CreateGoalBody`/`PatchGoalBody` zod with `DueDateMinOneMonth` refine + exports `minDueDateOneMonthUTC` helper. T2 inserts Pro-gate (`effectiveTier` 402) AFTER workspace-mismatch check on 3 routes. T3 creates the comprehensive test file with prototype-mock `generate-strategy.js` + `vi.clearAllMocks` afterEach (NOT restoreAllMocks — would break the partial mock).

**Tech Stack:** Vitest 2.1.5 singleFork (real Postgres :5433), Prisma 5.22, `@fina/shared` zod refine, Better-Auth session.

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-25-plan-1l-goals-test-and-tier-gate-design.md` (HEAD `8d52eff`). Authoritative.
- **User decisions:**
  - Pro-gate: free for GET list/detail + DELETE; Pro-only for POST/PATCH/POST-strategy.
  - "1 calendar month" = next month same day, overflow clamp (Jan 31 → Feb 28/29).
  - PATCH and POST share the same dueDate refine.
- **Real codebase anchors:**
  - `libs/shared/src/schemas/goals.ts` — current `CreateGoalBody`/`PatchGoalBody`/`DateOnly`/constants.
  - `libs/shared/src/index.ts:37` — `export * from "./schemas/goals.js"` already present (wildcard auto-flows new exports).
  - `apps/api/src/routes/goals.ts` — 6 routes (273 lines).
  - `apps/api/src/auth/tier.ts` — `effectiveTier(userId)`; reads fresh DB; consults trial + subscriptions.
  - `apps/api/src/goals/generate-strategy.ts` — exports `generateAndStoreGoalStrategy(env, goalId)` (Gemini-driven).
  - `apps/api/src/routes/budget-plans.ts:170-178` — Pro-gate precedent (gate AFTER workspace-mismatch).
  - `apps/api/tests/budget-plans.routes.test.ts` — Free-tier downgrade fixture pattern.
  - `apps/api/tests/recurring.routes.test.ts` — setupProUser-style helper precedent.
- **Discipline:**
  - `vi.spyOn(prisma, ...)` and Prisma delegate properties FORBIDDEN.
  - `@fina/shared` ships BEFORE consumers (T1 enforces this).
  - `vi.clearAllMocks` (NOT `restoreAllMocks`) — partial vi.mock factory replaces the export with a vi.fn(); restoreAllMocks would restore the original Gemini-calling implementation and break subsequent tests.

## File map

| File | Action | Task |
|---|---|---|
| `libs/shared/src/schemas/goals.ts` | Modify — add `minDueDateOneMonthUTC` export + `DueDateMinOneMonth` refine; replace `dueDate: DateOnly` with refined version in both schemas | T1 |
| `apps/api/src/routes/goals.ts` | Modify — add `effectiveTier` import + gate on 3 routes (POST/PATCH/POST-strategy) | T2 |
| `apps/api/tests/goals.routes.test.ts` | Create — 27 tests | T3 |

---

## Task 1: `@fina/shared` — `DueDateMinOneMonth` refine

**Goal:** Land the dueDate floor in shared lib first so both API and mobile import from a single source.

**Files:**
- Modify: `libs/shared/src/schemas/goals.ts`

- [ ] **Step 1.1: Read current schema**

```bash
cd /home/cwsbr/personal/fina && cat libs/shared/src/schemas/goals.ts
```

Expected shape (verify): exports `GOAL_TITLE_MAX_LEN`, `GOAL_DESCRIPTION_MAX_LEN`, `GOAL_MAX_AMOUNT`, `DateOnly`, `CreateGoalBody`, `PatchGoalBody`, `CreateGoalInput`, `PatchGoalInput`. `dueDate: DateOnly` in both.

- [ ] **Step 1.2: Add the refine + helper**

In `libs/shared/src/schemas/goals.ts`, BEFORE the `CreateGoalBody` declaration, insert:

```ts
/** Minimum due date: today + 1 calendar month (UTC). Overflow guard:
 *  Jan 31 + 1m → Feb 31 → Mar 3 (JS auto-rolls). Clamp to last day of
 *  intended target month so the user-visible rule stays "next month,
 *  same day or last day of that month if shorter". Exported so mobile
 *  date pickers can use the same source of truth. */
export function minDueDateOneMonthUTC(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const t = new Date(Date.UTC(y, m + 1, d, 0, 0, 0, 0));
  if (t.getUTCMonth() !== (m + 1) % 12) {
    t.setUTCDate(0); // clamp to last day of intended target month
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
```

Then update both schemas to use `DueDateMinOneMonth`:

```ts
export const CreateGoalBody = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
  targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT),
  savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
  dueDate: DueDateMinOneMonth,  // ← was DateOnly
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchGoalBody = z
  .object({
    title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
    targetAmount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    savedAmount: z.number().min(0).max(GOAL_MAX_AMOUNT).optional(),
    dueDate: DueDateMinOneMonth.optional(),  // ← was DateOnly.optional()
    icon: z.string().max(40).optional().nullable(),
    color: z.string().max(20).optional().nullable(),
    archived: z.boolean().optional(),
  })
  .strict();
```

- [ ] **Step 1.3: Verify `index.ts` re-export**

```bash
grep "schemas/goals" libs/shared/src/index.ts
```

Expected: `export * from "./schemas/goals.js";`. No edit needed.

- [ ] **Step 1.4: Typecheck shared**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json
```

Expected: clean output (no errors).

- [ ] **Step 1.5: Commit**

```bash
cd /home/cwsbr/personal/fina && git add libs/shared/src/schemas/goals.ts && git commit -m "feat(@fina/shared): dueDate >= 1 calendar month refine + helper

Plan 1L-goals-test-and-tier-gate T1. Adds DueDateMinOneMonth refine
to CreateGoalBody + PatchGoalBody. minDueDateOneMonthUTC exported so
mobile date pickers + API validation share a single source of truth.

Overflow guard: Jan 31 + 1m → Feb 28/29 (not Mar 3 from JS auto-roll).
PATCH respects the same floor (per user decision).

Server reads zod safeParse → 400 invalid_body on violation (existing
goals.ts error path; no route change in this commit)."
```

---

## Task 2: API `goals.ts` — Pro-gate on 3 LLM-touching routes

**Goal:** Insert tier check AFTER workspace-mismatch on POST/PATCH/POST-strategy. Free for GET list/detail/DELETE per user decision.

**Files:**
- Modify: `apps/api/src/routes/goals.ts`

- [ ] **Step 2.1: Add import**

In `apps/api/src/routes/goals.ts`, near the top with other imports, add:

```ts
import { effectiveTier } from "../auth/tier.js";
```

- [ ] **Step 2.2: Gate POST create**

Locate `app.post("/workspaces/:id/goals", async (req, reply) => {`. After the `if (ctx.membership.workspaceId !== params.id) return reply.code(400).send({ error: "workspace_mismatch" });` line, BEFORE `const created = await prisma.goal.create(...)`, insert:

```ts
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") {
        return reply.code(402).send({ error: "upgrade_required" });
      }
```

- [ ] **Step 2.3: Gate PATCH**

Locate `app.patch<{ Params: { id: string; goalId: string } }>(`. Inside the handler, AFTER the `if (req.params.id !== ctx.membership.workspaceId) return reply.code(400).send({ error: "workspace_mismatch" });` line and BEFORE the `const row = await prisma.goal.findFirst(...)` lookup, insert the same gate snippet:

```ts
        const tier = await effectiveTier(ctx.session.userId);
        if (tier.tier !== "pro") {
          return reply.code(402).send({ error: "upgrade_required" });
        }
```

- [ ] **Step 2.4: Gate POST /strategy**

Locate `app.post<{ Params: { id: string; goalId: string } }>("/workspaces/:id/goals/:goalId/strategy",`. Same insertion: AFTER workspace-mismatch check, BEFORE `const row = await prisma.goal.findFirst(...)`:

```ts
        const tier = await effectiveTier(ctx.session.userId);
        if (tier.tier !== "pro") {
          return reply.code(402).send({ error: "upgrade_required" });
        }
```

- [ ] **Step 2.5: Verify no gate on GET/DELETE**

```bash
grep -n "effectiveTier\|upgrade_required" apps/api/src/routes/goals.ts
```

Expected: exactly 7 matches — 1 import + 3 × `effectiveTier(...)` + 3 × `"upgrade_required"`. NO matches inside GET list, GET detail, or DELETE handlers.

- [ ] **Step 2.6: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same as pre-T2 baseline (no new errors).

- [ ] **Step 2.7: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/src/routes/goals.ts && git commit -m "feat(api): Pro-gate on goals POST/PATCH/POST-strategy

Plan 1L-goals-test-and-tier-gate T2. Free for GET list/detail +
DELETE (user-explicit: read + cleanup must work without Pro).
Pro-only for the 3 LLM-touching mutation paths:
- POST /workspaces/:id/goals (auto-triggers strategy gen)
- PATCH /workspaces/:id/goals/:goalId (user-explicit: mods are Pro)
- POST /workspaces/:id/goals/:goalId/strategy (explicit regen)

Gate inserted AFTER workspace-mismatch check on each route, mirroring
budget-plans.ts:170-178 and budgets.ts:37-41/90-94 precedent.
Free-tier + wsId mismatch → 400 workspace_mismatch (not 402).

goal-milestones cron (daily 10:10 UTC, pure computeGoalSavings,
no LLM) unaffected — free tier continues to get milestones."
```

---

## Task 3: Test file — `apps/api/tests/goals.routes.test.ts` (27 tests)

**Goal:** Comprehensive coverage; one file, fixed setup, mock `generate-strategy.js` partially so `generateAndStoreGoalStrategy` becomes a `vi.fn()`. Free user fixture follows `budget-plans.routes.test.ts` downgrade pattern.

**Files:**
- Create: `apps/api/tests/goals.routes.test.ts`

- [ ] **Step 3.1: Create the test file with header + helpers**

Create `apps/api/tests/goals.routes.test.ts` with:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";
import * as strategyMod from "../src/goals/generate-strategy.js";
import { Prisma } from "@prisma/client";

const env = testEnv();

// Partial mock: replace generateAndStoreGoalStrategy with vi.fn(), keep
// other exports as-is. vi.clearAllMocks in afterEach clears call history
// but PRESERVES this mock implementation (restoreAllMocks would restore
// the real Gemini-calling impl and break subsequent tests).
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
afterEach(() => { vi.clearAllMocks(); });

function dateOnly(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function setupProUser(email: string): Promise<{ userId: string; wsId: string; cookie: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  // Bootstrap auto-starts trial → user is Pro (trialEndsAt in future).
  return { userId: u.userId, wsId, cookie: u.cookie };
}

async function setupFreeUser(email: string): Promise<{ userId: string; wsId: string; cookie: string }> {
  const u = await setupProUser(email);
  await prisma.user.update({
    where: { id: u.userId },
    data: { trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
  });
  return u;
}

async function seedGoal(wsId: string, overrides?: Partial<{ dueDate: Date; title: string }>): Promise<string> {
  const row = await prisma.goal.create({
    data: {
      workspaceId: wsId,
      title: overrides?.title ?? "Test Goal",
      targetAmount: new Prisma.Decimal(1000),
      savedAmount: new Prisma.Decimal(0),
      dueDate: overrides?.dueDate ?? new Date(Date.now() + 60 * 86_400_000),
    },
  });
  return row.id;
}
```

- [ ] **Step 3.2: Add GET list describe block (3 tests)**

Append:

```ts
describe("GET /workspaces/:id/goals", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces/anything/goals" });
    expect(res.statusCode).toBe(401);
  });

  it("200 empty list initially", async () => {
    const u = await setupProUser(`gl-empty-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goals).toEqual([]);
  });

  it("200 with seeded goal (direct DB insert, no Pro setup needed for GET)", async () => {
    const u = await setupProUser(`gl-seed-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    const goals = res.json().goals as Array<{ id: string }>;
    expect(goals).toHaveLength(1);
    expect(goals[0]!.id).toBe(goalId);
  });
});
```

- [ ] **Step 3.3: Add GET detail describe block (3 tests)**

Append:

```ts
describe("GET /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "GET", url: "/workspaces/ws/goals/g" });
    expect(res.statusCode).toBe(401);
  });

  it("200 happy path", async () => {
    const u = await setupProUser(`gd-ok-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId, { title: "Detail Goal" });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.title).toBe("Detail Goal");
  });

  it("404 not_found on bogus goalId", async () => {
    const u = await setupProUser(`gd-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
```

- [ ] **Step 3.4: Add POST create describe block (6 tests)**

Append:

```ts
describe("POST /workspaces/:id/goals", () => {
  it("401 no session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws/goals",
      payload: { title: "X", targetAmount: 100, dueDate: dateOnly(45) },
    });
    expect(res.statusCode).toBe(401);
  });

  it("400 invalid_body missing required fields", async () => {
    const u = await setupProUser(`gc-missing-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X" }),  // missing targetAmount + dueDate
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 invalid_body when dueDate < 1 calendar month (today+15d)", async () => {
    const u = await setupProUser(`gc-short-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(15) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 workspace_mismatch when path :id differs from X-Workspace-Id", async () => {
    const u = await setupProUser(`gc-wsmm-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": "different-ws-id", "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(45) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "workspace_mismatch" });
  });

  it("402 upgrade_required for Free tier (trial expired + consumed)", async () => {
    const u = await setupFreeUser(`gc-free-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X", targetAmount: 100, dueDate: dateOnly(45) }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("201 happy path (Pro): row persisted + generateAndStoreGoalStrategy fire-and-forget", async () => {
    const u = await setupProUser(`gc-ok-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        title: "Save for Tokyo",
        targetAmount: 5000,
        dueDate: dateOnly(45),
      }),
    });
    expect(res.statusCode).toBe(201);
    const goalId = res.json().goal.id as string;
    expect(typeof goalId).toBe("string");

    const stored = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(stored.title).toBe("Save for Tokyo");

    // Fire-and-forget call landed. The `void`-prefixed call inside the
    // handler invokes the mocked vi.fn() synchronously (only its .then() is
    // async), so .mock.calls is populated before the response returns.
    const calls = vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([env, goalId]);
  });
});
```

- [ ] **Step 3.5: Add PATCH describe block (7 tests)**

Append:

```ts
describe("PATCH /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/workspaces/ws/goals/g",
      payload: { title: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found on bogus goalId (Pro user, real wsId)", async () => {
    const u = await setupProUser(`gp-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "X" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("400 invalid_body when dueDate < 1 calendar month", async () => {
    const u = await setupProUser(`gp-short-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ dueDate: dateOnly(15) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("402 upgrade_required for Free tier", async () => {
    // Pre-seed a goal AS PRO USER via direct DB insert (POST is Pro-gated).
    const u = await setupFreeUser(`gp-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "New Title" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("200 happy path (Pro): title-only patch", async () => {
    const u = await setupProUser(`gp-title-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId, { title: "Old" });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ title: "New" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.title).toBe("New");
  });

  it("200 happy path (Pro): dueDate extension to today+45d", async () => {
    const u = await setupProUser(`gp-due-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const newDue = dateOnly(45);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ dueDate: newDue }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.dueDate).toBe(newDue);
  });

  it("200 happy path (Pro): archived=true toggle sets archivedAt", async () => {
    const u = await setupProUser(`gp-arch-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId, "content-type": "application/json" },
      payload: JSON.stringify({ archived: true }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.archivedAt).not.toBeNull();
  });
});
```

- [ ] **Step 3.6: Add POST /strategy describe block (4 tests)**

Append:

```ts
describe("POST /workspaces/:id/goals/:goalId/strategy", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "POST", url: "/workspaces/ws/goals/g/strategy" });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found", async () => {
    const u = await setupProUser(`gs-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/bogus-id/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("402 upgrade_required for Free tier", async () => {
    const u = await setupFreeUser(`gs-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/${goalId}/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });
  });

  it("200 happy path (Pro): generateAndStoreGoalStrategy called synchronously", async () => {
    const u = await setupProUser(`gs-ok-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${u.wsId}/goals/${goalId}/strategy`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().goal.id).toBe(goalId);

    const calls = vi.mocked(strategyMod.generateAndStoreGoalStrategy).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([env, goalId]);
  });
});
```

- [ ] **Step 3.7: Add DELETE describe block (3 tests)**

Append:

```ts
describe("DELETE /workspaces/:id/goals/:goalId", () => {
  it("401 no session", async () => {
    const res = await app.inject({ method: "DELETE", url: "/workspaces/ws/goals/g" });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found on bogus goalId", async () => {
    const u = await setupProUser(`gd-404-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${u.wsId}/goals/bogus-id`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  it("204 Free tier user can DELETE existing goal (cleanup unaffected by Pro-gate)", async () => {
    // Setup as Pro → seed goal via direct DB → expire trial + consumed → DELETE.
    const u = await setupFreeUser(`gd-free-${Date.now()}@t.co`);
    const goalId = await seedGoal(u.wsId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${u.wsId}/goals/${goalId}`,
      headers: { cookie: u.cookie, "x-workspace-id": u.wsId },
    });
    expect(res.statusCode).toBe(204);
    const after = await prisma.goal.findUnique({ where: { id: goalId } });
    expect(after).toBeNull();
  });
});
```

- [ ] **Step 3.8: Add cross-workspace isolation describe (1 test)**

Append:

```ts
describe("cross-workspace isolation", () => {
  it("404 not_found when user B requests goal G1 from their own workspace W2", async () => {
    const userA = await setupProUser(`xw-A-${Date.now()}@t.co`);
    const userB = await setupProUser(`xw-B-${Date.now()}@t.co`);
    const goalG1 = await seedGoal(userA.wsId);
    // User B uses their OWN wsId W2 but passes foreign goalId G1.
    // Route's findFirst({ id: G1, workspaceId: W2 }) returns null → 404.
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${userB.wsId}/goals/${goalG1}`,
      headers: { cookie: userB.cookie, "x-workspace-id": userB.wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });
});
```

- [ ] **Step 3.9: Run the test file — expect 27 pass**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/goals.routes.test.ts 2>&1 | tail -8
```

Expected: 27/27 pass.

- [ ] **Step 3.10: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same as pre-T3 baseline.

- [ ] **Step 3.11: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/goals.routes.test.ts && git commit -m "test(api): goals routes — 27 tests covering auth/role/tier/validation

Plan 1L-goals-test-and-tier-gate T3. Comprehensive coverage for the
previously-untested apps/api/src/routes/goals.ts (273 lines, 6
routes).

Tests per route:
- GET list × 3 (401, empty, seeded via direct DB insert)
- GET detail × 3 (401, happy, 404)
- POST create × 6 (401, invalid_body × 2 — missing fields + dueDate
  too short, 400 workspace_mismatch, 402 Free tier, 201 happy +
  fire-and-forget mock assertion)
- PATCH × 7 (401, 404, 400 dueDate, 402 Free, 3 happy paths: title /
  dueDate extension / archived toggle)
- POST /strategy × 4 (401, 404, 402 Free, 200 happy + sync mock
  assertion)
- DELETE × 3 (401, 404, 204 Free-tier cleanup works)
- Cross-workspace × 1 (B's own wsId + A's goalId → 404)

Partial vi.mock of generate-strategy.js: generateAndStoreGoalStrategy
replaced by vi.fn().mockResolvedValue(undefined). afterEach uses
vi.clearAllMocks (NOT restoreAllMocks — would restore the real
Gemini-calling impl). Call assertions go through vi.mocked(...).mock
.calls.

setupFreeUser helper: signup → trial active → expire trialEndsAt +
trialConsumed=true (matches budget-plans.routes.test.ts pattern).
seedGoal direct DB insert bypasses the Pro-gated POST when free-tier
fixtures need a pre-existing goal."
```

---

## Final verification

After all 3 task-commits land:

- [ ] **Full API suite regression**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -8
```

Expected: 0 failures.

- [ ] **3-commit chain check**

```bash
cd /home/cwsbr/personal/fina && git log --oneline -4
```

Expected: 3 commits in order T1 (@fina/shared) → T2 (api routes) → T3 (api tests).

- [ ] **All 3 typechecks clean**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json 2>&1 | grep "error TS" | wc -l
cd /home/cwsbr/personal/fina && pnpm --filter @fina/mobile exec tsc --noEmit 2>&1 | grep "error TS" | wc -l
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: shared 0, mobile 0, api same baseline as pre-T1.
