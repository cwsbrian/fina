import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  tx_id: z
    .string()
    .min(1)
    .describe("Transaction id. Must belong to the current workspace."),
  note: z
    .union([z.string().min(1).max(1000), z.null()])
    .describe(
      "New note text (1-1000 chars), or null to clear. REPLACES any existing note. To append, the LLM should first read the existing note via getTransactionDetails and submit the combined text.",
    ),
});

type Args = z.infer<typeof Args>;

type Result = {
  tx: {
    id: string;
    note: string | null;
    updatedAt: string;
  };
};

export const addTransactionNote: ToolDef<Args, Result> = {
  name: "addTransactionNote",
  description:
    "Set or clear the note on one transaction. Replaces the existing note entirely (pass null to clear).",
  args: Args,
  async run(ctx, args) {
    const existing = await prisma.transaction.findFirst({
      where: { id: args.tx_id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!existing) throw new Error("transaction_not_found");

    const updated = await prisma.transaction.update({
      where: { id: existing.id },
      data: { note: args.note },
      select: { id: true, note: true, updatedAt: true },
    });

    return {
      tx: {
        id: updated.id,
        note: updated.note,
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  },
};
