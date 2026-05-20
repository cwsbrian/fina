import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { basicPeriodRange, type BasicPeriod } from "./periods.js";

const Args = z.object({
  period: z
    .enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize spending by category."),
  include_uncategorized: z
    .boolean()
    .describe("Whether to include uncategorized spending as its own bucket. Defaults to true.")
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(25)
    .describe("Maximum category buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Bucket = {
  categoryId: string | null;
  categoryName: string;
  parentCategoryId: string | null;
  parentCategoryName: string | null;
  color: string | null;
  icon: string | null;
  total: string;
  count: number;
  share: number;
};

type Result = {
  period: BasicPeriod;
  currency: string;
  total: string;
  categories: Bucket[];
};

export const getCategoryBreakdown: ToolDef<Args, Result> = {
  name: "getCategoryBreakdown",
  description:
    "Summarize CAD spending by readable category name, including parent category and visual metadata.",
  args: Args,
  async run(ctx, args) {
    const includeUncat = args.include_uncategorized ?? true;
    const limit = args.limit ?? 10;
    const [{ gte, lt }, workspace] = await Promise.all([
      basicPeriodRange(ctx.userId, args.period),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    const allocWhere: Prisma.TransactionAllocationWhereInput = {
      amount: { gt: 0 },
      transaction: {
        workspaceId: ctx.workspaceId,
        removedAt: null,
        amount: { gt: 0 },
        occurredAt: { gte, lt },
      },
    };
    if (!includeUncat) allocWhere.categoryId = { not: null };

    const allocRows = await prisma.transactionAllocation.groupBy({
      by: ["categoryId"],
      where: allocWhere,
      _sum: { amount: true },
      _count: { _all: true },
    });

    // Fetch category metadata for all non-null categoryIds
    const catIds = allocRows.map((r) => r.categoryId).filter((id): id is string => id !== null);
    const catMap = new Map<string, { id: string; name: string; color: string | null; icon: string | null; parentId: string | null; parent: { id: string; name: string } | null }>();
    if (catIds.length > 0) {
      const cats = await prisma.category.findMany({
        where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
        select: {
          id: true,
          name: true,
          color: true,
          icon: true,
          parentId: true,
          parent: { select: { id: true, name: true } },
        },
      });
      for (const c of cats) catMap.set(c.id, c);
    }

    const buckets = new Map<string, { meta: Omit<Bucket, "total" | "count" | "share">; total: Prisma.Decimal; count: number }>();
    let total = new Prisma.Decimal(0);
    for (const r of allocRows) {
      const key = r.categoryId ?? "__uncat__";
      const cat = r.categoryId ? catMap.get(r.categoryId) : undefined;
      const meta: Omit<Bucket, "total" | "count" | "share"> = cat
        ? {
            categoryId: cat.id,
            categoryName: cat.name,
            parentCategoryId: cat.parent?.id ?? null,
            parentCategoryName: cat.parent?.name ?? null,
            color: cat.color,
            icon: cat.icon,
          }
        : {
            categoryId: null,
            categoryName: "Uncategorized",
            parentCategoryId: null,
            parentCategoryName: null,
            color: null,
            icon: null,
          };
      const rowTotal = r._sum.amount ?? new Prisma.Decimal(0);
      const rowCount = r._count._all;
      buckets.set(key, { meta, total: new Prisma.Decimal(rowTotal), count: rowCount });
      total = total.plus(rowTotal);
    }

    const entries = [...buckets.values()];

    const totalNum = parseFloat(total.toFixed(2));
    entries.sort((a, b) => {
      const diff = parseFloat(b.total.toFixed(2)) - parseFloat(a.total.toFixed(2));
      if (diff !== 0) return diff;
      return a.meta.categoryName.localeCompare(b.meta.categoryName);
    });

    const categories: Bucket[] = entries.slice(0, limit).map((e) => ({
      ...e.meta,
      total: e.total.toFixed(2),
      count: e.count,
      share: totalNum > 0 ? parseFloat(e.total.toFixed(2)) / totalNum : 0,
    }));

    return {
      period: args.period,
      currency: workspace.currency,
      total: total.toFixed(2),
      categories,
    };
  },
};
