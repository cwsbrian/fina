import { z } from "zod";
import { prisma } from "../../db.js";
import { getBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

export const getBudget: ToolDef<
  Args,
  { budgets: Array<{ id: string; categoryId: string; categoryName: string; amount: string; periodStart: string }> }
> = {
  name: "getBudget",
  description:
    "List monthly budgets. Returns a single-element array when category_id or category_name is provided, else all budgets for the period.",
  args: Args,
  async run(ctx, args) {
    if (args.category_id && args.category_name) throw new Error("invalid_body");
    let categoryId: string | undefined = args.category_id;
    if (!categoryId && args.category_name) {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (!cat) return { budgets: [] };
      categoryId = cat.id;
    }
    const out = await getBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { categoryId, period: args.period ?? "this_month" },
    );
    const ids = out.budgets.map((b) => b.categoryId);
    const cats = await prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      budgets: out.budgets.map((b) => ({ ...b, categoryName: nameById.get(b.categoryId) ?? "" })),
    };
  },
};
