import { hasAtLeast, type PresentationBlock } from "@fina/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { createManualTransactionService } from "../../transactions/create-manual.js";
import { loadTransactionDetail } from "./get-transaction-details.js";
import type { ToolContext, ToolDef } from "./types.js";

export const ManualTransactionArgs = z.object({
  merchant: z.string().trim().min(1).max(120).describe("Merchant or purchase name."),
  amount: z.number().positive().describe("Positive expense amount."),
  currency: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/))
    .describe(
      "Optional ISO 4217 currency explicitly stated by the user (for example EUR for €, GBP for £). Omit only when the user did not state a currency.",
    )
    .optional(),
  occurred_at: z
    .string()
    .describe("Optional ISO date or timestamp. Omit to use today in the user's timezone.")
    .optional(),
  category_name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("Optional existing expense category name. Omit when uncertain.")
    .optional(),
  note: z.string().trim().min(1).max(1000).optional(),
});

export type ManualTransactionArgs = z.infer<typeof ManualTransactionArgs>;

export type ManualTransactionResult = {
  transaction: {
    id: string;
    merchantRaw: string;
    amount: string;
    currency: string;
    occurredAt: string;
  };
  block?: PresentationBlock;
  needsCategory: boolean;
};

export async function runManualTransaction(
  ctx: ToolContext,
  args: ManualTransactionArgs,
  options: { changeWorkspaceCurrency?: boolean } = {},
): Promise<ManualTransactionResult> {
  if (!hasAtLeast(ctx.role, "editor")) throw new Error("insufficient_role");

  const category = args.category_name
    ? await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          type: "expense",
          name: { equals: args.category_name, mode: "insensitive" },
        },
        select: { id: true },
      })
    : null;

  const created = await createManualTransactionService(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    {
      merchantRaw: args.merchant,
      amount: args.amount,
      ...(args.currency ? { currency: args.currency } : {}),
      ...(options.changeWorkspaceCurrency ? { changeWorkspaceCurrency: true } : {}),
      ...(args.occurred_at ? { occurredAt: args.occurred_at } : {}),
      ...(category ? { categoryId: category.id } : {}),
      ...(args.note ? { note: args.note } : {}),
    },
  );
  if (!args.category_name) {
    await categorizeNewTransactions(ctx.env, ctx.workspaceId, [created.transaction.id]);
  }
  const detail = await loadTransactionDetail(
    { workspaceId: ctx.workspaceId, userId: ctx.userId },
    created.transaction.id,
  );
  if (!detail) throw new Error("transaction_not_found");
  return {
    ...detail,
    needsCategory:
      detail.transaction.category === null ||
      detail.transaction.category.name.trim().toLowerCase() === "other",
  };
}

export const addManualTransaction: ToolDef<ManualTransactionArgs, ManualTransactionResult> = {
  name: "addManualTransaction",
  description:
    "Add a one-time manual expense that already happened. Use this for ordinary purchases when merchant and amount are known. " +
    "Omit occurred_at to use today and omit category_name when uncertain.",
  args: ManualTransactionArgs,
  async run(ctx, args) {
    return runManualTransaction(ctx, args);
  },
};
