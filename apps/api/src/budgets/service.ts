import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { firstOfMonthDateInTz, basicPeriodRange, resolveUserTz, partsInTz } from "../chat/tools/periods.js";

export type PeriodEnum = "this_month" | "last_month" | "next_month";

const MAX_AMOUNT = 99_999_999.99;

function offsetFor(period: PeriodEnum): number {
  if (period === "last_month") return -1;
  if (period === "next_month") return 1;
  return 0;
}

export type SetBudgetInput = { categoryId: string; amount: number; period: PeriodEnum };
export type SetBudgetOutput = { budget: { id: string; categoryId: string; amount: string; periodStart: string } };

export async function setBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: SetBudgetInput,
): Promise<SetBudgetOutput> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw new Error("invalid_amount");
  }
  const periodStart = await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));

  const cat = await prisma.category.findFirst({
    where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!cat) throw new Error("category_not_found");

  const row = await prisma.budget.upsert({
    where: {
      workspaceId_categoryId_periodStart: {
        workspaceId: ctx.workspaceId,
        categoryId: input.categoryId,
        periodStart,
      },
    },
    create: {
      workspaceId: ctx.workspaceId,
      categoryId: input.categoryId,
      amount: new Prisma.Decimal(input.amount),
      periodStart,
    },
    update: { amount: new Prisma.Decimal(input.amount) },
  });

  return {
    budget: {
      id: row.id,
      categoryId: row.categoryId,
      amount: row.amount.toFixed(2),
      periodStart: row.periodStart.toISOString().slice(0, 10),
    },
  };
}

export type GetBudgetInput =
  | { categoryId?: string; period: PeriodEnum }
  | { categoryId?: string; periodStart: Date };
export type GetBudgetOutput = { budgets: Array<{ id: string; categoryId: string; amount: string; periodStart: string }> };

export async function getBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: GetBudgetInput,
): Promise<GetBudgetOutput> {
  const periodStart =
    "periodStart" in input
      ? input.periodStart
      : await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));
  const where: { workspaceId: string; periodStart: Date; categoryId?: string } = {
    workspaceId: ctx.workspaceId,
    periodStart,
  };
  if (input.categoryId) where.categoryId = input.categoryId;
  const rows = await prisma.budget.findMany({
    where,
    orderBy: [{ categoryId: "asc" }],
    select: { id: true, categoryId: true, amount: true, periodStart: true },
  });
  return {
    budgets: rows.map((r) => ({
      id: r.id,
      categoryId: r.categoryId,
      amount: r.amount.toFixed(2),
      periodStart: r.periodStart.toISOString().slice(0, 10),
    })),
  };
}

export type DeleteBudgetInput = { budgetId: string };

export async function deleteBudgetService(
  ctx: { workspaceId: string },
  input: DeleteBudgetInput,
): Promise<boolean> {
  const { count } = await prisma.budget.deleteMany({
    where: { id: input.budgetId, workspaceId: ctx.workspaceId },
  });
  return count > 0;
}

export type CompareSpendingInput = { period: PeriodEnum };
export type CompareSpendingOutput = {
  period: { start: string; end: string };
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;
    spent: string;
    remaining: string;
    spentPct: number;
    todayPct: number;
    status: "on-pace" | "over-pace";
  }>;
};

function daysInMonth(year: number, monthOneBased: number): number {
  // monthOneBased is 1..12. Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

export async function compareSpendingVsBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: CompareSpendingInput,
): Promise<CompareSpendingOutput> {
  const periodStart = await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));
  // Transaction filter range per period:
  let gte: Date;
  let lt: Date;
  if (input.period === "this_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "this_month"));
  } else if (input.period === "last_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "last_month"));
  } else {
    // next_month: explicit empty range so spent=0 regardless of current spending.
    gte = periodStart;
    lt = periodStart;
  }

  const budgets = await prisma.budget.findMany({
    where: { workspaceId: ctx.workspaceId, periodStart },
    include: { category: { select: { name: true } } },
    orderBy: [{ categoryId: "asc" }],
  });
  if (budgets.length === 0) {
    return {
      period: {
        start: periodStart.toISOString().slice(0, 10),
        end: lt.toISOString().slice(0, 10),
      },
      items: [],
    };
  }

  const budgetCategoryIds = budgets.map((b) => b.categoryId);
  const sums = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: {
      workspaceId: ctx.workspaceId,
      removedAt: null,
      occurredAt: { gte, lt },
      categoryId: { in: budgetCategoryIds },
      currency: "CAD",
      amount: { gt: 0 },
    },
    _sum: { amount: true },
  });
  const spentByCat = new Map<string, Prisma.Decimal>(
    sums.map((s) => [s.categoryId!, s._sum.amount ?? new Prisma.Decimal(0)]),
  );

  // todayPct — user-tz local day-of-month / days-in-month, not elapsed ms.
  const py = periodStart.getUTCFullYear();
  const pm = periodStart.getUTCMonth() + 1;
  const dim = daysInMonth(py, pm);
  let todayPct = 0;
  if (input.period === "this_month") {
    const tz = await resolveUserTz(ctx.userId);
    const nowParts = partsInTz(new Date(), tz);
    todayPct = Math.round((nowParts.day / dim) * 10000) / 100;
  } else if (input.period === "last_month") {
    todayPct = 100;
  }

  const items = budgets.map((b) => {
    const spent = spentByCat.get(b.categoryId) ?? new Prisma.Decimal(0);
    const remaining = b.amount.minus(spent);
    const spentPct = b.amount.greaterThan(0)
      ? Number(spent.div(b.amount).times(100).toFixed(2))
      : 0;
    const status: "on-pace" | "over-pace" = spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
    return {
      categoryId: b.categoryId,
      categoryName: b.category.name,
      amount: b.amount.toFixed(2),
      spent: spent.toFixed(2),
      remaining: remaining.toFixed(2),
      spentPct,
      todayPct,
      status,
    };
  });

  return {
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: lt.toISOString().slice(0, 10),
    },
    items,
  };
}
