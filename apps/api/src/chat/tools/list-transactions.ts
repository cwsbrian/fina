import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { basicPeriodRange, resolveUserTz } from "./periods.js";
import {
  MAX_TX_ROWS_IN_BLOCK,
  recentLabelContext,
  txRowToBlockRow,
} from "./tx-row-helpers.js";
import type { ToolDef } from "./types.js";
import { budgetExpenseTransactionWhere } from "../../transactions/budget-impact.js";

const Args = z.object({
  period: z.enum(["today", "this_week", "this_month", "last_month"]).describe("Time window for the listing. Omit for all-time.").optional(),
  limit: z.number().int().positive().max(50).describe("Max transactions to return. Default 20, hard cap 50.").optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  transactions: Array<{
    id: string;
    amount: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    needsReclassification: boolean;
    allocations: Array<{ id: string; categoryId: string | null; amount: string; source: string | null }>;
  }>;
  /** Omitted when there are zero results — empty card adds noise. */
  block?: PresentationBlock;
};

export const listTransactions: ToolDef<Args, Result> = {
  name: "listTransactions",
  description:
    "List the user's recent transactions, optionally filtered by time period. " +
    "Use for 'show recent transactions', '최근 거래', 'list transactions'. " +
    "For text-search or date-range queries, use findTransactions instead.",
  args: Args,
  async run(ctx, args) {
    const where = budgetExpenseTransactionWhere({ workspaceId: ctx.workspaceId });
    if (args.period) where.occurredAt = await basicPeriodRange(ctx.userId, args.period);
    const limit = args.limit ?? 20;
    const rows = await prisma.transaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        amount: true,
        merchantRaw: true,
        merchantNormalized: true,
        occurredAt: true,
        needsReclassification: true,
        account: { select: { name: true } },
        allocations: {
          select: {
            id: true,
            categoryId: true,
            amount: true,
            source: true,
            category: { select: { name: true, color: true, icon: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    const tz = await resolveUserTz(ctx.userId);
    const labelCtx = recentLabelContext(new Date(), tz);
    const blockRows = rows.slice(0, MAX_TX_ROWS_IN_BLOCK).map((r) => {
      const primaryAlloc = r.allocations.find((a) => a.categoryId !== null);
      const cat = primaryAlloc?.category;
      return txRowToBlockRow(
        {
          id: r.id,
          occurredAt: r.occurredAt,
          amount: r.amount.toString(),
          merchant: r.merchantRaw,
          category: cat
            ? { name: cat.name, color: cat.color ?? null, icon: cat.icon ?? null }
            : null,
          account: r.account.name,
          needsReview: r.needsReclassification,
        },
        labelCtx,
        tz,
      );
    });

    const periodLabel = periodToLabel(args.period);
    const block: PresentationBlock | undefined =
      rows.length === 0
        ? undefined
        : {
            type: "transactions_list",
            title: "Recent transactions",
            ...(periodLabel ? { period_label: periodLabel } : {}),
            total_count: rows.length,
            currency: "CAD",
            rows: blockRows,
            ...(rows.length > blockRows.length
              ? { footer: `Showing ${blockRows.length} of ${rows.length}` }
              : {}),
          };

    return {
      transactions: rows.map((r) => ({
        id: r.id,
        amount: r.amount.toString(),
        merchantRaw: r.merchantRaw,
        merchantNormalized: r.merchantNormalized,
        occurredAt: r.occurredAt.toISOString(),
        needsReclassification: r.needsReclassification,
        allocations: r.allocations.map((a) => ({
          id: a.id,
          categoryId: a.categoryId,
          amount: a.amount.toString(),
          source: a.source,
        })),
      })),
      ...(block ? { block } : {}),
    };
  },
};

function periodToLabel(p: Args["period"]): string | undefined {
  switch (p) {
    case "today":      return "Today";
    case "this_week":  return "This week";
    case "this_month": return "This month";
    case "last_month": return "Last month";
    default:           return undefined;
  }
}
