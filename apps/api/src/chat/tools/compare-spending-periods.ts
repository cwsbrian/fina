import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { normalizeMerchant } from "../../categorize/normalize.js";
import type { ToolDef } from "./types.js";
import { comparisonRanges, type ComparisonPeriod, type CurrentPeriod } from "./periods.js";

const Args = z.object({
  current_period: z.enum(["this_week", "this_month"]).describe("Current period to compare."),
  comparison_period: z
    .enum(["previous_week", "last_month"])
    .describe("Comparison period. Use previous_week with this_week, last_month with this_month."),
  group_by: z.enum(["category", "merchant"]).describe("Dimension to compare spending by."),
  limit: z
    .number()
    .int()
    .positive()
    .max(25)
    .describe("Maximum changed buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Change = {
  key: string;
  label: string;
  currentTotal: string;
  comparisonTotal: string;
  delta: string;
  percentChange: number | null;
  currentCount: number;
  comparisonCount: number;
};

type Result = {
  currentPeriod: CurrentPeriod;
  comparisonPeriod: ComparisonPeriod;
  groupBy: "category" | "merchant";
  currency: "CAD";
  currentTotal: string;
  comparisonTotal: string;
  delta: string;
  percentChange: number | null;
  currentExcludedNonCadCount: number;
  comparisonExcludedNonCadCount: number;
  changes: Change[];
};

function isValidPair(c: CurrentPeriod, p: ComparisonPeriod): boolean {
  return (c === "this_week" && p === "previous_week") || (c === "this_month" && p === "last_month");
}

type Row = {
  amount: Prisma.Decimal;
  categoryId: string | null;
  category: { id: string; name: string } | null;
  merchantRaw: string;
  merchantNormalized: string | null;
  occurredAt: Date;
};

type Bucket = { key: string; label: string; total: Prisma.Decimal; count: number };

function bucketize(rows: Row[], groupBy: "category" | "merchant"): {
  map: Map<string, Bucket>;
  total: Prisma.Decimal;
} {
  const map = new Map<string, Bucket>();
  let total = new Prisma.Decimal(0);
  for (const r of rows) {
    let key: string;
    let label: string;
    if (groupBy === "category") {
      key = r.categoryId ?? "uncategorized";
      label = r.category?.name ?? "Uncategorized";
    } else {
      const norm = r.merchantNormalized ?? normalizeMerchant(r.merchantRaw);
      key = norm;
      label = r.merchantRaw;
    }
    const cur = map.get(key);
    if (cur) {
      cur.total = cur.total.plus(r.amount);
      cur.count += 1;
      // prefer the most recent raw merchant as label for merchant mode
      if (groupBy === "merchant" && r.occurredAt.getTime() >= (cur as Bucket & { _ts?: number })._ts!) {
        cur.label = r.merchantRaw;
        (cur as Bucket & { _ts?: number })._ts = r.occurredAt.getTime();
      }
    } else {
      const b: Bucket & { _ts?: number } = { key, label, total: new Prisma.Decimal(r.amount), count: 1 };
      if (groupBy === "merchant") b._ts = r.occurredAt.getTime();
      map.set(key, b);
    }
    total = total.plus(r.amount);
  }
  return { map, total };
}

export const compareSpendingPeriods: ToolDef<Args, Result> = {
  name: "compareSpendingPeriods",
  description:
    "Compare CAD spending between two matching periods by category or merchant and return the largest changes.",
  args: Args,
  async run(ctx, args) {
    if (!isValidPair(args.current_period, args.comparison_period)) {
      throw new Error("invalid_period_pair");
    }
    const limit = args.limit ?? 10;
    const ranges = await comparisonRanges(ctx.userId, args.current_period, args.comparison_period);

    const selectSpec = {
      amount: true,
      categoryId: true,
      category: { select: { id: true, name: true } },
      merchantRaw: true,
      merchantNormalized: true,
      occurredAt: true,
    };

    const [currentRows, comparisonRows, currentExcluded, comparisonExcluded] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: "CAD",
          amount: { gt: 0 },
          occurredAt: { gte: ranges.current.gte, lt: ranges.current.lt },
        },
        select: selectSpec,
      }),
      prisma.transaction.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: "CAD",
          amount: { gt: 0 },
          occurredAt: { gte: ranges.comparison.gte, lt: ranges.comparison.lt },
        },
        select: selectSpec,
      }),
      prisma.transaction.count({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: { not: "CAD" },
          amount: { gt: 0 },
          occurredAt: { gte: ranges.current.gte, lt: ranges.current.lt },
        },
      }),
      prisma.transaction.count({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: { not: "CAD" },
          amount: { gt: 0 },
          occurredAt: { gte: ranges.comparison.gte, lt: ranges.comparison.lt },
        },
      }),
    ]);

    const current = bucketize(currentRows as Row[], args.group_by);
    const comparison = bucketize(comparisonRows as Row[], args.group_by);

    const allKeys = new Set<string>([...current.map.keys(), ...comparison.map.keys()]);
    const changes: Change[] = [];
    for (const key of allKeys) {
      const c = current.map.get(key);
      const p = comparison.map.get(key);
      const cTotal = c?.total ?? new Prisma.Decimal(0);
      const pTotal = p?.total ?? new Prisma.Decimal(0);
      const delta = cTotal.minus(pTotal);
      const pTotalNum = parseFloat(pTotal.toFixed(2));
      const percentChange = pTotalNum === 0 ? null : parseFloat(delta.toFixed(2)) / pTotalNum;
      const label = c?.label ?? p?.label ?? key;
      changes.push({
        key,
        label,
        currentTotal: cTotal.toFixed(2),
        comparisonTotal: pTotal.toFixed(2),
        delta: delta.toFixed(2),
        percentChange,
        currentCount: c?.count ?? 0,
        comparisonCount: p?.count ?? 0,
      });
    }
    changes.sort((a, b) => {
      const ad = Math.abs(parseFloat(a.delta));
      const bd = Math.abs(parseFloat(b.delta));
      if (bd !== ad) return bd - ad;
      return a.label.localeCompare(b.label);
    });

    const overallDelta = current.total.minus(comparison.total);
    const compTotalNum = parseFloat(comparison.total.toFixed(2));
    const overallPercent = compTotalNum === 0 ? null : parseFloat(overallDelta.toFixed(2)) / compTotalNum;

    return {
      currentPeriod: args.current_period,
      comparisonPeriod: args.comparison_period,
      groupBy: args.group_by,
      currency: "CAD",
      currentTotal: current.total.toFixed(2),
      comparisonTotal: comparison.total.toFixed(2),
      delta: overallDelta.toFixed(2),
      percentChange: overallPercent,
      currentExcludedNonCadCount: currentExcluded,
      comparisonExcludedNonCadCount: comparisonExcluded,
      changes: changes.slice(0, limit),
    };
  },
};
