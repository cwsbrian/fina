import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { firstOfMonthDateInTz } from "../chat/tools/periods.js";

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
