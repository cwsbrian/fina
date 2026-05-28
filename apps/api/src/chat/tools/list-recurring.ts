import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { listRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});

type Args = z.infer<typeof Args>;

type RecurringRow = {
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

type Result = {
  recurring: RecurringRow[];
  /** Omitted when there are zero results — empty card adds noise. */
  block?: PresentationBlock;
};

/** Cap the recap rows; full list still in `recurring` for the LLM. */
const MAX_ROWS_IN_BLOCK = 10;

/** Monthly-equivalent factor per cadence. Used for the headline total
 *  that lets users see "$134.50 / mo" across mixed-cadence recurrings. */
const MONTHLY_FACTOR: Record<RecurringRow["cadence"], number> = {
  monthly: 1,
  semimonthly: 2,
  biweekly: 26 / 12, // 26 biweekly cycles per year → ~2.1667 per month
  weekly: 52 / 12,
  yearly: 1 / 12,
};

export const listRecurring: ToolDef<Args, Result> = {
  name: "listRecurring",
  description:
    "List all recurring expenses in the workspace, ordered by next occurrence date. " +
    "Use for 'show my recurring', '내 정기지출', 'subscriptions', '구독 목록'. " +
    "Includes the resolved category name (null if uncategorized).",
  args: Args,
  async run(ctx, _args) {
    const out = await listRecurringService({ workspaceId: ctx.workspaceId });
    const ids = out.recurring
      .map((r) => r.categoryId)
      .filter((id): id is string => id !== null);
    // Hydrate canonical category names + color/icon so the block can
    // render a tinted chip. Filter out archived categories AND scope to
    // the workspace so an archived/cross-workspace category id (defense-
    // in-depth) yields categoryName: null.
    const cats = ids.length
      ? await prisma.category.findMany({
          where: {
            id: { in: ids },
            workspaceId: ctx.workspaceId,
            archivedAt: null,
          },
          select: { id: true, name: true, color: true, icon: true },
        })
      : [];
    const catById = new Map(cats.map((c) => [c.id, c]));

    const recurring: RecurringRow[] = out.recurring.map((r) => ({
      ...r,
      categoryName: r.categoryId
        ? catById.get(r.categoryId)?.name ?? null
        : null,
    }));

    if (recurring.length === 0) {
      return { recurring };
    }

    // Server-side monthly total — lets the renderer just print the
    // number without mixing units.
    const monthlyTotalCents = recurring.reduce((sum, r) => {
      const amt = parseFloat(r.amount);
      const factor = MONTHLY_FACTOR[r.cadence];
      return sum + Math.round(amt * factor * 100);
    }, 0);
    const monthlyTotal = (monthlyTotalCents / 100).toFixed(2);

    const blockRows = recurring.slice(0, MAX_ROWS_IN_BLOCK).map((r) => {
      const cat = r.categoryId ? catById.get(r.categoryId) : undefined;
      const row: {
        id: string;
        name: string;
        amount: string;
        cadence: RecurringRow["cadence"];
        next_occurrence_date: string;
        category?: { name: string; color?: string | null; icon?: string | null };
      } = {
        id: r.id,
        name: r.name,
        amount: r.amount,
        cadence: r.cadence,
        next_occurrence_date: r.nextOccurrenceDate,
      };
      if (cat) {
        row.category = {
          name: cat.name,
          color: cat.color ?? null,
          icon: cat.icon ?? null,
        };
      }
      return row;
    });

    const currency = recurring[0]?.currency ?? "CAD";
    const block: PresentationBlock = {
      type: "recurring_list",
      title: "Recurring expenses",
      total_count: recurring.length,
      total_monthly_amount: monthlyTotal,
      currency,
      rows: blockRows,
      ...(recurring.length > blockRows.length
        ? { footer: `Showing ${blockRows.length} of ${recurring.length}` }
        : {}),
    };

    return { recurring, block };
  },
};
