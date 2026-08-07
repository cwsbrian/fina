import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { customRange, SINCE_ARG_DESC, UNTIL_ARG_DESC } from "./periods.js";
import { formatPeriodLabel } from "./recap-label.js";
import { effectiveExpenseAllocations } from "../../transactions/cashflow.js";

const Args = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(SINCE_ARG_DESC),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(UNTIL_ARG_DESC),
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
  since: string;
  until: string;
  currency: string;
  total: string;
  categories: Bucket[];
  block: PresentationBlock;
};

export const getCategoryBreakdown: ToolDef<Args, Result> = {
  name: "getCategoryBreakdown",
  description:
    "Summarize spending in the workspace currency by readable category name for a date range, including parent category and visual metadata. " +
    "Pass YYYY-MM-DD since/until from the 'Today' anchor in your context.",
  args: Args,
  async run(ctx, args) {
    const includeUncat = args.include_uncategorized ?? true;
    const limit = args.limit ?? 10;
    const [{ gte, lt }, workspace] = await Promise.all([
      customRange(ctx.userId, args.since, args.until),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    const allocRows = (await effectiveExpenseAllocations(ctx.workspaceId, {
      occurredAt: { gte, lt },
    })).filter((row) => includeUncat || row.categoryId !== null);

    // Fetch category metadata for all non-null categoryIds
    const catIds = [...new Set(allocRows.map((r) => r.categoryId).filter((id): id is string => id !== null))];
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

    const buckets = new Map<string, { meta: Omit<Bucket, "total" | "count" | "share">; total: number; count: number }>();
    let total = 0;
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
      const bucket = buckets.get(key) ?? { meta, total: 0, count: 0 };
      bucket.total += r.amount;
      bucket.count += 1;
      buckets.set(key, bucket);
      total += r.amount;
    }

    const entries = [...buckets.values()];

    const totalNum = Number(total.toFixed(2));
    entries.sort((a, b) => {
      const diff = b.total - a.total;
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
      since: args.since,
      until: args.until,
      currency: workspace.currency,
      total: total.toFixed(2),
      categories,
      block: toRecapBlock(args.since, args.until, workspace.currency, total.toFixed(2), categories, entries.length),
    };
  },
};

function toRecapBlock(
  since: string,
  until: string,
  currency: string,
  total: string,
  categories: Bucket[],
  totalEntries: number,
): PresentationBlock {
  return {
    type: "recap",
    title: "By category",
    period_label: formatPeriodLabel(since, until),
    headline: {
      label: "Total",
      amount: total,
      currency,
    },
    rows: categories.map((c) => ({
      label: c.parentCategoryName
        ? `${c.parentCategoryName} · ${c.categoryName}`
        : c.categoryName,
      amount: c.total,
      sub: `${c.count} ${c.count === 1 ? "tx" : "txs"} · ${Math.round(c.share * 100)}%`,
      bar_pct: Math.round(c.share * 100),
    })),
    ...(totalEntries > categories.length
      ? { footer: `Top ${categories.length} of ${totalEntries}` }
      : {}),
  };
}
