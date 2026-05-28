import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { resolveUserTz, localMidnightToUtc } from "./periods.js";
import {
  MAX_TX_ROWS_IN_BLOCK,
  recentLabelContext,
  txRowToBlockRow,
} from "./tx-row-helpers.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  merchant_query: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Substring to match on merchant name. Matched case-insensitively against both the raw merchant string and the normalized merchant key. Example: 'starbucks' matches 'STARBUCKS #1234 SEATTLE'.",
    )
    .optional(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Earliest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Example: '2026-04-01'.")
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Latest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Must be >= start_date if both provided.")
    .optional(),
  amount_min: z
    .number()
    .nonnegative()
    .describe(
      "Minimum absolute transaction amount (CAD). Inclusive. Matches expenses or refunds whose abs(amount) is >= this value.",
    )
    .optional(),
  amount_max: z
    .number()
    .nonnegative()
    .describe("Maximum absolute transaction amount (CAD). Inclusive. Must be >= amount_min if both provided.")
    .optional(),
  category_name: z
    .string()
    .min(1)
    .max(80)
    .describe("Exact category name (case-insensitive). Empty array result if the name doesn't match an existing category.")
    .optional(),
  account_name: z
    .string()
    .min(1)
    .max(80)
    .describe("Exact bank account name (case-insensitive). Empty array result if the name doesn't match an existing account.")
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .describe("Maximum transactions to return. Default 20, hard cap 50.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  transactions: Array<{
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    accountName: string;
    accountId: string;
    categoryId: string | null;
    categoryName: string | null;
  }>;
  totalCount: number;
  hasMore: boolean;
  filtersApplied: {
    merchantQuery: string | null;
    startDate: string | null;
    endDate: string | null;
    amountMin: number | null;
    amountMax: number | null;
    categoryName: string | null;
    accountName: string | null;
    limit: number;
  };
  block: PresentationBlock;
};

function isValidIsoDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function resolveFilters(args: Args, limit: number): Result["filtersApplied"] {
  return {
    merchantQuery: args.merchant_query ?? null,
    startDate: args.start_date ?? null,
    endDate: args.end_date ?? null,
    amountMin: args.amount_min ?? null,
    amountMax: args.amount_max ?? null,
    categoryName: args.category_name ?? null,
    accountName: args.account_name ?? null,
    limit,
  };
}

function emptyResult(args: Args, limit: number, currency: string): Result {
  return {
    transactions: [],
    totalCount: 0,
    hasMore: false,
    filtersApplied: resolveFilters(args, limit),
    block: {
      type: "transactions_list",
      title: searchTitle(args),
      total_count: 0,
      currency,
      rows: [],
      footer: "No transactions match.",
    },
  };
}

/** Title that names the active filters so the card subtitle reads
 *  naturally — "Search: starbucks", "All transactions", etc. */
function searchTitle(args: Args): string {
  if (args.merchant_query) return `Search: ${args.merchant_query}`;
  if (args.category_name) return `Category: ${args.category_name}`;
  if (args.account_name) return `Account: ${args.account_name}`;
  return "Transactions";
}

function searchPeriodLabel(args: Args): string | undefined {
  if (args.start_date && args.end_date) return `${args.start_date} — ${args.end_date}`;
  if (args.start_date) return `Since ${args.start_date}`;
  if (args.end_date) return `Through ${args.end_date}`;
  return undefined;
}

