# Plan 1R — computeGoalSavings unit tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 14 direct unit tests for `computeGoalSavings(workspaceId, goalId)` covering all 13 algorithm properties + 2 R2-driven additions. 1 task, 1 commit. Closes Plan 1P §7 #2.

**Architecture:** Real Postgres + `vi.useFakeTimers` + `vi.setSystemTime` to control "today". No Prisma mocks. Seeds Goal, GoalAllocation, BudgetPlan, Category, BankAccount, Transaction, TransactionAllocation directly.

**Tech Stack:** Vitest 2.x, prisma, Prisma.Decimal.

---

## File Structure

- **Create:** `apps/api/tests/goals.savings.test.ts` — Task 1.

No production code changes. No `@fina/shared` changes.

---

## Task 1: `goals.savings.test.ts` (14 tests, 1 commit)

**Files:**
- Create: `apps/api/tests/goals.savings.test.ts`

- [x] **Step 1: Read precedent + production**

Read `apps/api/src/goals/savings.ts` end-to-end (227 LOC). Note the algorithm:
- L91-117: load goal, all GoalAllocations, default BudgetPlan in parallel
- L118: missing/mismatch → 0
- L120-134: build per-category competitor list (sort by goal.createdAt asc)
- L137-140: `myCategoryIds` for this goal; empty → 0
- L142-144: `defaultCap` from default plan
- L146-157: `today`, months range, `createdDay` (UTC-truncated)
- L160-224: outer per-month loop:
  - L164: current month → skip
  - L166-170: month boundaries
  - L172-182: first-month proration (`ratio = activeDays/totalDaysInMonth` if first month && `createdDay > monthStart`)
  - L184-192: per-month BudgetPlan snapshot OR default fallback
  - L194-198: `spendByCat` for period
  - L200-223: inner per-category loop:
    - L201: `cap = monthCap.get(catId) × ratio`
    - L203-205: `savings = Math.max(0, cap - spent)`
    - L207-222: competitor walk; last absorbs remaining
- L225: `Math.round(total * 100) / 100`

Read `apps/api/src/budget-plans/service.ts:DEFAULT_PERIOD` and `firstOfMonth(year, month1to12)` (~L7, L45).

Read `apps/api/tests/push.anomaly.test.ts` for the real-DB + workspace+category+transaction seed pattern.

**Guardrail:** Do NOT edit any production file. Test-only addition.

- [x] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { DEFAULT_PERIOD, firstOfMonth } from "../src/budget-plans/service.js";
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
      dueDate: new Date(opts.createdAt.getTime() + 365 * 86_400_000),
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

async function createBudgetPlan(opts: {
  workspaceId: string;
  periodStart: Date;
  capsByCategoryId: Record<string, number>;
  totalAmount?: number;
}): Promise<void> {
  const allocations = Object.entries(opts.capsByCategoryId).map(([categoryId, amount]) => ({
    categoryId, amount,
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

async function spendInCategory(opts: {
  workspaceId: string;
  categoryId: string;
  amount: number;
  occurredAt: Date;
}): Promise<void> {
  counter++;
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

// "Today" anchor — 2026-06-15. June=current month → skipped; May, Apr, Mar etc. are eligible.
const TODAY = new Date("2026-06-15T12:00:00.000Z");

describe("computeGoalSavings", () => {
  // 14 tests below
});
```

Then add the 14 `it()` blocks. **Important**: every test calls `vi.setSystemTime(TODAY)` BEFORE the cron call (and after any seed that should respect real-time defaults; here, helpers set createdAt explicitly so order doesn't matter).

**Test 1 — goal not found:**
```ts
  it("goalId not in DB → returns 0", async () => {
    const wsId = await createWorkspace();
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, "nonexistent");
    expect(r).toBe(0);
  });
```

**Test 2 — workspace mismatch:**
```ts
  it("goal in different workspace → returns 0", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const goalId = await createGoal({ workspaceId: wsA, createdAt: new Date("2026-05-01T12:00:00Z") });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsB, goalId);
    expect(r).toBe(0);
  });
```

**Test 3 — no GoalAllocation rows:**
```ts
  it("goal exists but has no GoalAllocation → returns 0", async () => {
    const wsId = await createWorkspace();
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(0);
  });
```

**Test 4 — plan=0 competitor filter (L208 empty competitors path):**

Per R2 review: the goal-under-test's GoalAllocation has plan=0. `myCategoryIds` still includes catId (line 137-138 doesn't filter by plan). But the competitor list for catId is empty (line 127 filtered out the only allocation). With real savings available (cap=100, spend=70 → 30), line 208 `if (competitors.length === 0) continue` causes the 30 to be DISCARDED. Result: 0.

```ts
  it("GoalAllocation monthlyAmount=0 → competitor list empty for catId → savings discarded (L208)", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 0 });
    // Real cap + real underspend → savings exists, but competitor list is empty
    // because the only allocation (plan=0) was filtered at L127.
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 70,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(0);
  });
