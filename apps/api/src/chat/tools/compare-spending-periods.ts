import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { normalizeMerchant } from "../../categorize/normalize.js";
import type { ToolDef } from "./types.js";
import { customRange, SINCE_ARG_DESC, UNTIL_ARG_DESC } from "./periods.js";
import { formatPeriodLabel } from "./recap-label.js";
import {
  effectiveExpenseAllocations,
  effectiveExpenseTransactions,
} from "../../transactions/cashflow.js";

const Args = z.object({
  current_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "CURRENT range: " + SINCE_ARG_DESC,
  ),
  current_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "CURRENT range: " + UNTIL_ARG_DESC,
  ),
  comparison_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "COMPARISON range (the older period): " + SINCE_ARG_DESC,
  ),
  comparison_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "COMPARISON range (the older period): " + UNTIL_ARG_DESC,
  ),
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
  currentSince: string;
  currentUntil: string;
  comparisonSince: string;
  comparisonUntil: string;
  groupBy: "category" | "merchant";
  currency: string;
  currentTotal: string;
  comparisonTotal: string;
  delta: string;
  percentChange: number | null;
  changes: Change[];
  block: PresentationBlock;
};

type Row = {
  amount: Prisma.Decimal;
  categoryId?: string | null;
  category?: { id: string; name: string } | null;
  merchantRaw: string;
  merchantNormalized: string | null;
  occurredAt: Date;
};

type Bucket = {
  key: string;
  label: string;
  total: Prisma.Decimal;
  count: number;
  /** Merchant mode only: tracks the most recent transaction's timestamp so
   *  the displayed label can adopt the merchantRaw seen on that newest tx.
   *  Always populated for merchant mode; left undefined in category mode. */
  lastSeenTs?: number;
};

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
      label = r.category?.name ?? (r.categoryId ? "Unknown" : "Uncategorized");
    } else {
      const norm = r.merchantNormalized ?? normalizeMerchant(r.merchantRaw);
      key = norm;
      label = r.merchantRaw;
    }
    const cur = map.get(key);
    if (cur) {
      cur.total = cur.total.plus(r.amount);
      cur.count += 1;
      // Prefer the most recent raw merchant as label for merchant mode.
      // cur.lastSeenTs is guaranteed set on first-insertion below for
      // merchant mode, so no non-null assertion needed.
      if (
        groupBy === "merchant" &&
        cur.lastSeenTs !== undefined &&
        r.occurredAt.getTime() >= cur.lastSeenTs
      ) {
        cur.label = r.merchantRaw;
        cur.lastSeenTs = r.occurredAt.getTime();
      }
    } else {
      const b: Bucket = { key, label, total: new Prisma.Decimal(r.amount), count: 1 };
      if (groupBy === "merchant") b.lastSeenTs = r.occurredAt.getTime();
      map.set(key, b);
    }
    total = total.plus(r.amount);
  }
  return { map, total };
}

async function bucketizeByAllocation(
  workspaceId: string,
  gte: Date,
  lt: Date,
): Promise<{ map: Map<string, Bucket>; total: Prisma.Decimal }> {
  const allocRows = await effectiveExpenseAllocations(workspaceId, {
    occurredAt: { gte, lt },
  });

  const map = new Map<string, Bucket>();
  let total = new Prisma.Decimal(0);
  for (const r of allocRows) {
    const key = r.categoryId ?? "uncategorized";
    const label = r.categoryName ?? "Uncategorized";
    const rowTotal = new Prisma.Decimal(r.amount);
    const bucket = map.get(key);
    if (bucket) {
      bucket.total = bucket.total.plus(rowTotal);
      bucket.count += 1;
    } else {
      map.set(key, { key, label, total: rowTotal, count: 1 });
    }
    total = total.plus(rowTotal);
  }
  return { map, total };
}

