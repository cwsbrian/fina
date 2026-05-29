import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { resolveUserTz } from "./periods.js";
import { dateLabelForRow, recentLabelContext } from "./tx-row-helpers.js";

const Args = z
  .object({
    tx_id: z
      .string()
      .min(1)
      .describe("Transaction id to inspect. Must belong to the current workspace.")
      .optional(),
    merchant_query: z
      .string()
      .min(1)
      .max(100)
      .describe(
        "Merchant substring to resolve a single transaction by name (case-insensitive, raw + normalized). Use when the user names a transaction but you don't have its id. If it matches more than one transaction the tool returns { ambiguous: true } — then call findTransactions to list them instead.",
      )
      .optional(),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("With merchant_query: earliest occurredAt (inclusive), ISO YYYY-MM-DD.")
      .optional(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe("With merchant_query: latest occurredAt (inclusive), ISO YYYY-MM-DD.")
      .optional(),
  })
  .refine((a) => Boolean(a.tx_id) !== Boolean(a.merchant_query), {
    message: "Provide exactly one of tx_id or merchant_query",
  });

type Args = z.infer<typeof Args>;

type TransactionDetail = {
  id: string;
  amount: string;
  currency: string;
  merchantRaw: string;
  merchantNormalized: string | null;
  occurredAt: string;
  postedAt: string | null;
  pending: boolean;
  source: "plaid" | "manual" | "csv";
  note: string | null;
  removedAt: string | null;
  needsReclassification: boolean;
  allocations: Array<{
    id: string;
    categoryId: string | null;
    amount: string;
    source: string | null;
  }>;
  account: {
    id: string;
    name: string;
    type: string;
    subtype: string | null;
    currency: string;
  };
  category: {
    id: string;
    name: string;
    parentId: string | null;
    parentName: string | null;
  } | null;
};

type Result = {
  transaction?: TransactionDetail;
  block?: PresentationBlock;
  /** Set when merchant_query matched more than one transaction. The LLM
   *  should fall back to findTransactions to list them. */
  ambiguous?: boolean;
  matchCount?: number;
};

/** UTC date-range filter from inclusive YYYY-MM-DD bounds (end is exclusive
 *  next-day). Returns null when neither bound is given. */
function occurredAtRange(start?: string, end?: string): { gte?: Date; lt?: Date } | null {
  if (!start && !end) return null;
  const r: { gte?: Date; lt?: Date } = {};
  if (start) r.gte = new Date(`${start}T00:00:00.000Z`);
  if (end) {
    const d = new Date(`${end}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    r.lt = d;
  }
  return r;
}

export const getTransactionDetails: ToolDef<Args, Result> = {
  name: "getTransactionDetails",
  description:
    "Show full details for ONE transaction (account, category, note, splits) as a detail card. Pass tx_id when known, or merchant_query (+ optional start_date/end_date) to resolve a transaction the user named — if that matches exactly one it returns the detail card, if more than one it returns { ambiguous: true } so you can call findTransactions to list them.",
  args: Args,
  async run(ctx, args) {
    let txId = args.tx_id;

    // Resolve a single transaction id from a merchant name + optional dates.
    if (!txId) {
      const q = args.merchant_query!;
      const range = occurredAtRange(args.start_date, args.end_date);
      const matches = await prisma.transaction.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          OR: [
            { merchantRaw: { contains: q, mode: "insensitive" } },
            { merchantNormalized: { contains: q, mode: "insensitive" } },
          ],
          ...(range ? { occurredAt: range } : {}),
        },
        select: { id: true },
        take: 2,
        orderBy: { occurredAt: "desc" },
      });
      if (matches.length === 0) throw new Error("transaction_not_found");
      if (matches.length > 1) return { ambiguous: true, matchCount: matches.length };
      txId = matches[0]!.id;
    }

    const [tx, workspace, tz] = await Promise.all([
      prisma.transaction.findFirst({
        where: { id: txId, workspaceId: ctx.workspaceId },
        include: {
          account: { select: { id: true, name: true, type: true, subtype: true, currency: true } },
          allocations: {
            select: {
              id: true, categoryId: true, amount: true, source: true,
              category: {
                select: { id: true, name: true, parentId: true, color: true, icon: true, parent: { select: { name: true } } },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
      resolveUserTz(ctx.userId),
    ]);
    if (!tx) throw new Error("transaction_not_found");

    // Derive top-level category from the first allocation that has one.
    const primaryAlloc = tx.allocations.find((a) => a.categoryId !== null);
    const cat = primaryAlloc?.category ?? null;

    const labelCtx = recentLabelContext(new Date(), tz);
    const dateLabel = dateLabelForRow(tx.occurredAt, tz, labelCtx);
    const block: PresentationBlock = {
      type: "transaction_detail",
      id: tx.id,
      merchant: tx.merchantRaw,
      amount: tx.amount.toFixed(2),
      currency: tx.account.currency,
      date_label: dateLabel,
      account: tx.account.name,
      ...(cat ? { category: { name: cat.name, color: cat.color ?? null, icon: cat.icon ?? null } } : {}),
      note: tx.note,
      pending: tx.pending,
      allocations: tx.allocations
        .filter((a) => a.categoryId !== null)
        .map((a) => ({
          category: { name: a.category!.name, color: a.category!.color ?? null, icon: a.category!.icon ?? null },
          amount: a.amount.toFixed(2),
        })),
    };

    return {
      transaction: {
        id: tx.id,
        amount: tx.amount.toString(),
        currency: workspace.currency,
        merchantRaw: tx.merchantRaw,
        merchantNormalized: tx.merchantNormalized,
        occurredAt: tx.occurredAt.toISOString(),
        postedAt: tx.postedAt?.toISOString() ?? null,
        pending: tx.pending,
        source: tx.source as TransactionDetail["source"],
        note: tx.note,
        removedAt: tx.removedAt?.toISOString() ?? null,
        needsReclassification: tx.needsReclassification,
        allocations: tx.allocations.map((a) => ({
          id: a.id,
          categoryId: a.categoryId,
          amount: a.amount.toString(),
          source: a.source,
        })),
        account: {
          id: tx.account.id,
          name: tx.account.name,
          type: tx.account.type,
          subtype: tx.account.subtype,
          currency: tx.account.currency,
        },
        category: cat
          ? {
              id: cat.id,
              name: cat.name,
              parentId: cat.parentId,
              parentName: cat.parent?.name ?? null,
            }
          : null,
      },
      block,
    };
  },
};
