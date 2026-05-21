import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudgetService, getBudgetService, deleteBudgetService, compareSpendingVsBudgetService } from "../src/budgets/service.js";

describe("setBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryId: string;

  beforeEach(async () => {
    const stamp = `bs-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BS", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bs-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    const cat = await prisma.category.create({ data: { workspaceId, name: "Coffee" } });
    categoryId = cat.id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a new budget for this_month at Toronto May 1", async () => {
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 500, period: "this_month" },
    );
    expect(r.budget.categoryId).toBe(categoryId);
    expect(r.budget.amount).toBe("500.00");
    expect(r.budget.periodStart).toBe("2026-05-01");
  });

  it("upserts on conflict: second call updates amount", async () => {
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 500, period: "this_month" });
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 600, period: "this_month" },
    );
    expect(r.budget.amount).toBe("600.00");
    const all = await prisma.budget.findMany({ where: { workspaceId } });
    expect(all).toHaveLength(1);
  });

  it("rejects amount = 0 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 0, period: "this_month" }),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount < 0 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: -1, period: "this_month" }),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount > MAX_AMOUNT (999_999_999.99) with invalid_amount", async () => {
    await expect(
      setBudgetService(
        { workspaceId, userId },
        { categoryId, amount: 1_000_000_000, period: "this_month" },
      ),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects archived category with category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 500, period: "this_month" }),
    ).rejects.toThrow("category_not_found");
  });

  it("rejects cross-workspace category with category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "X" } });
    await expect(
      setBudgetService(
        { workspaceId, userId },
        { categoryId: otherCat.id, amount: 500, period: "this_month" },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("computes periodStart in Toronto tz when server is UTC", async () => {
    // Pinned 2026-05-01T03:00:00Z = Apr 30 23:00 local Toronto.
    vi.setSystemTime(new Date("2026-05-01T03:00:00Z"));
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 200, period: "this_month" },
    );
    // Toronto sees April → periodStart = 2026-04-01.
    expect(r.budget.periodStart).toBe("2026-04-01");
  });

  it("supports last_month and next_month offsets", async () => {
    const last = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 100, period: "last_month" },
    );
    expect(last.budget.periodStart).toBe("2026-04-01");
    const next = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 200, period: "next_month" },
    );
    expect(next.budget.periodStart).toBe("2026-06-01");
  });
});

describe("getBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryAId: string;
  let categoryBId: string;

  beforeEach(async () => {
    const stamp = `bg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BG", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bg-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryAId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    categoryBId = (await prisma.category.create({ data: { workspaceId, name: "Food" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId: categoryAId, amount: 100, period: "this_month" });
    await setBudgetService({ workspaceId, userId }, { categoryId: categoryBId, amount: 200, period: "this_month" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns single budget when categoryId provided", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { categoryId: categoryAId, period: "this_month" });
    expect(r.budgets).toHaveLength(1);
    expect(r.budgets[0]!.categoryId).toBe(categoryAId);
    expect(r.budgets[0]!.amount).toBe("100.00");
  });

  it("returns all budgets for period when no categoryId", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.budgets).toHaveLength(2);
    const ids = r.budgets.map((b) => b.categoryId).sort();
    expect(ids).toEqual([categoryAId, categoryBId].sort());
  });

  it("returns empty array for a month with no budgets", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { period: "last_month" });
    expect(r.budgets).toEqual([]);
  });

  it("accepts an explicit periodStart Date (route variant)", async () => {
    const r = await getBudgetService(
      { workspaceId, userId },
      { periodStart: new Date("2026-05-01T12:00:00.000Z") },
    );
    expect(r.budgets).toHaveLength(2);
  });
});

