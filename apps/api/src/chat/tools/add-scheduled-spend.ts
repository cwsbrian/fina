import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { addScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  category: z.string().min(1).max(80).describe("Category name (case-insensitive)"),
  amount: z.number().positive().describe("Planned amount"),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});

type Result = {
  schedule: {
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
  };
};

export const addScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "addScheduledSpend",
  description:
    "Schedule a one-time future expense for a category on a specific date. " +
    "Fina will look for a matching transaction on that day and mark the schedule resolved automatically.",
  args: Args,
  async run(ctx, args) {
    const cat = await prisma.category.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        archivedAt: null,
        name: { equals: args.category, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (!cat) throw new Error("category_not_found");

    const result = await addScheduledSpendService({
      workspaceId: ctx.workspaceId,
      categoryId: cat.id,
      amount: args.amount,
      scheduledDate: args.scheduled_date,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    return {
      schedule: {
        id: result.schedule.id,
        categoryId: result.schedule.categoryId,
        categoryName: cat.name,
        amount: result.schedule.amount,
        scheduledDate: result.schedule.scheduledDate,
        note: result.schedule.note,
      },
    };
  },
};
