import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { basicPeriodRange, dateKeyInTz, resolveUserTz } from "./periods.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month"]).describe("Period to summarize."),
  group_by: z.enum(["category", "merchant", "day"]).describe("Bucket dimension. Defaults to 'category'.").optional(),
});

type Args = z.infer<typeof Args>;

type Group = { key: string; total: string; count: number };

type Result = {
  period: Args["period"];
  groupBy: NonNullable<Args["group_by"]>;
  groups: Group[];
  block: PresentationBlock;
};

/** UI cap — keep the chat card scannable. Tool still returns ALL groups
 *  in `groups` so the LLM can quote totals or call again with a tighter
 *  scope; only the recap CARD is truncated. */
const MAX_RECAP_ROWS = 8;

export const getSpendingSummary: ToolDef<Args, Result> = {
  name: "getSpendingSummary",
  description: "Total spending in a period bucketed by category, merchant, or day.",
  args: Args,
  async run(ctx, args) {
    const groupBy = args.group_by ?? "category";
    const { gte, lt } = await basicPeriodRange(ctx.userId, args.period);
    const tz = await resolveUserTz(ctx.userId);

    let groups: Group[];
    /** Display labels for the recap rows. category groupings need an extra
     *  name lookup; merchant/day already have the human-readable key. */
    let rowLabels: Map<string, string>;

    if (groupBy === "category") {
      const allocRows = await prisma.transactionAllocation.groupBy({
        by: ["categoryId"],
        where: {
          amount: { gt: 0 },
          transaction: {
            workspaceId: ctx.workspaceId,
            removedAt: null,
            occurredAt: { gte, lt },
          },
        },
        _sum: { amount: true },
        _count: { _all: true },
      });
      groups = allocRows
        .map((r) => ({
          key: r.categoryId ?? "uncategorized",
          total: (r._sum.amount ?? new Prisma.Decimal(0)).toFixed(2),
          count: r._count._all,
        }))
        .sort((a, b) => parseFloat(b.total) - parseFloat(a.total));

      // Resolve categoryId → human-readable name. One Prisma query
      // batched across all groups; "uncategorized" handled inline.
      const ids = groups.map((g) => g.key).filter((k) => k !== "uncategorized");
      const cats = ids.length
        ? await prisma.category.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true },
          })
        : [];
      rowLabels = new Map(cats.map((c) => [c.id, c.name]));
      rowLabels.set("uncategorized", "Uncategorized");
    } else {
      const rows = await prisma.transaction.findMany({
        where: { workspaceId: ctx.workspaceId, removedAt: null, occurredAt: { gte, lt } },
        select: { amount: true, merchantNormalized: true, occurredAt: true },
      });
      const buckets = new Map<string, { total: Prisma.Decimal; count: number }>();
      for (const r of rows) {
        let key: string;
        if (groupBy === "merchant") key = r.merchantNormalized ?? "unknown";
        else key = dateKeyInTz(r.occurredAt, tz);
        const cur = buckets.get(key);
        if (cur) { cur.total = cur.total.plus(r.amount); cur.count += 1; }
        else buckets.set(key, { total: new Prisma.Decimal(r.amount), count: 1 });
      }
      groups = [...buckets.entries()]
        .map(([key, v]) => ({ key, total: v.total.toFixed(2), count: v.count }))
        .sort((a, b) => parseFloat(b.total) - parseFloat(a.total));
      rowLabels = new Map(groups.map((g) => [g.key, g.key]));
    }

    const block = toRecapBlock(groups, rowLabels, args.period, groupBy);
    return { period: args.period, groupBy, groups, block };
  },
};

/** Build the presentation block from sorted groups. Title + period label
 *  speak in user terms; bar widths scale to the top row so the eye reads
 *  relative magnitude at a glance. */
function toRecapBlock(
  groups: Group[],
  labels: Map<string, string>,
  period: Args["period"],
  groupBy: NonNullable<Args["group_by"]>,
): PresentationBlock {
  const totalCents = groups.reduce(
    (sum, g) => sum + Math.round(parseFloat(g.total) * 100),
    0,
  );
  const total = (totalCents / 100).toFixed(2);
  const periodLabel = periodToLabel(period);
  const groupByLabel = groupByToTitle(groupBy);
  const top = groups.slice(0, MAX_RECAP_ROWS);
  const maxAmount = top[0] ? parseFloat(top[0].total) : 0;

  return {
    type: "recap",
    title: `Spending · ${groupByLabel}`,
    period_label: periodLabel,
    headline: {
      label: "Total",
      amount: total,
      currency: "CAD",
    },
    rows: top.map((g) => ({
      label: labels.get(g.key) ?? g.key,
      amount: g.total,
      sub: `${g.count} ${g.count === 1 ? "tx" : "tx"}`,
      bar_pct: maxAmount > 0 ? (parseFloat(g.total) / maxAmount) * 100 : 0,
    })),
    ...(groups.length > top.length
      ? { footer: `Top ${top.length} of ${groups.length}` }
      : {}),
  };
}

function periodToLabel(p: Args["period"]): string {
  switch (p) {
    case "this_week":  return "This week";
    case "this_month": return "This month";
    case "last_month": return "Last month";
  }
}

function groupByToTitle(g: NonNullable<Args["group_by"]>): string {
  switch (g) {
    case "category": return "by category";
    case "merchant": return "by merchant";
    case "day":      return "by day";
  }
}
