import { z } from "zod";
import { prisma } from "../../db.js";
import { mapMerchantToCategoryService } from "../../categorize/map-merchant.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    merchant: z
      .string()
      .min(1)
      .max(200)
      .describe("Raw merchant text — server normalizes to lowercase + strips store IDs / locations."),
    category_id: z.string().min(1).optional(),
    category_name: z.string().min(1).max(40).optional(),
  })
  .refine((a) => Boolean(a.category_id) !== Boolean(a.category_name), {
    message: "Provide exactly one of category_id or category_name",
  });

type Args = z.infer<typeof Args>;

export const mapMerchantToCategory: ToolDef<
  Args,
  {
    mapping: { merchantNormalized: string; categoryId: string; categoryName: string };
    backfilledCount: number;
  }
> = {
  name: "mapMerchantToCategory",
  description:
    "Bind a merchant to a category. Upserts the mapping and retroactively assigns null-category siblings whose merchantRaw normalizes to the same value. Use category_id when known, else category_name (case-insensitive).",
  args: Args,
  async run(ctx, args) {
    let categoryId = args.category_id;
    let categoryName: string;
    if (categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryName = cat.name;
    } else {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name!, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }
    const out = await mapMerchantToCategoryService(
      { workspaceId: ctx.workspaceId },
      { categoryId, merchant: args.merchant },
    );
    return {
      mapping: { ...out.mapping, categoryName },
      backfilledCount: out.backfilledCount,
    };
  },
};
