import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month"]).describe("Period to summarize."),
  group_by: z.enum(["category", "merchant", "day"]).describe("Bucket dimension. Defaults to 'category'.").optional(),
});

type Args = z.infer<typeof Args>;

function periodRange(period: Args["period"]): { gte: Date; lt: Date } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === "this_week") { const day = now.getDay(); const monday = new Date(y, m, now.getDate() - ((day + 6) % 7)); return { gte: monday, lt: new Date(y, m, monday.getDate() + 7) }; }
  if (period === "this_month") return { gte: new Date(y, m, 1), lt: new Date(y, m + 1, 1) };
  return { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
}

export const getSpendingSummary: ToolDef<Args, { period: Args["period"]; groupBy: NonNullable<Args["group_by"]>; groups: Array<{ key: string; total: string; count: number }> }> = {
  name: "getSpendingSummary",
  description: "Total spending in a period bucketed by category, merchant, or day.",
  args: Args,
  async run(ctx, args) {
    const groupBy = args.group_by ?? "category";
    const { gte, lt } = periodRange(args.period);
    const rows = await prisma.transaction.findMany({ where: { workspaceId: ctx.workspaceId, removedAt: null, occurredAt: { gte, lt } }, select: { amount: true, categoryId: true, merchantNormalized: true, occurredAt: true } });
    const buckets = new Map<string, { total: Prisma.Decimal; count: number }>();
    for (const r of rows) {
      let key: string;
      if (groupBy === "category") key = r.categoryId ?? "uncategorized";
      else if (groupBy === "merchant") key = r.merchantNormalized ?? "unknown";
      else key = r.occurredAt.toISOString().slice(0, 10);
      const cur = buckets.get(key);
      if (cur) { cur.total = cur.total.plus(r.amount); cur.count += 1; }
      else buckets.set(key, { total: new Prisma.Decimal(r.amount), count: 1 });
    }
    const groups = [...buckets.entries()].map(([key, v]) => ({ key, total: v.total.toFixed(2), count: v.count })).sort((a, b) => parseFloat(b.total) - parseFloat(a.total));
    return { period: args.period, groupBy, groups };
  },
};
