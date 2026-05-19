import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { reviewPeriodRange, type ReviewPeriod } from "./periods.js";

const Args = z.object({
  period: z
    .enum(["this_week", "this_month", "last_month", "all_time"])
    .describe("Time window to search for uncategorized transactions. Defaults to this_month.")
    .optional(),
  review_mode: z
    .enum(["missing_category", "not_manual"])
    .describe(
      "missing_category returns categoryId=null. not_manual returns transactions whose categorizationSource is not manual, including uncategorized.",
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
    categoryId: string | null;
    categorizationSource: "mapping" | "ai" | "manual" | null;
  }>;
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
        categoryId: r.categoryId,
        categorizationSource: (r.categorizationSource ?? null) as Result["transactions"][number]["categorizationSource"],
      })),
    };
  },
};
