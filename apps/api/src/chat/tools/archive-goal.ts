import { z } from "zod";
import type { GoalDTO } from "@fina/shared";
import { patchGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  goal_id: z.string().min(1),
});
type Args = z.infer<typeof Args>;

export const archiveGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "archiveGoal",
  description:
    "Archive a goal so it no longer appears in the user's active goals. Pro-tier only. goal_id comes from a prior goals_list/goal_detail card. Use presentConfirmCard before archiving so the user confirms.",
  args: Args,
  async run(ctx, args) {
    const goal = await patchGoalService(ctx.workspaceId, ctx.userId, args.goal_id, {
      archived: true,
    });
    if (!goal) throw new Error("goal_not_found");
    return { goal };
  },
};
