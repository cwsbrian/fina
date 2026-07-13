import { hasAtLeast, type PresentationBlock } from "@fina/shared";
import { z } from "zod";
import { prisma } from "../../db.js";
import { createManualTransactionService } from "../../transactions/create-manual.js";
import { loadTransactionDetail } from "./get-transaction-details.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  merchant: z.string().trim().min(1).max(120).describe("Merchant or purchase name."),
  amount: z.number().positive().describe("Positive expense amount in the workspace currency."),
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

type Args = z.infer<typeof Args>;

type Result = {
  transaction: {
    id: string;
    merchantRaw: string;
    amount: string;
    currency: string;
    occurredAt: string;
  };
  block?: PresentationBlock;
};

export const addManualTransaction: ToolDef<Args, Result> = {
  name: "addManualTransaction",
  description:
    "Add a one-time manual expense that already happened. Use this for ordinary purchases when merchant and amount are known. " +
    "Omit occurred_at to use today and omit category_name when uncertain.",
  args: Args,
  async run(ctx, args) {
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
        ...(args.occurred_at ? { occurredAt: args.occurred_at } : {}),
        ...(category ? { categoryId: category.id } : {}),
        ...(args.note ? { note: args.note } : {}),
      },
    );
    const detail = await loadTransactionDetail(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      created.transaction.id,
    );
    if (!detail) throw new Error("transaction_not_found");
    return detail;
  },
};
