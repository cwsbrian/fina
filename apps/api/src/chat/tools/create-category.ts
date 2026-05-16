import { z } from "zod";
import { prisma } from "../../db.js";
import { createCategoryService } from "../../categories/create.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Category name. Trimmed of surrounding whitespace; uniqueness check is case-insensitive against existing active categories.",
    ),
  parent_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Optional parent category name (case-insensitive exact match against active categories). Omit for a top-level category.",
    )
    .optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  category: {
    id: string;
    name: string;
    parentId: string | null;
    parentName: string | null;
  };
};

export const createCategory: ToolDef<Args, Result> = {
  name: "createCategory",
  description:
    "Create a new active category in the current workspace. Optional parent category by name. " +
    "Throws category_exists if an active category with this name already exists.",
  args: Args,
  async run(ctx, args) {
    if (ctx.role !== "owner") {
      throw new Error("insufficient_role");
    }

    let parentId: string | null = null;
    let parentName: string | null = null;
    if (args.parent_name) {
      const parent = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.parent_name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!parent) throw new Error("parent_not_found");
      parentId = parent.id;
      parentName = parent.name;
    }

    const created = await createCategoryService({
      workspaceId: ctx.workspaceId,
      name: args.name,
      parentId,
    });

    return {
      category: {
        id: created.id,
        name: created.name,
        parentId: created.parentId,
        parentName,
      },
    };
  },
};