export const compareSpendingPeriods: ToolDef<Args, Result> = {
  name: "compareSpendingPeriods",
  description:
    "Compare CAD spending between two arbitrary date ranges by category or merchant and return the largest changes. " +
    "Use this WHENEVER the user asks about change between periods — even with shorthand phrasing. " +
    "Trigger phrases (EN): 'vs last month', 'vs last week', 'compared to', 'how does X compare to Y', " +
    "'has it gone up?', 'biggest changes', 'what got more expensive', 'difference vs', 'change from'. " +
    "Trigger phrases (KR): '지난달 대비', '지난주랑 비교', '지난달과 비교', '비교해줘', '얼마나 늘었어', " +
    "'얼마나 줄었어', '큰 변화', '변동', '이번달이 더 썼어?'. " +
    "Do NOT call getSpendingSummary twice when one of these phrases appears — call this tool instead. " +
    "Provide YYYY-MM-DD dates for both ranges; comparison range must be older than current range; " +
    "ranges may be different lengths but matched lengths produce more interpretable deltas " +
    "(e.g. compare a full month to a full month, not a month vs a quarter).",
  args: Args,
  async run(ctx, args) {
    const limit = args.limit ?? 10;
    const [currentRange, comparisonRange, workspace] = await Promise.all([
      customRange(ctx.userId, args.current_since, args.current_until),
      customRange(ctx.userId, args.comparison_since, args.comparison_until),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    let current: { map: Map<string, Bucket>; total: Prisma.Decimal };
    let comparison: { map: Map<string, Bucket>; total: Prisma.Decimal };

    if (args.group_by === "category") {
      [current, comparison] = await Promise.all([
        bucketizeByAllocation(ctx.workspaceId, currentRange.gte, currentRange.lt),
        bucketizeByAllocation(ctx.workspaceId, comparisonRange.gte, comparisonRange.lt),
      ]);
    } else {
      const [currentRows, comparisonRows] = await Promise.all([
        effectiveExpenseTransactions(ctx.workspaceId, {
          occurredAt: { gte: currentRange.gte, lt: currentRange.lt },
        }),
        effectiveExpenseTransactions(ctx.workspaceId, {
          occurredAt: { gte: comparisonRange.gte, lt: comparisonRange.lt },
        }),
      ]);
      current = bucketize(currentRows.map((row) => ({
        ...row,
        amount: new Prisma.Decimal(row.amount),
      })), args.group_by);
      comparison = bucketize(comparisonRows.map((row) => ({
        ...row,
        amount: new Prisma.Decimal(row.amount),
      })), args.group_by);
    }

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

    const limitedChanges = changes.slice(0, limit);
    return {
      currentSince: args.current_since,
      currentUntil: args.current_until,
      comparisonSince: args.comparison_since,
      comparisonUntil: args.comparison_until,
      groupBy: args.group_by,
      currency: workspace.currency,
      currentTotal: current.total.toFixed(2),
      comparisonTotal: comparison.total.toFixed(2),
      delta: overallDelta.toFixed(2),
      percentChange: overallPercent,
      changes: limitedChanges,
      block: toRecapBlock(
        args.current_since,
        args.current_until,
        args.comparison_since,
        args.comparison_until,
        workspace.currency,
        current.total.toFixed(2),
        overallDelta.toFixed(2),
        limitedChanges,
        changes.length,
      ),
    };
  },
};

function toRecapBlock(
  currentSince: string,
  currentUntil: string,
  comparisonSince: string,
  comparisonUntil: string,
  currency: string,
  currentTotal: string,
  overallDelta: string,
  changes: Change[],
  totalChanges: number,
): PresentationBlock {
  const periodLabel = `${formatPeriodLabel(currentSince, currentUntil)} vs ${formatPeriodLabel(comparisonSince, comparisonUntil)}`;
  const deltaNum = parseFloat(overallDelta);

  return {
    type: "recap",
    title: "Spending change",
    period_label: periodLabel,
    headline: {
      label: formatPeriodLabel(currentSince, currentUntil),
      amount: currentTotal,
      currency,
      ...(deltaNum !== 0
        ? {
            delta: {
              value: Math.abs(deltaNum).toFixed(2),
              direction: (deltaNum > 0 ? "up" : "down") as "up" | "down",
            },
          }
        : {}),
    },
    rows: changes.map((c) => {
      const d = parseFloat(c.delta);
      return {
        label: c.label,
        amount: c.currentTotal,
        sub: `vs ${c.comparisonTotal}`,
        ...(d !== 0
          ? {
              delta: {
                value: Math.abs(d).toFixed(2),
                direction: (d > 0 ? "up" : "down") as "up" | "down",
              },
            }
          : {}),
      };
    }),
    ...(totalChanges > changes.length
      ? { footer: `Top ${changes.length} of ${totalChanges} changes` }
      : {}),
  };
}
