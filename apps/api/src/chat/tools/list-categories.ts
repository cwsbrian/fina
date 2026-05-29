import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});
type Args = z.infer<typeof Args>;

export const listCategories: ToolDef<
  Args,
  { categories: Array<{ id: string; name: string; color: string | null; icon: string | null }>; block?: PresentationBlock }
> = {
  name: "listCategories",
  description: "List the categories defined in the user's workspace.",
  args: Args,
  async run(ctx) {
    const rows = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, icon: true },
    });
    const block: PresentationBlock = {
      type: "category_list",
      title: "Categories",
      rows: rows.map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon })),
    };
    return { categories: rows, block };
  },
};
