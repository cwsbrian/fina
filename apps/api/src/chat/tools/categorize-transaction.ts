import { z } from "zod";
import { applyManualCategorize, type ManualCategorizeResult } from "../../categorize/manual-categorize.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  tx_id: z.string().min(1).describe("Transaction id — must belong to the current workspace."),
  category: z.string().min(1).describe("Category name (case-insensitive match within the workspace's categories)."),
});
type Args = z.infer<typeof Args>;

export const categorizeTransaction: ToolDef<Args, { tx: ManualCategorizeResult["tx"]; backfilledCount: number }> = {
  name: "categorizeTransaction",
  description: "Assign a category to a transaction. Also auto-applies to sibling transactions from the same merchant.",
  args: Args,
  async run(ctx, args) {
    const result = await applyManualCategorize({ workspaceId: ctx.workspaceId, txId: args.tx_id, categoryName: args.category });
    return { tx: result.tx, backfilledCount: result.backfilledCount };
  },
};
