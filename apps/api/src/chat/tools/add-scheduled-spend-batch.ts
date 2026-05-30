import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { addScheduledSpendBatchService } from "../../schedules/service.js";
import { ScheduledPlanItem } from "./_scheduled-plan-item.js";

const Args = z.object({ items: z.array(ScheduledPlanItem).min(1).max(20) });

export const addScheduledSpendBatch: ToolDef<z.infer<typeof Args>, { schedules: unknown[]; count: number }> = {
  name: "addScheduledSpendBatch",
  description:
    "Create SEVERAL one-time scheduled expenses at once (max 20). DO NOT call directly — only via " +
    "presentScheduledSpendPlan so the user confirms once. Each item is a category name + amount + future YYYY-MM-DD.",
  args: Args,
  async run(ctx, args) {
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }], // deterministic resolution
    });
    const byLower = new Map<string, string>();
    for (const c of cats) { const k = c.name.toLowerCase(); if (!byLower.has(k)) byLower.set(k, c.id); } // first by orderBy
    const items = args.items.map((it) => {
      const id = byLower.get(it.category.toLowerCase());
      if (!id) throw new Error("category_not_found");
      return { categoryId: id, amount: it.amount, scheduledDate: it.scheduled_date, ...(it.note !== undefined ? { note: it.note } : {}) };
    });
    const out = await addScheduledSpendBatchService({ workspaceId: ctx.workspaceId, items });
    return { schedules: out.schedules, count: out.count };
  },
};
