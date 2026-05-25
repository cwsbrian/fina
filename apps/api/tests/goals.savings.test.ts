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
  it("goalId not in DB → returns 0", async () => {
    const wsId = await createWorkspace();
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, "nonexistent");
    expect(r).toBe(0);
  });

  it("goal in different workspace → returns 0", async () => {
    const wsA = await createWorkspace();
    const wsB = await createWorkspace();
    const goalId = await createGoal({ workspaceId: wsA, createdAt: new Date("2026-05-01T12:00:00Z") });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsB, goalId);
    expect(r).toBe(0);
  });

  it("goal exists but has no GoalAllocation → returns 0", async () => {
    const wsId = await createWorkspace();
    const goalId = await createGoal({ workspaceId: wsId, createdAt: new Date("2026-05-01T12:00:00Z") });
    vi.setSystemTime(TODAY);
    const r = await computeGoalSavings(wsId, goalId);
    expect(r).toBe(0);
  });

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

  it("first-month proration: createdAt May 16 → ratio 16.5/31, cap 53.23", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    // createdAt May 16 12:00 UTC. createdDay UTC-truncates to May 16 00:00.
    // monthStart=firstOfMonth(May)=May 1 12:00. periodStart=May 16 00:00 (> monthStart).
    // activeDays = (Jun 1 12:00 - May 16 00:00) / 86400000 = 16.5 days.
    // totalDaysInMonth = (Jun 1 12:00 - May 1 12:00) / 86400000 = 31.
    // ratio = 16.5/31 → cap = 100 * 16.5/31 = 53.2258... → Math.round(5322.58)/100 = 53.23.
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
    expect(r).toBe(53.23);
  });

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

  it("two competitors: older (Apr 1) claims min(savings, plan), newer (Apr 2) absorbs rest", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    // Both goals created in April so May is NOT a first month for either —
    // ratio=1 for both, cap=100 exact. (If both were created in May, goalB's
    // own first-month proration would shrink B's perceived May cap.)
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-04-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B newer", createdAt: new Date("2026-04-02T12:00:00Z") });
    await createGoalAllocation({ goalId: goalA, categoryId: catId, monthlyAmount: 20 });
    await createGoalAllocation({ goalId: goalB, categoryId: catId, monthlyAmount: 50 });
    // Only seed May plan + May spend. April has no plan → defaultCap empty →
    // cap=0 → skipped. So only May contributes.
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

  it("last competitor absorbs overflow beyond plan: B last takes 50 > B.plan=30", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    // Both goals created in April so May is NOT a first month → ratio=1 for both.
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-04-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B last", createdAt: new Date("2026-04-02T12:00:00Z") });
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

  it("rounding stress: non-integer spend → 33.33; competitor split A=20, B last=46.67", async () => {
    const wsId = await createWorkspace();
    const catId = await createCategory(wsId);
    // Both goals created in April so May is NOT a first month → ratio=1 for both.
    const goalA = await createGoal({ workspaceId: wsId, title: "A older", createdAt: new Date("2026-04-01T12:00:00Z") });
    const goalB = await createGoal({ workspaceId: wsId, title: "B last", createdAt: new Date("2026-04-02T12:00:00Z") });
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
});
