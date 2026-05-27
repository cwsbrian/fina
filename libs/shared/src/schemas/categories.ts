import { z } from "zod";

// Mirrors apps/api/src/routes/categories.ts.

export const CATEGORY_MAX_NAME_LEN = 40;

export const CATEGORY_TYPES = ["expense", "income"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];
export const CategoryTypeSchema = z.enum(CATEGORY_TYPES);

export const CreateCategoryBody = z.object({
  name: z.string().trim().min(1).max(CATEGORY_MAX_NAME_LEN),
  /** Defaults to "expense" on create — preserves pre-type-aware clients. */
  type: CategoryTypeSchema.optional(),
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchCategoryBody = z.object({
  name: z.string().trim().min(1).max(CATEGORY_MAX_NAME_LEN).optional(),
  /** Type changes after creation are intentionally NOT supported — a
   *  category's type is part of its identity and changing it would
   *  silently break budgets/goals/allocations keyed to it. Omitted on
   *  purpose from this body. */
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  archived: z.boolean().optional(),
});

export type CreateCategoryInput = z.infer<typeof CreateCategoryBody>;
export type PatchCategoryInput = z.infer<typeof PatchCategoryBody>;
