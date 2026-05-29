import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { resolveUserTz } from "./periods.js";
import { dateLabelForRow, recentLabelContext } from "./tx-row-helpers.js";

const Args = z.object({
  tx_id: z
    .string()
    .min(1)
    .describe("Transaction id to inspect. Must belong to the current workspace."),
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
  transaction: TransactionDetail;
  block?: PresentationBlock;
};

export const getTransactionDetails: ToolDef<Args, Result> = {
  name: "getTransactionDetails",
  description:
    "Get full details for one transaction by id (account, category, note, splits), returned as a detail card. To find a transaction the user named, use findTransactions instead — it shows a detail card when exactly one matches.",
  args: Args,
  async run(ctx, args) {
    const [tx, workspace, tz] = await Promise.all([
      prisma.transaction.findFirst({
        where: { id: args.tx_id, workspaceId: ctx.workspaceId },
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
