# Plan 1R-compute-goal-savings-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1Q (push-receipts cron). Closes Plan 1P §7 follow-up #2.

## 1. Goal & scope

`apps/api/src/goals/savings.ts:computeGoalSavings` (137 LOC) implements the savings-allocation algorithm with **zero direct test coverage**. Plan 1P mocked it via `vi.fn()` and pinned its `(workspaceId, goalId)` call signature, but the algorithm itself — competitor ordering, first-month proration, default-plan fallback, last-competitor overflow absorption, current-month skip — is unverified.

Add **14 direct unit tests** in 1 commit (12 + 2 per R2 review — multi-category single-month + true rounding test). Tests use real Postgres (no Prisma mocks), `vi.setSystemTime` to control "today", and seed Goal/GoalAllocation/BudgetPlan/Transaction/TransactionAllocation rows directly.

**13 algorithm properties to cover** (production lines in comments):

| Property | Production line |
|---|---|
| Goal not found → 0 | L118 `!thisGoal` |
| Workspace mismatch → 0 | L118 `thisGoal.workspaceId !== workspaceId` |
| Goal has no allocations → 0 | L140 `myCategoryIds.size === 0` |
| Plan ≤ 0 filtered out | L127 `if (plan <= 0) continue` |
| Competitor ordering (older `createdAt` first) | L133 sort by createdAt |
| **Last competitor absorbs overflow** | L215 `isLast ? remaining : Math.min(...)` |
| Current month skipped | L164 `if (isSameMonth(year, month, today)) continue` |
| First-month proration | L172-182 `activeDays / totalDaysInMonth` |
| Per-month BudgetPlan snapshot vs default fallback | L184-192 |
| Spend > cap → 0 savings (Math.max) | L204 `Math.max(0, cap - spent)` |
| Multi-month accumulation | outer for loop |
| Multi-category aggregation per month | L200 `for (const catId of myCategoryIds)` |
| Cents rounding | L225 `Math.round(total * 100) / 100` |

**Out of scope:**
- `monthsBetweenInclusive` 60-month safety cap (gold-plating).
- `categorySpendInDateRange` direct unit (its branches collapse to "rows where amount>0 and categoryId not null" — already exercised through every savings test).
- `readCapsFromAllocations` direct unit (3 lines; exercised via budget-plan helper).
- BudgetPlan validation (existing routes have their own tests).
- HTTP route GET /goals/:id (would be Plan 1S follow-up).

## 2. Shared library touchpoints

**없음.** `computeGoalSavings` signature `(workspaceId, goalId) → number` is internal. `DEFAULT_PERIOD` is from `budget-plans/service.ts`. Pure test addition.

## 3. Production change

**없음.** `savings.ts` unchanged.

## 4. Test file — `apps/api/tests/goals.savings.test.ts` (new, 12 tests)

**Strategy:** real Postgres + `vi.useFakeTimers + vi.setSystemTime` to fix "today" per test. No Prisma mocks — algorithm operates on real query results.

