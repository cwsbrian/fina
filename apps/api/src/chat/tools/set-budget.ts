import { z } from "zod";
import { prisma } from "../../db.js";
import { setBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    category_id: z.string().min(1).optional(),
    category_name: z.string().min(1).max(40).optional(),
    amount: z.number().positive().max(99_999_999.99),
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
    "Set the monthly budget for a category. Upserts on (workspace, category, month). Use category_id when known, else category_name (case-insensitive). period defaults to this_month.",
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
    const out = await setBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { categoryId, amount: args.amount, period: args.period ?? "this_month" },
    );
    return {
      budget: { ...out.budget, categoryName },
    };
  },
};
