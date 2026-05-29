import { z } from "zod";
import { MAX_AMOUNT } from "@fina/shared";
import { prisma } from "../../db.js";
import {
  getOrSnapshotMonthBudget,
  setMonthBudget,
  periodToYearMonth,
  type CategoryAllocation,
} from "../../budget-plans/service.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    category_id: z.string().min(1).optional(),
    category_name: z.string().min(1).max(40).optional(),
    amount: z.number().positive().max(MAX_AMOUNT),
    period: z.enum(["this_month", "last_month", "next_month"]).optional(),
  })
  .refine((a) => Boolean(a.category_id) !== Boolean(a.category_name), {
    message: "Provide exactly one of category_id or category_name",
  });

type Args = z.infer<typeof Args>;

export const setBudget: ToolDef<
  Args,
  { budget: { id: string; categoryId: string; categoryName: string; amount: string; periodStart: string } }
> = {
  name: "setBudget",
  description:
    "Set the monthly budget cap for a category. Updates the BudgetPlan category allocation for the month (the same budget shown on the Budget screen and by getBudget). period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    let categoryId = args.category_id;
    let categoryName: string;
    if (categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryName = cat.name;
    } else {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name!, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }
    const period = args.period ?? "this_month";
    const { year, month } = periodToYearMonth(period);
    // Read-modify-write on the month's BudgetPlan. Two near-simultaneous
    // setBudget consumes for the same month could clobber each other's
    // categoryAllocations (last write wins the whole JSON column). Postgres
    // has no atomic JSON-merge here; this is an accepted tradeoff for a
    // personal-finance chat tool where concurrent edits are not realistic.
    const plan = await getOrSnapshotMonthBudget(ctx.workspaceId, year, month);
    const existingTotal = plan ? parseFloat(plan.totalAmount) : 0;
    const allocations: CategoryAllocation[] = plan ? [...plan.categoryAllocations] : [];
    const idx = allocations.findIndex((a) => a.categoryId === categoryId);
    if (idx >= 0) allocations[idx] = { categoryId, amount: args.amount };
    else allocations.push({ categoryId, amount: args.amount });
    // Round to cents to absorb float accumulation; Decimal(14,2) rounds on
    // write anyway, but keep the in-memory value clean.
    const sum = Math.round(allocations.reduce((s, a) => s + a.amount, 0) * 100) / 100;
    // Preserve an explicit larger cap; only grow the total when allocations
    // would exceed it (you can't allocate more than the cap).
    const totalAmount = Math.max(existingTotal, sum);
    const saved = await setMonthBudget(ctx.workspaceId, year, month, { totalAmount, categoryAllocations: allocations });
    return {
      budget: {
        id: saved.id,
        categoryId,
        categoryName,
        amount: args.amount.toFixed(2),
        periodStart: saved.periodStart,
      },
    };
  },
};