### File header

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { DEFAULT_PERIOD } from "../src/budget-plans/service.js";
import { computeGoalSavings } from "../src/goals/savings.js";

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => {
  await truncateAll();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
```

### Helpers

```ts
let counter = 0;

async function createWorkspace(): Promise<string> {
  counter++;
  const ws = await prisma.workspace.create({
    data: { id: `gs-w-${Date.now()}-${counter}`, name: `GS WS ${counter}`, currency: "CAD" },
  });
  return ws.id;
}

async function createCategory(wsId: string, name = "Dining"): Promise<string> {
  counter++;
  const c = await prisma.category.create({
    data: { workspaceId: wsId, name: `${name} ${counter}` },
  });
  return c.id;
}

async function createGoal(opts: {
  workspaceId: string;
  createdAt: Date;
  title?: string;
  targetAmount?: number;
}): Promise<string> {
  counter++;
  const g = await prisma.goal.create({
    data: {
      workspaceId: opts.workspaceId,
      title: opts.title ?? `Goal ${counter}`,
      targetAmount: new Prisma.Decimal(opts.targetAmount ?? 1000),
      dueDate: new Date(opts.createdAt.getTime() + 365 * 86_400_000),  // 1y after createdAt
      createdAt: opts.createdAt,
    },
  });
  return g.id;
}

async function createGoalAllocation(opts: {
  goalId: string;
  categoryId: string;
  monthlyAmount: number;
}): Promise<void> {
  await prisma.goalAllocation.create({
    data: {
      goalId: opts.goalId,
      categoryId: opts.categoryId,
      monthlyAmount: new Prisma.Decimal(opts.monthlyAmount),
    },
  });
}

/** Pass `periodStart = DEFAULT_PERIOD` for the default plan, or
 *  `new Date("YYYY-MM-01T12:00:00Z")` for a monthly snapshot. */
async function createBudgetPlan(opts: {
  workspaceId: string;
  periodStart: Date;
  capsByCategoryId: Record<string, number>;
  totalAmount?: number;
}): Promise<void> {
  const allocations = Object.entries(opts.capsByCategoryId).map(([categoryId, amount]) => ({
    categoryId,
    amount,
  }));
  const total = opts.totalAmount ?? allocations.reduce((s, a) => s + a.amount, 0);
  await prisma.budgetPlan.create({
    data: {
      workspaceId: opts.workspaceId,
      periodStart: opts.periodStart,
      totalAmount: new Prisma.Decimal(total),
      categoryAllocations: allocations,
    },
  });
}

/** Seed a single transaction + allocation in a category on a specific date. */
async function spendInCategory(opts: {
  workspaceId: string;
  categoryId: string;
  amount: number;
  occurredAt: Date;
}): Promise<void> {
  counter++;
  // Need a BankAccount for the FK.
  let bankAccount = await prisma.bankAccount.findFirst({
    where: { workspaceId: opts.workspaceId },
  });
  if (!bankAccount) {
    bankAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: opts.workspaceId,
        name: "Test Account",
        type: "depository",
        currency: "CAD",
        status: "active",
      },
    });
  }
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: opts.workspaceId,
      accountId: bankAccount.id,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: `Merchant ${counter}`,
      merchantNormalized: `merchant ${counter}`,
      occurredAt: opts.occurredAt,
      pending: false,
      source: "manual",
      rawData: {},
    },
  });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: tx.id,
      categoryId: opts.categoryId,
      amount: new Prisma.Decimal(opts.amount),
      source: "manual",
    },
  });
}

/** Anchor for "today". 2026-06-15 (mid-June) — current month gets skipped,
 *  prior months (May, April, ...) are eligible. */
