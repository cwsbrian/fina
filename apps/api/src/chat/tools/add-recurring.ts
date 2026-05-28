import { z } from "zod";
import { MAX_AMOUNT, CADENCES } from "@fina/shared";
import { prisma } from "../../db.js";
import { addRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number().positive().max(MAX_AMOUNT),
  cadence: z.enum(CADENCES),
  next_occurrence_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  merchant: z.string().min(1).max(200).optional(),
}).refine(
  (a) => !(a.category_id && a.category_name),
  { message: "Provide at most one of category_id or category_name" },
);

type Args = z.infer<typeof Args>;

export const addRecurring: ToolDef<
  Args,
  {
    recurring: {
      id: string;
      name: string;
      amount: string;
      currency: string;
      cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
      nextOccurrenceDate: string;
      categoryId: string | null;
      categoryName: string | null;
      merchantNormalized: string | null;
    };
    wasCreated: boolean;
  }
> = {
  name: "addRecurring",
  description:
    "Add a recurring expense (subscription, bill). Upserts on case-insensitive name within the workspace. Use category_id when known, else category_name (case-insensitive). cadence: monthly | semimonthly | biweekly | weekly | yearly. next_occurrence_date: YYYY-MM-DD.",
  args: Args,
  async run(ctx, args) {
    let categoryId: string | null = null;
    let categoryName: string | null = null;
    if (args.category_id) {
      const cat = await prisma.category.findFirst({
        where: { id: args.category_id, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    } else if (args.category_name) {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }

    const serviceInput: Parameters<typeof addRecurringService>[1] = {
      name: args.name,
      amount: args.amount,
      cadence: args.cadence,
      nextOccurrenceDate: args.next_occurrence_date,
    };
    if (categoryId) serviceInput.categoryId = categoryId;
    if (args.merchant) serviceInput.merchant = args.merchant;

    const out = await addRecurringService({ workspaceId: ctx.workspaceId }, serviceInput);
    return {
      recurring: { ...out.recurring, categoryName },
      wasCreated: out.wasCreated,
    };
  },
};
