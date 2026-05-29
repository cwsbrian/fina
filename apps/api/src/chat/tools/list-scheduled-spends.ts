import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { listScheduledSpendsService, type ScheduledSpendStatus } from "../../schedules/service.js";
import { buildScheduledListBlock } from "./scheduled-list-block.js";

const Args = z.object({
  from: z.string().optional().describe("YYYY-MM-DD inclusive"),
  to: z.string().optional().describe("YYYY-MM-DD inclusive"),
  status: z.enum(["upcoming", "unresolved", "resolved-matched", "resolved-dismissed", "all"]).optional(),
});

type Result = {
  schedules: Array<{
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
    matchedTxId: string | null;
    dismissedAt: string | null;
    status: ScheduledSpendStatus;
  }>;
  block?: PresentationBlock;
};

export const listScheduledSpends: ToolDef<z.infer<typeof Args>, Result> = {
  name: "listScheduledSpends",
  description:
    "List scheduled future expenses. Filter by date range or status " +
    "(upcoming/unresolved/resolved-matched/resolved-dismissed/all).",
  args: Args,
  async run(ctx, args) {
    const filter: Parameters<typeof listScheduledSpendsService>[1] = {};
    if (args.from) filter.from = new Date(args.from);
    if (args.to) filter.to = new Date(args.to);
    if (args.status) filter.status = args.status;

    const r = await listScheduledSpendsService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      filter,
    );

    if (r.schedules.length === 0) {
      return { schedules: [] };
    }

    // Resolve category names for the LLM.
    const catIds = Array.from(new Set(r.schedules.map((s) => s.categoryId)));
    const [cats, workspace] = await Promise.all([
      prisma.category.findMany({
        where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
        select: { id: true, name: true, color: true, icon: true },
      }),
      prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { currency: true } }),
    ]);
    const catById = new Map(cats.map((c) => [c.id, c]));
    const schedules = r.schedules.map((s) => ({
      ...s,
      categoryName: catById.get(s.categoryId)?.name ?? "Unknown",
    }));
    const block = buildScheduledListBlock({
      title: "Scheduled spending",
      currency: workspace.currency,
      schedules,
      catById,
    });
    return { schedules, block };
  },
};
