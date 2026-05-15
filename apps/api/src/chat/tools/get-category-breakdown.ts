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
  currency: "CAD";
  total: string;
  excludedNonCadCount: number;
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
    const { gte, lt } = await basicPeriodRange(ctx.userId, args.period);

    const txWhere: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      removedAt: null,
      currency: "CAD",
      amount: { gt: 0 },
      occurredAt: { gte, lt },
    };
    if (!includeUncat) txWhere.categoryId = { not: null };

    const [rows, excludedNonCadCount] = await Promise.all([
      prisma.transaction.findMany({
        where: txWhere,
        select: {
          amount: true,
          categoryId: true,
          category: {
            select: {
              id: true,
              name: true,
              color: true,
              icon: true,
              parentId: true,
              parent: { select: { id: true, name: true } },
            },
          },
        },
      }),
      prisma.transaction.count({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: { not: "CAD" },
          amount: { gt: 0 },
          occurredAt: { gte, lt },
        },
      }),
    ]);

    const buckets = new Map<string, { meta: Omit<Bucket, "total" | "count" | "share">; total: Prisma.Decimal; count: number }>();
    let total = new Prisma.Decimal(0);
    for (const r of rows) {
      const key = r.categoryId ?? "__uncat__";
      const meta: Omit<Bucket, "total" | "count" | "share"> = r.category
        ? {
            categoryId: r.category.id,
            categoryName: r.category.name,
            parentCategoryId: r.category.parent?.id ?? null,
            parentCategoryName: r.category.parent?.name ?? null,
            color: r.category.color,
            icon: r.category.icon,
          }
        : {
            categoryId: null,
            categoryName: "Uncategorized",
            parentCategoryId: null,
            parentCategoryName: null,
            color: null,
            icon: null,
          };
      const cur = buckets.get(key);
      if (cur) {
        cur.total = cur.total.plus(r.amount);
        cur.count += 1;
      } else {
        buckets.set(key, { meta, total: new Prisma.Decimal(r.amount), count: 1 });
      }
      total = total.plus(r.amount);
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
      currency: "CAD",
      total: total.toFixed(2),
      excludedNonCadCount,
      categories,
    };
  },
};
