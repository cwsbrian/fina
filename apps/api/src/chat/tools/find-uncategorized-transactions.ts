import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { reviewPeriodRange, resolveUserTz, type ReviewPeriod } from "./periods.js";
import {
  MAX_TX_ROWS_IN_BLOCK,
  recentLabelContext,
  txRowToBlockRow,
} from "./tx-row-helpers.js";

const Args = z.object({
  period: z
    .enum(["this_week", "this_month", "last_month", "all_time"])
    .describe("Time window to search for uncategorized transactions. Defaults to this_month.")
    .optional(),
  review_mode: z
    .enum(["missing_category", "not_manual"])
    .describe(
      "missing_category returns transactions with a null-category allocation. not_manual returns transactions whose allocation source is not manual, including uncategorized.",
    )
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .describe("Maximum transactions to return. Defaults to 20, hard cap 50.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  period: ReviewPeriod;
  reviewMode: "missing_category" | "not_manual";
  transactions: Array<{
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    accountName: string;
  }>;
  /** Omitted when there are zero results — the LLM's text reply ("all
   *  caught up", "no matches") is sufficient on its own and a tall empty
   *  card just adds visual noise. */
  block?: PresentationBlock;
};

export const findUncategorizedTransactions: ToolDef<Args, Result> = {
  name: "findUncategorizedTransactions",
  description: "Find transactions that are uncategorized or have not been manually reviewed.",
  args: Args,
  async run(ctx, args) {
    const period: ReviewPeriod = args.period ?? "this_month";
    const reviewMode = args.review_mode ?? "missing_category";
    const limit = args.limit ?? 20;
    const [range, workspace] = await Promise.all([
      reviewPeriodRange(ctx.userId, period),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      removedAt: null,
    };
    if (range.gte !== undefined && range.lt !== undefined) {
      where.occurredAt = { gte: range.gte, lt: range.lt };
    }
    if (reviewMode === "missing_category") {
      where.allocations = { some: { categoryId: null } };
    } else {
      where.allocations = {
        some: {
          // Postgres semantics: NULL != 'manual' evaluates to NULL (not TRUE), so
          // `source: { not: "manual" }` silently excludes NULL source rows. Include
          // `source: null` explicitly to cover uncategorized-but-not-yet-AI/manual rows.
          OR: [
            { source: { not: "manual" } },
            { source: null },
            { categoryId: null },
          ],
        },
      };
    }

    const rows = await prisma.transaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit,
      include: { account: { select: { name: true } } },
    });

    const tz = await resolveUserTz(ctx.userId);
    const labelCtx = recentLabelContext(new Date(), tz);
    const blockRows = rows.slice(0, MAX_TX_ROWS_IN_BLOCK).map((r) =>
      txRowToBlockRow(
        {
          id: r.id,
          occurredAt: r.occurredAt,
          amount: r.amount.toString(),
          merchant: r.merchantRaw,
          category: null, // by definition: uncategorized / needs-review
          account: r.account.name,
          needsReview: true,
        },
        labelCtx,
        tz,
      ),
    );

    const block: PresentationBlock | undefined =
      rows.length === 0
        ? undefined
        : {
            type: "transactions_list",
            title: "Needs review",
            ...(periodToLabel(period) ? { period_label: periodToLabel(period)! } : {}),
            total_count: rows.length,
            currency: workspace.currency,
            rows: blockRows,
            ...(rows.length > blockRows.length
              ? { footer: `Showing ${blockRows.length} of ${rows.length}` }
              : {}),
          };

    return {
      period,
      reviewMode,
      transactions: rows.map((r) => ({
        id: r.id,
        amount: r.amount.toString(),
        currency: workspace.currency,
        merchantRaw: r.merchantRaw,
        merchantNormalized: r.merchantNormalized,
        occurredAt: r.occurredAt.toISOString(),
        accountName: r.account.name,
      })),
      ...(block ? { block } : {}),
    };
  },
};

function periodToLabel(p: ReviewPeriod): string | undefined {
  switch (p) {
    case "today":      return "Today";
    case "this_week":  return "This week";
    case "this_month": return "This month";
    case "last_month": return "Last month";
    case "all_time":   return undefined;
    default:           return undefined;
  }
}
