import { z } from "zod";
import type { ToolDef } from "./types.js";
import { dismissScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  schedule_id: z.string().min(1),
});

type Result =
  | { schedule: { id: string; dismissedAt: string } }
  | { dismissed: false; alreadyDismissed: true };

export const dismissScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "dismissScheduledSpend",
  description: "Dismiss a scheduled spend that didn't happen — marks it resolved without finding a matching transaction.",
  args: Args,
  async run(ctx, args) {
    return await dismissScheduledSpendService(
      { workspaceId: ctx.workspaceId },
      args.schedule_id,
    );
  },
};
