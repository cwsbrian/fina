import { z } from "zod";
import {
  removeRecurringByIdService,
  removeRecurringByNameService,
} from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  recurring_id: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
}).refine(
  (a) => Boolean(a.recurring_id) !== Boolean(a.name),
  { message: "Provide exactly one of recurring_id or name" },
);

type Args = z.infer<typeof Args>;

export const removeRecurring: ToolDef<Args, { removed: boolean }> = {
  name: "removeRecurring",
  description:
    "Remove a recurring expense. Hard delete. Provide exactly one of recurring_id (preferred) or name (case-insensitive resolve).",
  args: Args,
  async run(ctx, args) {
    if (args.recurring_id) {
      const removed = await removeRecurringByIdService(
        { workspaceId: ctx.workspaceId },
        { id: args.recurring_id },
      );
      return { removed };
    }
    const removed = await removeRecurringByNameService(
      { workspaceId: ctx.workspaceId },
      { name: args.name! },
    );
    return { removed };
  },
};
