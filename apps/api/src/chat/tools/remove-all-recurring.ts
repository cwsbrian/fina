import { z } from "zod";
import { removeAllRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});

type Args = z.infer<typeof Args>;

export const removeAllRecurring: ToolDef<Args, { count: number }> = {
  name: "removeAllRecurring",
  description:
    "Hard-delete EVERY recurring expense in the workspace. Destructive and irreversible — ALWAYS gate behind presentConfirmCard before invoking. No args.",
  args: Args,
  async run(ctx) {
    return await removeAllRecurringService({ workspaceId: ctx.workspaceId });
  },
};
