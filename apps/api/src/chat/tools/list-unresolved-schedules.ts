import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { listScheduledSpendsService } from "../../schedules/service.js";

const Args = z.object({});

type Result = {
  schedules: Array<{
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
  }>;
};

export const listUnresolvedSchedules: ToolDef<z.infer<typeof Args>, Result> = {
  name: "listUnresolvedSchedules",
  description:
    "List unresolved past-due scheduled spends — schedules whose date has passed " +
    "without a matching transaction. Used by the daily brief to ask about missing expenses.",
  args: Args,
  async run(ctx, _args) {
    const r = await listScheduledSpendsService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { status: "unresolved" },
    );
    const catIds = Array.from(new Set(r.schedules.map((s) => s.categoryId)));
    const cats = await prisma.category.findMany({
      where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
      select: { id: true, name: true },
    });
    const catNameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      schedules: r.schedules.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        categoryName: catNameById.get(s.categoryId) ?? "Unknown",
        amount: s.amount,
        scheduledDate: s.scheduledDate,
        note: s.note,
      })),
    };
  },
};
