import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { budgetPlanSnapshot, periodToYearMonth } from "../src/budget-plans/service.js";

describe("budgetPlanSnapshot", () => {
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `bps-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "BPS" } });
    const ws = await prisma.workspace.create({ data: { name: "bps-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining", color: "#cc33aa", icon: "🍽️" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns null when no plan exists", async () => {
    expect(await budgetPlanSnapshot(wsId, 2026, 5)).toBeNull();
  });

  it("merges plan total + per-category cap + spend", async () => {
    await prisma.budgetPlan.create({
      data: {
        workspaceId: wsId,
        periodStart: new Date("2026-05-01T12:00:00.000Z"),
        totalAmount: "9000.00",
        categoryAllocations: [{ categoryId: dining, amount: 577 }],
      },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "541.33", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "541.33" } });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct,
        amount: "-41.33",
        merchantRaw: "Resto refund",
        occurredAt: new Date("2026-05-12T12:00:00Z"),
        source: "manual",
        pending: false,
        rawData: {},
        budgetImpact: "refund",
      },
    });

    const snap = await budgetPlanSnapshot(wsId, 2026, 5);
    expect(snap).not.toBeNull();
    expect(snap!.totalAmount).toBe("9000.00");
    expect(snap!.totalSpent).toBe("500.00");
    const d = snap!.categories.find((c) => c.categoryId === dining)!;
    expect(d.allocated).toBe("577.00");
    expect(d.spent).toBe("500.00");
    expect(d.color).toBe("#cc33aa");
  });

  it("includes uncategorized spend as a category", async () => {
    await prisma.budgetPlan.create({
      data: {
        workspaceId: wsId,
        periodStart: new Date("2026-05-01T12:00:00.000Z"),
        totalAmount: "9000.00",
        categoryAllocations: [],
      },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "25.40", merchantRaw: "Unknown", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: null, amount: "25.40" },
    });

    const snap = await budgetPlanSnapshot(wsId, 2026, 5);
    expect(snap!.categories).toContainEqual({
      categoryId: "__uncategorized__",
      categoryName: "Uncategorized",
      color: null,
      icon: null,
      allocated: null,
      spent: "25.40",
      scheduled: "0.00",
    });
  });

  it("periodToYearMonth maps relative to UTC now", () => {
    expect(periodToYearMonth("this_month", "UTC")).toEqual({ year: 2026, month: 5 });
    expect(periodToYearMonth("last_month", "UTC")).toEqual({ year: 2026, month: 4 });
    expect(periodToYearMonth("next_month", "UTC")).toEqual({ year: 2026, month: 6 });
  });

  it("includes unmatched scheduled spend in totalScheduled + per-category", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 577 }] },
    });
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: dining, amount: "100.00", scheduledDate: new Date("2026-05-20"), matchedTxId: null, dismissedAt: null },
    });
    const snap = await budgetPlanSnapshot(wsId, 2026, 5);
    expect(snap!.totalScheduled).toBe("100.00");
    expect(snap!.categories.find((c) => c.categoryId === dining)!.scheduled).toBe("100.00");
  });

  it("periodToYearMonth handles the year boundary", () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    expect(periodToYearMonth("last_month", "UTC")).toEqual({ year: 2025, month: 12 });
    vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
    expect(periodToYearMonth("next_month", "UTC")).toEqual({ year: 2027, month: 1 });
  });

  it("keeps the device-timezone month when UTC is already next month", () => {
    vi.setSystemTime(new Date("2026-08-01T03:30:00Z"));
    expect(periodToYearMonth("this_month", "America/Vancouver")).toEqual({
      year: 2026,
      month: 7,
    });
  });
});