const TODAY = new Date("2026-06-15T12:00:00.000Z");
```

### 12 test scenarios

| # | Property | Setup | Expected |
|---|---|---|---|
| 1 | Goal not found | nonexistent goalId | 0 |
| 2 | Workspace mismatch | goal in WS-A, query WS-B | 0 |
| 3 | Goal has no GoalAllocation rows | goal exists, no GA | 0 |
| 4 | `plan <= 0` allocation filtered | GA `monthlyAmount: 0` → competitor list empty → no savings | 0 |
| 5 | Simple 1-month savings | TODAY=Jun 15. Goal createdAt May 1. Plan May cap=100, May spend=70. → savings 30 (last competitor absorbs full overflow). | 30 |
| 6 | Multi-month accumulation | createdAt Mar 1, TODAY Jun 15. April, May full months. cap=100/mo, spend=70/mo. March cap=100, March spend=70. → 3 months × 30 = 90. | 90 |
| 7 | Default plan fallback | createdAt May 1, no per-month BudgetPlan, BUT DEFAULT_PERIOD plan with cap=100. May spend=70. → savings 30. | 30 |
| 8 | First-month proration | createdAt May 16 (day 16 of 31-day May). TODAY=Jun 15. activeDays = 31-15 = 16; totalDays=31; ratio=16/31 ≈ 0.516. cap=100 × 0.516 = 51.61. Spend in [May 16, Jun 1) = 0. savings = round(51.61 × 100)/100 = 51.61. | round(100 * 16/31 * 100)/100 = `51.61` |
| 9 | Current month skipped | createdAt Jun 1 (same month as TODAY Jun 15). Only "June" in months list — skipped. → 0. | 0 |
| 10 | Spend > cap → 0 | createdAt May 1. cap=100, May spend=150. → savings 0 (Math.max(0, ...)). | 0 |
| 11 | Competitor ordering (older claims first) | createdAt May 1 for goal-A (older); goal-B createdAt May 2 (newer). Both target cat-X. cap=100, spend=70. savings=30. A.plan=20 (first, takes 20); B last (absorbs 10). Compute goal-A = 20, goal-B = 10. | A: 20, B: 10 |
| 12 | Last competitor absorbs overflow | goal-A May 1 (older, plan=30); goal-B May 2 (newer, plan=30, LAST). cap=100, spend=20. savings=80. A takes min(80, 30)=30. B last absorbs remaining 50 (even > B.plan). | A: 30, B: 50 |

| 13 | **Multi-category aggregation in ONE goal+month** (per R2 review — exercises the `for (catId of myCategoryIds)` inner loop with >1 entry) | createdAt May 1. Goal targets cat-X AND cat-Y. May plan: cat-X cap=50, cat-Y cap=50. May spend: cat-X 20 (savings 30), cat-Y 30 (savings 20). → total 50. | 50 |
| 14 | **True rounding stress** (per R2 review — test 12 is integer-only; this produces non-integer competitor split) | createdAt May 1 (no proration). Goals A (createdAt May 1) + B (createdAt May 2, LAST). Both target cat-X. cap=100, spend=33.33 → savings 66.67. A.plan=20 takes 20. B last absorbs 46.67. | A: 20, B: 46.67 |

**Cents rounding** is explicitly stressed in test 14 (66.67 - 20 = 46.67) AND test 8 (51.61 from 16/31 ratio). Test 12 alone was integer-only — R2 caught the spec's hand-wave.

**Multi-category aggregation** — test 13 fills the gap that test 6 (multi-MONTH) couldn't cover. Inner `for (catId of myCategoryIds)` loop is now exercised with both 1-entry (most tests) and 2-entry (test 13) sets.

**Test 11, 12, 14 require TWO computeGoalSavings calls** — one per goal — to verify per-goal allocation. Each test seeds both goals + shared category + shared spend, then asserts both return values.

**Commit:** `test(api): computeGoalSavings — 14 unit tests covering algorithm`

## 5. Risks

| Risk | Mitigation |
|---|---|
| `vi.useFakeTimers` + Prisma operations — Prisma's internal `new Date()` (for `createdAt`/`updatedAt` defaults) might use the fake clock | `vi.useFakeTimers` mocks `Date.now()` and `new Date()` in user code but NOT in C++/native bindings. Prisma uses Postgres `NOW()` server-side for DEFAULT NOW() columns — unaffected. Test data sets `createdAt` explicitly via Date objects, which respect the fake clock. Safe. |
| `firstOfMonth` returns UTC noon; `vi.setSystemTime` accepts any Date | Helper `TODAY = new Date("2026-06-15T12:00:00.000Z")` aligns time-of-day. |
| Goal.createdAt timezone — production uses `getUTCFullYear()` etc., so all dates must be UTC | All helper dates use ISO UTC strings (`"YYYY-MM-DDTHH:MM:SS.SSSZ"`). |
| Test 8 first-month math precision — `16/31 ≈ 0.51612903...`, cap × ratio = 51.612903..., `Math.round(* 100)/100` = 51.61 | Hard-code expected `51.61` (compute the exact rounded value beforehand). |
| `BudgetPlan.periodStart` is `@db.Date` (date-only). Production uses `new Date("YYYY-MM-01T12:00:00.000Z")` in `firstOfMonth`. The Postgres `Date` column drops time-of-day; lookup `where: { workspaceId_periodStart }` matches by date only. | Helper passes `firstOfMonth(year, month)`-equivalent dates; Prisma serializes to date correctly. |
| `categoryAllocations` Json column — production reads via `readCapsFromAllocations(raw as unknown)`. Helper serializes `[{categoryId, amount}]`. Prisma stores as JSONB. | Verified in `budget-plans/service.ts` precedent. |
| `Transaction.rawData` required (no default) | Helper passes `rawData: {}`. Plan 1M precedent. |
| `BankAccount.create` — `workspaceId, name, type` strictly required; `currency` defaults to "CAD", `status` to `active` per schema. | Helper seeds all 5 explicitly for clarity. |
| `TransactionAllocation.source` is nullable (`CategorizationSource?` in schema) but helper passes `"manual"` for parity with production-shape allocations. | Helper passes explicit value. |
| Test 11 + 12 competitor ordering depends on goal.createdAt — `createdAt May 1` vs `May 2`. Make sure both helpers use UTC. | Helper accepts createdAt arg explicitly. |
| `computeGoalSavings` returns `number`. Tests use `expect(result).toBe(N)`. Floating-point equality at 2-decimal precision after `Math.round(*100)/100` should be exact. | `Math.round` returns an integer; division by 100 yields binary-exact for ≤2 decimal places in normal range. Use `toBe`. |
| `vi.useFakeTimers` reset between tests | `afterEach(vi.useRealTimers)`. |

## 6. Success criteria

- 14 new tests pass.
- Full `@fina/api` suite regression: 0 new fails.
- Typecheck baseline unchanged.
- 1 commit, test-only.

## 7. Follow-ups (별도 plans)

- HTTP route GET /goals/:id integration with savings — caller verification (Plan 1S coming).
- Plan 1P §7 #3 — HTTP → cron integration tests.
- `monthsBetweenInclusive` 60-month cap test (low priority).
- `categorySpendInDateRange` direct unit (low value).
- BudgetPlan + GoalAllocation contract tests (separate scope).