```

**Test 5 — simple 1-month savings:**
```ts
  it("simple May savings: cap 100, spend 70 → 30 (last competitor absorbs)", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({ workspaceId: wsId, categoryId: catId, amount: 70, occurredAt: new Date("2026-05-15T12:00:00Z") });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(30);
  });
```

**Test 6 — multi-month accumulation:**
```ts
  it("multi-month accumulation: 3 prior months × $30/mo → 90", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-03-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    for (const [year, month] of [[2026, 3], [2026, 4], [2026, 5]] as const) {
      await createBudgetPlan({
        workspaceId: wsId,
        periodStart: firstOfMonth(year, month),
        capsByCategoryId: { [catId]: 100 },
      });
      await spendInCategory({
        workspaceId: wsId, categoryId: catId, amount: 70,
        occurredAt: firstOfMonth(year, month),
      });
    }
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(90);
  });
```

**Test 7 — default plan fallback:**
```ts
  it("no per-month plan → DEFAULT_PERIOD plan used", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    // NO per-month plan; ONLY default plan
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: DEFAULT_PERIOD,
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 70,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(30);
  });
```

**Test 8 — first-month proration:**
```ts
  it("first-month proration: createdAt May 16 → ratio 16/31, cap 51.61", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    // May 16 noon UTC — 16 days remaining in May (May 16 through May 31 = 16 days; periodEnd=Jun 1)
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-16T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    // No spending — savings = full prorated cap
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    // 100 * 16/31 = 51.6129... → Math.round(5161.29)/100 = 51.61
    expect(r).toBe(51.61);
  });
```

**Test 9 — current month skipped:**
```ts
  it("createdAt in current month (June 1) → only June in months range → skipped → 0", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-06-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 6),
      capsByCategoryId: { [catId]: 100 },
    });
    // No spending in June
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(0);
  });
```

**Test 10 — spend > cap:**
```ts
  it("spend exceeds cap → savings 0 (Math.max(0, ...))", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catId, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 150,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(0);
  });
