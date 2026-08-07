import { z } from "zod";
import {
  ManualTransactionArgs,
  runManualTransaction,
  type ManualTransactionResult,
} from "./add-manual-transaction.js";
import type { ToolDef } from "./types.js";

const Args = ManualTransactionArgs.required({ currency: true }).extend({
  confirmation_text: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "Short success confirmation in the same language as the user's latest message. It must say that the workspace currency changed and the transaction was recorded.",
    ),
});

type Args = z.infer<typeof Args>;
type Result = ManualTransactionResult & {
  workspace: { currency: string };
  confirmation: string;
};

export const changeWorkspaceCurrencyAndAddManualTransaction: ToolDef<Args, Result> = {
  name: "changeWorkspaceCurrencyAndAddManualTransaction",
  description:
    "Atomically change the current workspace currency and add the requested manual transaction. " +
    "This relabels every existing workspace amount without exchange-rate conversion, so NEVER call it directly. " +
    "Use it only as the accept_action of presentConfirmCard after the user states a transaction currency that differs from the Current state workspace currency.",
  args: Args,
  async run(ctx, args) {
    if (ctx.role !== "owner") throw new Error("insufficient_role");
    const { confirmation_text, ...transactionArgs } = args;
    const result = await runManualTransaction(ctx, transactionArgs, {
      changeWorkspaceCurrency: true,
    });
    return {
      ...result,
      workspace: { currency: transactionArgs.currency },
      confirmation: confirmation_text,
    };
  },
};
