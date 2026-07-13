import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  recentDiscretionaryDailyByCategory,
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
} from "../src/budget-plans/service.js";
import { projectMonthEnd } from "../src/analysis/forecast.js";

describe("recentDiscretionaryDailyByCategory", () => {
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `disc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (
      await prisma.bankAccount.create({
        data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
      })
    ).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function tx(
    amount: string,
    day: string,
    pending = false,
    budgetImpact: "expense" | "excluded" = "expense",
  ) {
    const t = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct,
        amount,
        merchantRaw: "M",
        occurredAt: new Date(day),
        source: "manual",
        pending,
        rawData: {},
        budgetImpact,
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: t.id, categoryId: dining, amount },
    });
    return t;
  }

  it("nets refunds and excludes pending in the 90-day discretionary daily rate", async () => {
    await tx("90.00", "2026-04-20T12:00:00Z"); // counts
    await tx("-30.00", "2026-04-21T12:00:00Z"); // refund nets out
    await tx("60.00", "2026-05-01T12:00:00Z", true); // pending excluded
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining)).toBeCloseTo(60 / 90, 4);
  });

  it("subtracts the category's recurring monthly-equivalent (3 months) so fixed bills don't inflate the rate", async () => {
    await tx("100.00", "2026-03-01T12:00:00Z");
    await tx("100.00", "2026-04-01T12:00:00Z");
    await tx("100.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: {
        workspaceId: wsId,
        name: "Rent",
        nameNormalized: "rent",
        amount: "100.00",
        categoryId: dining,
        cadence: "monthly",
        nextOccurrenceDate: new Date("2026-06-01T12:00:00Z"),
      },
    });
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining) ?? 0).toBeCloseTo(0, 4);
  });

  it("winsorizes a positive outlier to 3x the median positive amount", async () => {
    await tx("10.00", "2026-04-10T12:00:00Z");
    await tx("10.00", "2026-04-12T12:00:00Z");
    await tx("1000.00", "2026-04-15T12:00:00Z"); // outlier
    // positives sorted [10,10,1000], median=10, cap=30 → 1000 capped to 30.
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining)!).toBeCloseTo((10 + 10 + 30) / 90, 4);
    expect(rates.get(dining)!).toBeLessThan((10 + 10 + 1000) / 90);
  });

  it("a refund does not distort the winsorize cap (negatives net, never capped)", async () => {
    await tx("50.00", "2026-04-10T12:00:00Z");
    await tx("50.00", "2026-04-12T12:00:00Z");
    await tx("-200.00", "2026-04-15T12:00:00Z"); // big refund
    // positives [50,50] → median 50, cap 150, nothing capped; net = -100 → clamped to 0.
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining) ?? 0).toBeCloseTo(0, 4);
  });

  it("excludes transactions marked out of budget from the forecast rate", async () => {
    await tx("100.00", "2026-04-10T12:00:00Z", false, "excluded");
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining) ?? 0).toBeCloseTo(0, 4);
  });
});

describe("subscription vs scheduled split", () => {
  let wsId: string;
  let groceries: string;
  beforeEach(async () => {
    const stamp = `split-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } }))
      .id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("subscription occurrences are today-forward only", async () => {
    await prisma.recurringExpense.create({
      data: {
        workspaceId: wsId,
        name: "Box",
        nameNormalized: "box",
        amount: "40.00",
        categoryId: groceries,
        cadence: "weekly",
        nextOccurrenceDate: new Date("2026-05-18T12:00:00Z"),
      },
    });
    const subs = await monthlySubscriptionByCategory(wsId, 2026, 5);
    // 5/18 and 5/25 fall in [today=5/15, 6/1) → 2 occurrences * 40 = 80.
    expect(subs.get(groceries)).toBeCloseTo(80, 2);
  });

  it("scheduled spend counts only TODAY-forward items (past-dated excluded)", async () => {
    // today is 2026-05-15. A past-dated unmatched scheduled spend has usually
    // already happened (in the actuals) or is stale, so it must NOT be added.
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: groceries,
        amount: "50.00",
        scheduledDate: new Date("2026-05-10"),
      }, // past → excluded
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: groceries,
        amount: "25.00",
        scheduledDate: new Date("2026-05-20"),
      }, // future → counted
    });
    const sched = await monthlyScheduledSpendByCategory(wsId, 2026, 5);
    expect(sched.get(groceries)).toBeCloseTo(25, 2);
  });

  it("scheduled spend includes today, excludes past and next month", async () => {
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: groceries,
        amount: "11.00",
        scheduledDate: new Date("2026-05-15"),
      }, // today → counted
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: groceries,
        amount: "7.00",
        scheduledDate: new Date("2026-05-10"),
      }, // past → excluded
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: groceries,
        amount: "99.00",
        scheduledDate: new Date("2026-06-01"),
      }, // next month → excluded
    });
    const sched = await monthlyScheduledSpendByCategory(wsId, 2026, 5);
    expect(sched.get(groceries)).toBeCloseTo(11, 2);
  });
});

