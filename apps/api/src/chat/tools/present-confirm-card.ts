import { z } from "zod";
import { createIntentService } from "../../intents/service.js";
import type { ConfirmCardBlock } from "../blocks.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  accept_label: z.string().min(1).max(40).optional(),
  reject_label: z.string().min(1).max(40).optional(),
  accept_action: z.object({
    tool: z.string().min(1),
    args: z.record(z.unknown()),
  }),
});

type Args = z.infer<typeof Args>;

export const presentConfirmCard: ToolDef<Args, { block: ConfirmCardBlock }> = {
  name: "presentConfirmCard",
  description:
    "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring, addScheduledSpend, dismissScheduledSpend, removeScheduledSpend, updateGoal, archiveGoal. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring, archiveGoal) and ambiguous or large changes. The action runs only when the user taps accept.",
  args: Args,
  async run(ctx, args) {
    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: args.accept_action.tool, args: args.accept_action.args },
    );
    return {
      block: {
        type: "confirm_card",
        question: args.question,
        accept_label: args.accept_label ?? "Yes",
        reject_label: args.reject_label ?? "No",
        accept_intent: out.intent.id,
      },
    };
  },
};
