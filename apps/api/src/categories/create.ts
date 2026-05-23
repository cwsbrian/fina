import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const MAX_NAME_LEN = 40;
export const MAX_ACTIVE_CATEGORIES = 30;

export type CreateCategoryInput = {
  workspaceId: string;
  name: string;
  parentId?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type CreateCategoryOutput = {
  id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  color: string | null;
};

/**
 * Create an active category in a workspace. Shared by:
 * - POST /workspaces/:id/categories (HTTP route)
 * - createCategory chat tool
 *
 * Throws `new Error("too_many_categories")` if the workspace already has 30
 * active categories. Throws `new Error("category_exists")` for a case-insensitive
 * active-name duplicate (both via the pre-check AND via P2002 from the partial
 * unique index `categories_one_active_name_per_workspace_ci`, to catch races).
 * Throws `new Error("parent_not_found")` if `parentId` is given but doesn't
 * refer to an active category in the SAME workspace (defense-in-depth: chat
 * tool already pre-validates parent_name, but any future caller passing a raw
 * parentId still gets the same invariant).
 *
 * The service does NOT trim or validate `name`; callers (HTTP Zod schema +
 * chat-tool Zod schema) trim and length-check before invoking.
 */
export async function createCategoryService(
  input: CreateCategoryInput,
): Promise<CreateCategoryOutput> {
  if (input.parentId != null) {
    const parent = await prisma.category.findFirst({
      where: { id: input.parentId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!parent) throw new Error("parent_not_found");
  }

  const activeCount = await prisma.category.count({
    where: { workspaceId: input.workspaceId, archivedAt: null },
  });
  if (activeCount >= MAX_ACTIVE_CATEGORIES) {
    throw new Error("too_many_categories");
  }

  const dup = await prisma.category.findFirst({
    where: {
      workspaceId: input.workspaceId,
      archivedAt: null,
      name: { equals: input.name, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (dup) throw new Error("category_exists");

  try {
    const created = await prisma.category.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        parentId: input.parentId ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
      },
      select: { id: true, name: true, parentId: true, icon: true, color: true },
    });
    return {
      id: created.id,
      name: created.name,
      parentId: created.parentId,
      icon: created.icon,
      color: created.color,
    };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Race against the partial unique index.
      throw new Error("category_exists");
    }
    throw e;
  }
}
