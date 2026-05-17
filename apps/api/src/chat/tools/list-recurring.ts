import { z } from "zod";
import { prisma } from "../../db.js";
import { listRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});

type Args = z.infer<typeof Args>;

export const listRecurring: ToolDef<
  Args,
  {
    recurring: Array<{
      id: string;
      name: string;
      amount: string;
      currency: string;
      cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
      nextOccurrenceDate: string;
      categoryId: string | null;
      categoryName: string | null;
      merchantNormalized: string | null;
    }>;
  }
> = {
  name: "listRecurring",
  description:
    "List all recurring expenses in the workspace, ordered by next occurrence date. Includes the resolved category name (null if uncategorized).",
  args: Args,
  async run(ctx, _args) {
    const out = await listRecurringService({ workspaceId: ctx.workspaceId });
    const ids = out.recurring
      .map((r) => r.categoryId)
      .filter((id): id is string => id !== null);
    // Hydrate canonical category names. Filter out archived categories AND
    // scope to the workspace so an archived/cross-workspace category id
    // (defense-in-depth) yields categoryName: null.
    const cats = ids.length
      ? await prisma.category.findMany({
          where: {
            id: { in: ids },
            workspaceId: ctx.workspaceId,
            archivedAt: null,
          },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      recurring: out.recurring.map((r) => ({
        ...r,
        categoryName: r.categoryId ? nameById.get(r.categoryId) ?? null : null,
      })),
    };
  },
};