export const findTransactions: ToolDef<Args, Result> = {
  name: "findTransactions",
  description:
    "Search transactions with filters: merchant text, date range, amount range, category name, account name. " +
    "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing. " +
    "Date ranges are interpreted in your local timezone.",
  args: Args,
  async run(ctx, args) {
    const limit = args.limit ?? 20;
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });

    // Strict date + range validation (after Zod regex).
    if (args.start_date && !isValidIsoDate(args.start_date)) throw new Error("invalid_date");
    if (args.end_date && !isValidIsoDate(args.end_date)) throw new Error("invalid_date");
    if (args.start_date && args.end_date && args.start_date > args.end_date) {
      throw new Error("invalid_date_range");
    }
    if (args.amount_min != null && args.amount_max != null && args.amount_max < args.amount_min) {
      throw new Error("invalid_amount_range");
    }

    // Resolve name lookups → ids. Empty result on zero matches.
    let categoryIds: string[] | undefined;
    if (args.category_name) {
      const cats = await prisma.category.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          name: { equals: args.category_name, mode: "insensitive" },
          archivedAt: null,
        },
        select: { id: true },
      });
      if (cats.length === 0) return emptyResult(args, limit, workspace.currency);
      categoryIds = cats.map((c) => c.id);
    }
    let accountIds: string[] | undefined;
    if (args.account_name) {
      const accts = await prisma.bankAccount.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          name: { equals: args.account_name, mode: "insensitive" },
          archivedAt: null,
        },
        select: { id: true },
      });
      if (accts.length === 0) return emptyResult(args, limit, workspace.currency);
      accountIds = accts.map((a) => a.id);
    }

    // Build a separate Prisma.DateTimeFilter — TransactionWhereInput["occurredAt"] is a union
    // (Date | string | DateTimeFilter), which TS refuses to spread.
    // tz-aware: use resolveUserTz + localMidnightToUtc so KST/etc. users get correct day boundaries.
    const tz = await resolveUserTz(ctx.userId);
    const occurredAt: Prisma.DateTimeFilter = {};
    if (args.start_date) {
      const [y, m, d] = args.start_date.split("-").map(Number);
      occurredAt.gte = localMidnightToUtc(y!, m!, d!, tz);
    }
    if (args.end_date) {
      const [y, m, d] = args.end_date.split("-").map(Number);
      // Exclusive upper bound: start of the next day in user tz. The +1 on the
      // day passes through localMidnightToUtc's DST-aware date math.
      occurredAt.lt = localMidnightToUtc(y!, m!, d! + 1, tz);
    }

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      removedAt: null,
    };
    if (categoryIds) where.allocations = { some: { categoryId: { in: categoryIds } } };
    if (accountIds) where.accountId = { in: accountIds };
    if (occurredAt.gte || occurredAt.lt) where.occurredAt = occurredAt;

    // Amount filter on abs(amount): two ranges OR'd, one for expenses (positive),
    // one for refunds (negative).
    if (args.amount_min != null || args.amount_max != null) {
      const min = args.amount_min ?? 0;
      const max = args.amount_max ?? Number.MAX_SAFE_INTEGER;
      where.OR = [
        { amount: { gte: min, lte: max } },
        { amount: { gte: -max, lte: -min } },
      ];
    }

    // Merchant ILIKE on both raw and normalized columns. If `where.OR` already exists
    // (amount range), wrap in AND so the two ORs are AND'd together.
    if (args.merchant_query) {
      const merchantOr = [
        { merchantRaw: { contains: args.merchant_query, mode: "insensitive" as const } },
        { merchantNormalized: { contains: args.merchant_query, mode: "insensitive" as const } },
      ];
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: merchantOr }];
        delete where.OR;
      } else {
        where.OR = merchantOr;
      }
    }

    const [rows, totalCount] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        include: {
          account: { select: { id: true, name: true } },
          allocations: {
            select: {
              categoryId: true,
              category: { select: { id: true, name: true, color: true, icon: true } },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      prisma.transaction.count({ where }),
    ]);

    const transactions: Result["transactions"] = rows.map((r) => {
      const primaryAlloc = r.allocations.find((a) => a.categoryId !== null);
      return {
        id: r.id,
        amount: r.amount.toString(),
        currency: workspace.currency,
        merchantRaw: r.merchantRaw,
        merchantNormalized: r.merchantNormalized,
        occurredAt: r.occurredAt.toISOString(),
        accountName: r.account.name,
        accountId: r.account.id,
        categoryId: primaryAlloc?.category?.id ?? null,
        categoryName: primaryAlloc?.category?.name ?? null,
      };
    });

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
          needsReview: false,
        },
        labelCtx,
        tz,
      );
    });

    const periodLabel = searchPeriodLabel(args);
    const block: PresentationBlock = {
      type: "transactions_list",
      title: searchTitle(args),
      ...(periodLabel ? { period_label: periodLabel } : {}),
      total_count: totalCount,
      currency: workspace.currency,
      rows: blockRows,
      ...(totalCount > blockRows.length
        ? { footer: `Showing ${blockRows.length} of ${totalCount}` }
        : {}),
    };

    return {
      transactions,
      totalCount,
      hasMore: totalCount > rows.length,
      filtersApplied: resolveFilters(args, limit),
      block,
    };
  },
};
