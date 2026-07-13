import { z } from "zod";
import { hasAtLeast } from "@fina/shared";
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
      "Category name. Trimmed of surrounding whitespace; uniqueness check is case-insensitive against existing active categories of the same type.",
    ),
  type: z
    .enum(["expense", "income"])
    .optional()
    .describe(
      "expense (default) or income. Drives whether this category appears in the expense or income picker. Pre-existing same-name categories of the other type don't collide.",
    ),
  parent_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Optional parent category name (case-insensitive exact match against active categories of the same type). Omit for a top-level category.",
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
    if (!hasAtLeast(ctx.role, "editor")) {
      throw new Error("insufficient_role");
    }

    const type = args.type ?? "expense";

    let parentId: string | null = null;
    let parentName: string | null = null;
    if (args.parent_name) {
      // Parent must be of the same type — a Salary child of an expense
      // category doesn't make sense for picker filtering.
      const parent = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          type,
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
      type,
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