```

**Test 11 — competitor ordering (older claims first):**
```ts
  it("two competitors: older (May 1) claims min(savings, plan), newer (May 2) absorbs rest", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-05-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B newer", createdAt: new Date("2026-05-02T12:00:00Z") });
    await createGoalAllocation({ goalId: goalA, categoryId: catId, monthlyAmount: 20 });
    await createGoalAllocation({ goalId: goalB, categoryId: catId, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 70,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    expect(await computeGoalSavings(wsId, goalA)).toBe(20);  // A.plan=20 cap
    expect(await computeGoalSavings(wsId, goalB)).toBe(10);  // remaining 30-20 → B absorbs 10
  });
```

**Test 12 — last competitor absorbs overflow:**
```ts
  it("last competitor absorbs overflow beyond plan: B last takes 50 > B.plan=30", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-05-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B last", createdAt: new Date("2026-05-02T12:00:00Z") });
    await createGoalAllocation({ goalId: goalA, categoryId: catId, monthlyAmount: 30 });
    await createGoalAllocation({ goalId: goalB, categoryId: catId, monthlyAmount: 30 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 20,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    expect(await computeGoalSavings(wsId, goalA)).toBe(30);  // A takes plan
    expect(await computeGoalSavings(wsId, goalB)).toBe(50);  // B last absorbs 80-30 = 50, > B.plan=30
  });
```

**Test 13 — multi-category aggregation in ONE goal+month:**
```ts
  it("1 goal + 2 categories in 1 month: cat-X (cap50/spent20=savings30) + cat-Y (cap50/spent30=savings20) → 50", async () => {
    const wsId = await createWorkspace();
    const catX = await createCategory(wsId, "Dining");
    const catY = await createCategory(wsId, "Groceries");
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    await createGoalAllocation({ goalId, categoryId: catX, monthlyAmount: 50 });
    await createGoalAllocation({ goalId, categoryId: catY, monthlyAmount: 50 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catX]: 50, [catY]: 50 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catX, amount: 20,
      occurredAt: new Date("2026-05-10T12:00:00Z"),
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catY, amount: 30,
      occurredAt: new Date("2026-05-20T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    // cat-X savings 30 + cat-Y savings 20 = 50
    expect(r).toBe(50);
  });
```

**Test 14 — true rounding stress:**
```ts
  it("rounding stress: non-integer spend → 33.33; competitor split A=20, B last=46.67", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-05-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B last", createdAt: new Date("2026-05-02T12:00:00Z") });
    await createGoalAllocation({ goalId: goalA, categoryId: catId, monthlyAmount: 20 });
    await createGoalAllocation({ goalId: goalB, categoryId: catId, monthlyAmount: 30 });
    await createBudgetPlan({
      workspaceId: wsId,
      periodStart: firstOfMonth(2026, 5),
      capsByCategoryId: { [catId]: 100 },
    });
    await spendInCategory({
      workspaceId: wsId, categoryId: catId, amount: 33.33,
      occurredAt: new Date("2026-05-15T12:00:00Z"),
    });
    vi.setSystemTime(TODAY);
    // savings = 100 - 33.33 = 66.67. A takes min(66.67, 20) = 20. Remaining 46.67. B last absorbs 46.67.
    expect(await computeGoalSavings(wsId, goalA)).toBe(20);
    expect(await computeGoalSavings(wsId, goalB)).toBe(46.67);
  });
```

- [x] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/goals.savings.test.ts`
Expected: `Tests  14 passed (14)`.

Common gotchas:
- `vi.setSystemTime` must be called AFTER seed but BEFORE the cron call. If you put it before seed, Prisma timestamp defaults are still NOW() server-side — no effect — but the goal.createdAt that you set explicitly is the value used.
- `Prisma.Decimal` arithmetic — never use `toBe(N.NN)` for raw Decimal outputs. computeGoalSavings returns `number` after `Math.round * 100 / 100`, so JS-side `expect(r).toBe(51.61)` works.
- Test 11/12/14 call computeGoalSavings TWICE per test — order matters not (no side effects in the function).
- `BankAccount.findFirst` in helper reuses across spendInCategory calls within same workspace — by design.

- [x] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "goals.savings" | head -5`
Expected: 0 lines.

- [x] **Step 5: Commit**

Branch confirmation: `git branch --show-current` must show `worktree-plan-1r-compute-goal-savings-test`.

```bash
git add apps/api/tests/goals.savings.test.ts
git commit -m "$(cat <<'EOF'
test(api): computeGoalSavings — 14 unit tests covering algorithm

Closes Plan 1P §7 follow-up #2. Direct tests for: goal-not-found, workspace
mismatch, no allocations, plan-0 filter, simple savings, multi-month
accumulation, default-plan fallback, first-month proration (16/31 ratio),
current-month skip, spend>cap, competitor ordering (older first), last-
competitor overflow absorption, multi-category aggregation, rounding
stress (66.67 split → A=20, B=46.67). Real Postgres + vi.setSystemTime.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
