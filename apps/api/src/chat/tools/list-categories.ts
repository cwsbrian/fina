import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});
type Args = z.infer<typeof Args>;

export const listCategories: ToolDef<Args, { categories: Array<{ id: string; name: string }> }> = {
  name: "listCategories",
  description: "List the categories defined in the user's workspace.",
  args: Args,
  async run(ctx) {
    const rows = await prisma.category.findMany({ where: { workspaceId: ctx.workspaceId, archivedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } });
    return { categories: rows };
  },
};
