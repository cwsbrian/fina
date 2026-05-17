import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudgetService, getBudgetService, deleteBudgetService } from "../src/budgets/service.js";

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

  it("rejects amount > 99999999.99 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 100_000_000, period: "this_month" }),
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
