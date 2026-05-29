import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { listScheduledSpendsService } from "../../schedules/service.js";
import { createIntentService } from "../../intents/service.js";
import { buildScheduledListBlock } from "./scheduled-list-block.js";

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
  block?: PresentationBlock;
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

    if (r.schedules.length === 0) {
      return { schedules: [] };
    }

    const catIds = Array.from(new Set(r.schedules.map((s) => s.categoryId)));
    const [cats, workspace] = await Promise.all([
      prisma.category.findMany({
        where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
        select: { id: true, name: true, color: true, icon: true },
      }),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);
    const catById = new Map(cats.map((c) => [c.id, c]));

    // Each call pre-creates a dismiss intent per unresolved row. Re-calling
    // this tool creates fresh intents (no dedup); the hourly ActionIntent
    // sweep + 1h TTL bound the accumulation. The card uses the latest id.
    const entries = await Promise.all(
      r.schedules.map(async (s) => {
        const intent = await createIntentService(
          { workspaceId: ctx.workspaceId, userId: ctx.userId },
          { tool: "dismissScheduledSpend", args: { schedule_id: s.id } },
        );
        return [s.id, intent.intent.id] as const;
      }),
    );
    const dismissIntentById = new Map(entries);

    const block = buildScheduledListBlock({
      title: "Unresolved scheduled spending",
      currency: workspace.currency,
      schedules: r.schedules.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        amount: s.amount,
        scheduledDate: s.scheduledDate,
        note: s.note,
        status: "unresolved" as const,
      })),
      catById,
      dismissIntentById,
    });

    return {
      schedules: r.schedules.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        categoryName: catById.get(s.categoryId)?.name ?? "Unknown",
        amount: s.amount,
        scheduledDate: s.scheduledDate,
        note: s.note,
      })),
      block,
    };
  },
};