describe("deleteBudgetService", () => {
  let workspaceId: string;
  let budgetId: string;

  beforeEach(async () => {
    const stamp = `bd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "BD", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "bd-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    const cat = await prisma.category.create({ data: { workspaceId, name: "X" } });
    const b = await prisma.budget.create({
      data: { workspaceId, categoryId: cat.id, amount: "10.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
    });
    budgetId = b.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  it("deletes a budget by id and returns true", async () => {
    const ok = await deleteBudgetService({ workspaceId }, { budgetId });
    expect(ok).toBe(true);
    expect(await prisma.budget.findUnique({ where: { id: budgetId } })).toBeNull();
  });

  it("returns false for cross-workspace id", async () => {
    const ok = await deleteBudgetService({ workspaceId: "other-ws" }, { budgetId });
    expect(ok).toBe(false);
    expect(await prisma.budget.findUnique({ where: { id: budgetId } })).not.toBeNull();
  });
});

describe("compareSpendingVsBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `bc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BC", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bc-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    acctId = (await prisma.bankAccount.create({ data: { workspaceId, name: "x", type: "depository" } })).id;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function seedTx(occurredAt: Date, amount: string, overrideCategoryId?: string): Promise<void> {
    const catId = overrideCategoryId ?? categoryId;
    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `tx-${Math.random()}`,
        amount,
        merchantRaw: "M",
        occurredAt,
        rawData: {},
      },
    });
    // Seed allocation (single source of truth after Task 8).
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: catId, amount, source: "manual" },
    });
  }

  it("mid-month on-pace (spent ≤ pace + 5%)", async () => {
    // May 15 noon UTC = 8 AM Toronto May 15. todayPct = 15/31 ≈ 48.4%.
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "30.00"); // 30% of budget

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it.amount).toBe("100.00");
    expect(it.spent).toBe("30.00");
    expect(it.status).toBe("on-pace");
  });

  it("mid-month over-pace (spent > pace + 5%)", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "80.00"); // 80% vs ~48% pace

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items[0]!.status).toBe("over-pace");
  });

  it("last_month uses full-month baseline (todayPct = 100)", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "last_month" });
    await seedTx(new Date("2026-04-15T12:00:00Z"), "90.00");

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "last_month" });
    expect(r.items[0]!.todayPct).toBe(100);
    expect(r.items[0]!.status).toBe("on-pace"); // 90 < 100 * 1.05
  });

  it("excludes categories without a budget for the period", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const otherCat = await prisma.category.create({ data: { workspaceId, name: "Food" } });
    // Budget set only for Coffee; spending exists on Food too — Food should not appear.
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId, accountId: acctId, plaidTransactionId: "x",
        amount: "50.00", merchantRaw: "M",
        occurredAt: new Date("2026-05-10T12:00:00Z"), rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: otherTx.id } });
    await prisma.transactionAllocation.create({
      data: { transactionId: otherTx.id, categoryId: otherCat.id, amount: "50.00", source: "manual" },
    });

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.categoryId).toBe(categoryId);
  });

  it("split tx allocates across multiple budget categories", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const groceriesCat = await prisma.category.create({ data: { workspaceId, name: "Groceries" } });
    const householdCat = await prisma.category.create({ data: { workspaceId, name: "Household" } });
    await setBudgetService({ workspaceId, userId }, { categoryId: groceriesCat.id, amount: 200, period: "this_month" });
    await setBudgetService({ workspaceId, userId }, { categoryId: householdCat.id, amount: 150, period: "this_month" });

    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `split-${Date.now()}`,
        amount: "200",
        merchantRaw: "Costco",
        merchantNormalized: "costco",
        occurredAt: new Date("2026-05-15T12:00:00Z"),
        pending: false,
        source: "manual",
        rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: groceriesCat.id, amount: "120", source: "manual" },
        { transactionId: tx.id, categoryId: householdCat.id, amount: "80", source: "manual" },
      ],
    });

    const result = await compareSpendingVsBudgetService(
      { workspaceId, userId },
      { period: "this_month" },
    );
    const g = result.items.find((i) => i.categoryId === groceriesCat.id)!;
    const h = result.items.find((i) => i.categoryId === householdCat.id)!;
    expect(g.spent).toBe("120.00");
    expect(h.spent).toBe("80.00");
  });

  it("filters out negative-amount (refund) transactions", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "-10.00");  // refund — excluded by amount > 0 filter
    await seedTx(new Date("2026-05-10T12:00:00Z"), "20.00");   // counts

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items[0]!.spent).toBe("20.00");
  });

  it("next_month returns spent=0 even when current month has spending", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "next_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "30.00"); // this-month spend

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "next_month" });
    expect(r.items[0]!.spent).toBe("0.00");
    expect(r.items[0]!.todayPct).toBe(0);
  });

  // All tests below use the existing beforeEach-bound userId/workspaceId/categoryId and the seedTx helper.

  it("planned: includes upcoming schedule", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "60",
        scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("60.00");
    expect(item.plannedPct).toBeGreaterThan(0);
  });

  it("planned: excludes past-unresolved", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "70",
        scheduledDate: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");
  });

  it("planned: excludes dismissed", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "40",
        scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
        dismissedAt: new Date(),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");
  });

  it("planned: excludes matched (active tx)", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // seedTx creates tx + allocation in `categoryId`
    await seedTx(
      new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 12, 0, 0)),
      "55",
    );
    const tx = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "55",
        scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
        matchedTxId: tx.id,
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");
  });

  it("planned anti-join: today schedule WITHOUT covering tx → planned=amount", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    await prisma.scheduledSpend.create({
      data: { workspaceId, categoryId, amount: "80", scheduledDate: todayUTC },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("80.00");
  });

  it("planned anti-join: today schedule WITH covering tx → planned=0", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    await prisma.scheduledSpend.create({
      data: { workspaceId, categoryId, amount: "80", scheduledDate: todayUTC },
    });
    // seedTx creates tx + allocation in categoryId — required for the anti-join to find it
    await seedTx(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0)),
      "80",
    );
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");
  });

  it("planned: two same-day same-cat schedules + one covering tx → second still planned", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 500, period: "this_month" });
    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    // seedTx creates a tx + allocation with the right category
    await seedTx(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0)),
      "30",
    );
    const tx = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });

    // First schedule matched (cron-equivalent)
    await prisma.scheduledSpend.create({
      data: { workspaceId, categoryId, amount: "100", scheduledDate: todayUTC, matchedTxId: tx.id },
    });
    // Second schedule unmatched
    await prisma.scheduledSpend.create({
      data: { workspaceId, categoryId, amount: "60", scheduledDate: todayUTC },
    });

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    // The matched tx is consumed by the first schedule; second's $60 still contributes.
    expect(item.planned).toBe("60.00");
  });

  it("planned: day-1-of-this_month schedule is eligible (periodStart noon-UTC vs scheduledDate midnight-UTC)", async () => {
    // Regression test: periodStart from firstOfMonthDateInTz returns noon UTC,
    // but @db.Date scheduledDate round-trips at midnight UTC. The lower bound
    // must be normalised to midnight or May-1 schedules get excluded on May 1.
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "75",
        scheduledDate: new Date(Date.UTC(2026, 4, 1)),  // May 1 midnight UTC
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("75.00");
  });

  it("planned: next_month period picks up day-1-of-next-month schedule", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 400, period: "next_month" });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "120",
        scheduledDate: new Date(Date.UTC(2026, 5, 1)),  // June 1 midnight UTC
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "next_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("120.00");
  });

  it("planned: matched-then-soft-removed → schedule re-becomes a planned candidate", async () => {
    // §5.4 soft-removal cleanup hook contract: when the matched tx is removed,
    // schedule.matchedTxId is nulled in the same DB tx, so the next
    // compareSpendingVsBudget read sees the schedule's amount back in `planned`.
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 200, period: "this_month" });

    // Seed today's tx + matched schedule.
    const todayOccurredAt = new Date("2026-05-15T18:00:00Z");
    await seedTx(todayOccurredAt, "60");
    const txRow = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId }, orderBy: { createdAt: "desc" },
    });
    const todayUTC = new Date(Date.UTC(2026, 4, 15));
    const sched = await prisma.scheduledSpend.create({
      data: { workspaceId, categoryId, amount: "60", scheduledDate: todayUTC, matchedTxId: txRow.id },
    });
    // Sanity check: matched schedule contributes nothing to planned.
    let r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    let item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");

    // Soft-remove the matched tx; the cleanup hook nulls matchedTxId.
    const { removeTransactionService } = await import("../src/transactions/remove.js");
    await removeTransactionService({ workspaceId }, txRow.id);
    const after = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: sched.id } });
    expect(after.matchedTxId).toBeNull();

    // The schedule is now an upcoming-today candidate; planned reflects it.
    r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("60.00");
  });

  it("planned: last_month period returns 0 (schedule window collapses)", async () => {
    // last_month periodEnd = May 1, but today (May 15) > May 1, so
    // scheduleLowerBound >= scheduleUpperBound and the anti-join short-circuits.
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 300, period: "last_month" });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId, categoryId,
        amount: "200",
        scheduledDate: new Date(Date.UTC(2026, 3, 20)),  // April 20 — inside last_month window
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "last_month" });
    const item = r.items.find((i) => i.categoryId === categoryId)!;
    expect(item.planned).toBe("0.00");
  });
});
