import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { getBudgetService, spentByCategoryForPeriod } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

export const getBudget: ToolDef<
  Args,
  {
    budgets: Array<{ id: string; categoryId: string; categoryName: string; amount: string; periodStart: string }>;
    block?: PresentationBlock;
  }
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
    // Omit `categoryId` from the service input when it is undefined —
    // GetBudgetInput is `{ categoryId?: string; ... }` and tsconfig.base.json
    // sets `exactOptionalPropertyTypes: true`, so an explicit
    // `categoryId: undefined` is a type error.
    const period = args.period ?? "this_month";
    const out = await getBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      categoryId ? { categoryId, period } : { period },
    );
    const ids = out.budgets.map((b) => b.categoryId);
    const [cats, workspace] = await Promise.all([
      prisma.category.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, color: true, icon: true },
      }),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const budgets = out.budgets.map((b) => ({
      ...b,
      categoryName: catById.get(b.categoryId)?.name ?? "",
    }));

    if (budgets.length === 0) return { budgets };

    const spentMap = await spentByCategoryForPeriod(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      period,
      ids,
    );
    const periodLabel =
      period === "this_month" ? "This month" : period === "last_month" ? "Last month" : "Next month";
    const rows = budgets.map((b) => {
      const cat = catById.get(b.categoryId);
      const spent = spentMap.get(b.categoryId) ?? new Prisma.Decimal(0);
      const amountDec = new Prisma.Decimal(b.amount);
      const barPct = amountDec.greaterThan(0)
        ? Number(spent.div(amountDec).times(100).toFixed(2))
        : 0;
      return {
        id: b.id,
        category: { name: b.categoryName, color: cat?.color ?? null, icon: cat?.icon ?? null },
        amount: b.amount,
        spent: spent.toFixed(2),
        bar_pct: barPct,
        over: spent.greaterThan(amountDec),
      };
    });
    const block: PresentationBlock = {
      type: "budget_list",
      title: "Budgets",
      period_label: periodLabel,
      currency: workspace.currency,
      rows,
    };
    return { budgets, block };
  },
};
