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
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function tx(amount: string, day: string, pending = false) {
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount, merchantRaw: "M", occurredAt: new Date(day), source: "manual", pending, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount } });
    return t;
  }

  it("nets refunds and excludes pending in the 90-day discretionary daily rate", async () => {
    await tx("90.00", "2026-04-20T12:00:00Z");      // counts
    await tx("-30.00", "2026-04-21T12:00:00Z");     // refund nets out
    await tx("60.00", "2026-05-01T12:00:00Z", true); // pending excluded
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining)).toBeCloseTo(60 / 90, 4);
  });

  it("subtracts the category's recurring monthly-equivalent (3 months) so fixed bills don't inflate the rate", async () => {
    await tx("100.00", "2026-03-01T12:00:00Z");
    await tx("100.00", "2026-04-01T12:00:00Z");
    await tx("100.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Rent", nameNormalized: "rent", amount: "100.00", categoryId: dining, cadence: "monthly", nextOccurrenceDate: new Date("2026-06-01T12:00:00Z") },
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
});

describe("subscription vs scheduled split", () => {
  let wsId: string;
  let groceries: string;
  beforeEach(async () => {
    const stamp = `split-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("subscription occurrences are today-forward only", async () => {
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Box", nameNormalized: "box", amount: "40.00", categoryId: groceries, cadence: "weekly", nextOccurrenceDate: new Date("2026-05-18T12:00:00Z") },
    });
    const subs = await monthlySubscriptionByCategory(wsId, 2026, 5);
    // 5/18 and 5/25 fall in [today=5/15, 6/1) → 2 occurrences * 40 = 80.
    expect(subs.get(groceries)).toBeCloseTo(80, 2);
  });

  it("scheduled spend counts unmatched/undismissed items from month start (incl. past-dated this month)", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "50.00", scheduledDate: new Date("2026-05-10") },
    });
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "25.00", scheduledDate: new Date("2026-05-20") },
    });
    const sched = await monthlyScheduledSpendByCategory(wsId, 2026, 5);
    expect(sched.get(groceries)).toBeCloseTo(75, 2);
  });

  it("scheduled spend includes the 1st of this month and excludes the 1st of next month", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "11.00", scheduledDate: new Date("2026-05-01") }, // this month 1st → counted
    });
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "99.00", scheduledDate: new Date("2026-06-01") }, // next month 1st → excluded
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
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "FC", tz: "America/Toronto" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function spend(amount: string, day: string) {
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount, merchantRaw: "M", occurredAt: new Date(day), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount } });
  }
  async function plan(cap: number) {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: cap }] },
    });
  }

  it("a rent-only category projects ~cap, NOT cap+rent (no double-count)", async () => {
    await plan(2000);
    await spend("2000.00", "2026-03-01T12:00:00Z");
    await spend("2000.00", "2026-04-01T12:00:00Z");
    await spend("2000.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Rent", nameNormalized: "rent", amount: "2000.00", categoryId: dining, cadence: "monthly", nextOccurrenceDate: new Date("2026-06-01T12:00:00Z") },
    });
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.projected).toBeCloseTo(2000, 0);
    expect(c.severity).toBe("on_track");
  });

  it("flags at_risk when the discretionary run-rate projects past cap*1.10", async () => {
    await plan(300);
    // Heavy historical dining: $300 x 6 across the trailing 90 days (prior
    // months), nothing yet this month → 90-day discretionary rate ~ $20/day.
    for (const day of ["2026-03-05","2026-03-20","2026-04-05","2026-04-20","2026-04-25","2026-04-28"]) {
      await spend("300.00", `${day}T12:00:00Z`);
    }
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.severity).toBe("at_risk");
    expect(c.projected).toBeGreaterThan(300 * 1.1);
    expect(c.projectedOverspend).toBeGreaterThan(0);
    expect(c.runwayDay).not.toBeNull();
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
});
