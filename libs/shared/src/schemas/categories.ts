import { z } from "zod";

// Mirrors apps/api/src/routes/categories.ts.

export const CATEGORY_MAX_NAME_LEN = 40;

export const CreateCategoryBody = z.object({
  name: z.string().trim().min(1).max(CATEGORY_MAX_NAME_LEN),
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
});

export const PatchCategoryBody = z.object({
  name: z.string().trim().min(1).max(CATEGORY_MAX_NAME_LEN).optional(),
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  archived: z.boolean().optional(),
});

export type CreateCategoryInput = z.infer<typeof CreateCategoryBody>;
export type PatchCategoryInput = z.infer<typeof PatchCategoryBody>;
