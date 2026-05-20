import { z } from "zod";
import type { ToolDef } from "./types.js";
import { removeScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  schedule_id: z.string().min(1),
});

type Result =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export const removeScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "removeScheduledSpend",
  description: "Permanently delete a scheduled spend. Use when the user wants the schedule entirely gone (vs. just dismissed).",
  args: Args,
  async run(ctx, args) {
    return await removeScheduledSpendService(
      { workspaceId: ctx.workspaceId },
      args.schedule_id,
    );
  },
};
