import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  tx_id: z
    .string()
    .min(1)
    .describe("Transaction id to inspect. Must belong to the current workspace."),
});

type Args = z.infer<typeof Args>;

type Result = {
  transaction: {
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
};

export const getTransactionDetails: ToolDef<Args, Result> = {
  name: "getTransactionDetails",
  description: "Get full details for one transaction, including account and category context.",
  args: Args,
  async run(ctx, args) {
    const [tx, workspace] = await Promise.all([
      prisma.transaction.findFirst({
        where: { id: args.tx_id, workspaceId: ctx.workspaceId },
        include: {
          account: { select: { id: true, name: true, type: true, subtype: true, currency: true } },
          allocations: {
            select: {
              id: true, categoryId: true, amount: true, source: true,
              category: {
                select: { id: true, name: true, parentId: true, parent: { select: { name: true } } },
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
    ]);
    if (!tx) throw new Error("transaction_not_found");

    // Derive top-level category from the first allocation that has one.
    const primaryAlloc = tx.allocations.find((a) => a.categoryId !== null);
    const cat = primaryAlloc?.category ?? null;

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
        source: tx.source as Result["transaction"]["source"],
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
    };
  },
};