describe("projectMonthEnd", () => {
  let wsId: string;
  let userId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `fc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "FC", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (
      await prisma.bankAccount.create({
        data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
      })
    ).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function spend(amount: string, day: string, categoryId = dining) {
    const t = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct,
        amount,
        merchantRaw: "M",
        occurredAt: new Date(day),
        source: "manual",
        pending: false,
        rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: t.id, categoryId, amount },
    });
  }
  async function plan(cap: number) {
    await prisma.budgetPlan.create({
      data: {
        workspaceId: wsId,
        periodStart: new Date("2026-05-01T12:00:00.000Z"),
        totalAmount: "9000.00",
        categoryAllocations: [{ categoryId: dining, amount: cap }],
      },
    });
  }

  it("a rent-only category projects ~cap, NOT cap+rent (no double-count)", async () => {
    await plan(2000);
    await spend("2000.00", "2026-02-01T12:00:00Z");
    await spend("2000.00", "2026-03-01T12:00:00Z");
    await spend("2000.00", "2026-04-01T12:00:00Z");
    await spend("2000.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: {
        workspaceId: wsId,
        name: "Rent",
        nameNormalized: "rent",
        amount: "2000.00",
        categoryId: dining,
        cadence: "monthly",
        nextOccurrenceDate: new Date("2026-06-01T12:00:00Z"),
      },
    });
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.projected).toBeCloseTo(2000, 0);
    expect(c.severity).toBe("on_track");
  });

  it("a monthly fixed category without a recurring rule does not project daily repeats", async () => {
    await plan(2500);
    await spend("2500.00", "2026-02-01T12:00:00Z");
    await spend("2500.00", "2026-03-01T12:00:00Z");
    await spend("2500.00", "2026-04-01T12:00:00Z");
    await spend("2500.00", "2026-05-01T12:00:00Z");

    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.projected).toBeCloseTo(2500, 0);
    expect(c.severity).toBe("on_track");
  });

  it("does not create a daily risk from historical overspending alone", async () => {
    await plan(300);
    for (const day of [
      "2026-02-05",
      "2026-02-20",
      "2026-03-05",
      "2026-03-20",
      "2026-04-05",
      "2026-04-20",
    ]) {
      await spend("300.00", `${day}T12:00:00Z`);
    }
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.severity).toBe("on_track");
    expect(c.projected).toBe(0);
    expect(c.historicalMonthlyAverage).toBe(600);
    expect(c.historicalOverspendMonths).toBe(3);
    expect(c.currentPaceRatio).toBe(0);
    expect(c.runwayDay).toBeNull();
  });

  it("lowers Shopping's remaining forecast when the current same-day pace is slower", async () => {
    await plan(500);
    for (const month of ["02", "03", "04"]) {
      await spend("300.00", `2026-${month}-05T12:00:00Z`);
      await spend("300.00", `2026-${month}-20T12:00:00Z`);
    }
    await spend("150.00", "2026-05-05T12:00:00Z");

    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.currentPaceRatio).toBe(0.5);
    expect(c.projected).toBe(300);
    expect(c.severity).toBe("on_track");
    expect(c.historicalOverspendMonths).toBe(3);
  });

  it("raises risk when the current same-day pace is faster than the category pattern", async () => {
    await plan(500);
    for (const month of ["02", "03", "04"]) {
      await spend("300.00", `2026-${month}-05T12:00:00Z`);
      await spend("300.00", `2026-${month}-20T12:00:00Z`);
    }
    await spend("450.00", "2026-05-05T12:00:00Z");

    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.currentPaceRatio).toBe(1.5);
    expect(c.projected).toBe(900);
    expect(c.severity).toBe("at_risk");
    expect(c.runwayDay).not.toBeNull();
  });

  it("does not escalate a small same-day pace fluctuation into a warning", async () => {
    await plan(500);
    for (const month of ["02", "03", "04"]) {
      await spend("300.00", `2026-${month}-05T12:00:00Z`);
      await spend("300.00", `2026-${month}-20T12:00:00Z`);
    }
    await spend("315.00", "2026-05-05T12:00:00Z");

    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.currentPaceRatio).toBe(1.05);
    expect(c.projected).toBe(630);
    expect(c.severity).toBe("on_track");
  });

  it("does not double count a known scheduled charge already represented by the pattern", async () => {
    await plan(500);
    for (const month of ["02", "03", "04"]) {
      await spend("100.00", `2026-${month}-20T12:00:00Z`);
    }
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId,
        categoryId: dining,
        amount: "100.00",
        scheduledDate: new Date("2026-05-20"),
      },
    });

    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.plannedOneOffs).toBe(100);
    expect(c.projected).toBe(100);
  });

  it("returns insufficient_history for a brand-new capped category with no data", async () => {
    await plan(500);
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.severity).toBe("insufficient_history");
    expect(c.runwayDay).toBeNull();
  });

  it("runwayDay is null when already over cap", async () => {
    await plan(100);
    await spend("150.00", "2026-05-03T12:00:00Z");
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.runwayDay).toBeNull();
    expect(c.severity).toBe("at_risk");
  });

  it("returns empty categories + on_track portfolio when no budget plan exists", async () => {
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    expect(f.categories).toEqual([]);
    expect(f.portfolio.severity).toBe("on_track");
  });

  it("portfolio projection sums category forecasts plus uncapped committed spend", async () => {
    await plan(2000);
    for (const month of ["02", "03", "04"]) {
      await spend("100.00", `2026-${month}-05T12:00:00Z`);
      await spend("100.00", `2026-${month}-20T12:00:00Z`);
    }
    await spend("50.00", "2026-05-05T12:00:00Z");
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct,
        amount: "25.00",
        merchantRaw: "Uncategorized",
        occurredAt: new Date("2026-05-06T12:00:00Z"),
        source: "manual",
        pending: false,
        rawData: {},
      },
    });
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    expect(f.categories[0]?.projected).toBe(100);
    expect(f.portfolio.spent).toBe(75);
    expect(f.portfolio.projected).toBe(125);
  });

  it("exposes a per-category typical (median) transaction amount", async () => {
    await plan(500);
    for (const a of ["10.00", "20.00", "60.00"]) {
      const t = await prisma.transaction.create({
        data: {
          workspaceId: wsId,
          accountId: acct,
          amount: a,
          merchantRaw: "M",
          occurredAt: new Date("2026-05-04T12:00:00Z"),
          source: "manual",
          pending: false,
          rawData: {},
        },
      });
      await prisma.transactionAllocation.create({
        data: { transactionId: t.id, categoryId: dining, amount: a },
      });
    }
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.typicalAmount).toBeCloseTo(20, 2);
  });
});
