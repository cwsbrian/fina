import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { customRange, dateKeyInTz, resolveUserTz, SINCE_ARG_DESC, UNTIL_ARG_DESC } from "./periods.js";
import { formatPeriodLabel } from "./recap-label.js";
import type { ToolDef } from "./types.js";
import { budgetExpenseAllocationWhere, budgetExpenseTransactionWhere } from "../../transactions/budget-impact.js";

const Args = z.object({
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(SINCE_ARG_DESC),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(UNTIL_ARG_DESC),
  group_by: z
    .enum(["category", "merchant", "day"])
    .describe("Bucket dimension. Defaults to 'category'.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Group = { key: string; total: string; count: number };

type Result = {
  since: string;
  until: string;
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
  description:
    "Total CAD spending in a date range, bucketed by category, merchant, or day. " +
    "Use whenever the user asks how much they spent over a period — single range only; for cross-period comparisons use compareSpendingPeriods. " +
    "Pass YYYY-MM-DD dates from the 'Today' anchor in your context.",
  args: Args,
  async run(ctx, args) {
    const groupBy = args.group_by ?? "category";
    // customRange + resolveUserTz both query user.tz; collapse into a single
    // call by reusing the tz already known from customRange's lookup. We
    // re-call resolveUserTz here only because customRange doesn't surface it
    // — surfacing would change the public signature on a hot helper, more
    // churn than the saving justifies.
    const { gte, lt } = await customRange(ctx.userId, args.since, args.until);
    const tz = await resolveUserTz(ctx.userId);

    let groups: Group[];
    /** Display labels for the recap rows. category groupings need an extra
     *  name lookup; merchant/day already have the human-readable key. */
    let rowLabels: Map<string, string>;

    if (groupBy === "category") {
      const allocRows = await prisma.transactionAllocation.groupBy({
        by: ["categoryId"],
        where: budgetExpenseAllocationWhere({
            workspaceId: ctx.workspaceId,
            occurredAt: { gte, lt },
        }),
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
        where: budgetExpenseTransactionWhere({ workspaceId: ctx.workspaceId, occurredAt: { gte, lt } }),
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

    const block = toRecapBlock(groups, rowLabels, args.since, args.until, groupBy);
    return { since: args.since, until: args.until, groupBy, groups, block };
  },
};

function toRecapBlock(
  groups: Group[],
  labels: Map<string, string>,
  since: string,
  until: string,
  groupBy: NonNullable<Args["group_by"]>,
): PresentationBlock {
  const totalCents = groups.reduce(
    (sum, g) => sum + Math.round(parseFloat(g.total) * 100),
    0,
  );
  const total = (totalCents / 100).toFixed(2);
  const top = groups.slice(0, MAX_RECAP_ROWS);
  const maxAmount = top[0] ? parseFloat(top[0].total) : 0;

  return {
    type: "recap",
    title: `Spending · ${groupByToTitle(groupBy)}`,
    period_label: formatPeriodLabel(since, until),
    headline: {
      label: "Total",
      amount: total,
      currency: "CAD",
    },
    rows: top.map((g) => ({
      label: labels.get(g.key) ?? g.key,
      amount: g.total,
      sub: `${g.count} ${g.count === 1 ? "tx" : "txs"}`,
      bar_pct: maxAmount > 0 ? (parseFloat(g.total) / maxAmount) * 100 : 0,
    })),
    ...(groups.length > top.length
      ? { footer: `Top ${top.length} of ${groups.length}` }
      : {}),
  };
}

function groupByToTitle(g: NonNullable<Args["group_by"]>): string {
  switch (g) {
    case "category": return "by category";
    case "merchant": return "by merchant";
    case "day":      return "by day";
  }
}
