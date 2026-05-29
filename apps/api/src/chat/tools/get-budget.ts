import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import {
  budgetPlanSnapshot,
  periodToYearMonth,
  type BudgetSnapshot,
  type BudgetSnapshotCategory,
} from "../../budget-plans/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});
type Args = z.infer<typeof Args>;

/** Max category rows in the card; the rest live on the /budget screen. */
const MAX_ROWS = 5;

export const getBudget: ToolDef<
  Args,
  { plan: BudgetSnapshot | null; block?: PresentationBlock }
> = {
  name: "getBudget",
  description:
    "Show the user's monthly budget — total cap, spend so far, and per-category caps with progress. Sources the real BudgetPlan (same as the Budget screen). period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    if (args.category_id && args.category_name) throw new Error("invalid_body");
    const period = args.period ?? "this_month";
    const { year, month } = periodToYearMonth(period);

    const [snap, workspace] = await Promise.all([
      budgetPlanSnapshot(ctx.workspaceId, year, month),
      prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { currency: true } }),
    ]);

    if (!snap || parseFloat(snap.totalAmount) <= 0) return { plan: null };

    // Optional single-category filter (by id or name).
    let filterId: string | undefined = args.category_id;
    if (!filterId && args.category_name) {
      const cat = await prisma.category.findFirst({
        where: { workspaceId: ctx.workspaceId, archivedAt: null, name: { equals: args.category_name, mode: "insensitive" } },
        select: { id: true },
      });
      filterId = cat?.id;
    }

    const capped = snap.categories.filter((c) => c.allocated !== null);

    let rowsSource: BudgetSnapshotCategory[];
    let filterNote: string | null = null;
    if (filterId) {
      const matched = snap.categories.find((c) => c.categoryId === filterId);
      if (matched && matched.allocated !== null) {
        rowsSource = [matched];
      } else {
        rowsSource = [];
        if (matched) filterNote = `${matched.categoryName} has no cap set`;
      }
    } else {
      rowsSource = [...capped].sort((a, b) => ratio(b) - ratio(a)).slice(0, MAX_ROWS);
    }

    const rows = rowsSource.map((c) => {
      const allocated = parseFloat(c.allocated!);
      const spent = parseFloat(c.spent);
      return {
        id: c.categoryId,
        category: { name: c.categoryName, color: c.color, icon: c.icon },
        amount: c.allocated!,
        spent: c.spent,
        bar_pct: allocated > 0 ? Number(((spent / allocated) * 100).toFixed(2)) : 0,
        over: spent > allocated,
      };
    });

    const cap = parseFloat(snap.totalAmount);
    const spentTotal = parseFloat(snap.totalSpent);
    const headline = {
      cap: snap.totalAmount,
      spent: snap.totalSpent,
      left: (cap - spentTotal).toFixed(2),
      bar_pct: cap > 0 ? Number(((spentTotal / cap) * 100).toFixed(2)) : 0,
      ...(parseFloat(snap.totalScheduled) > 0 ? { scheduled: snap.totalScheduled } : {}),
    };

    const uncapped = snap.categories.length - capped.length;
    const footerParts: string[] = [];
    if (filterNote) {
      footerParts.push(filterNote);
    } else if (!filterId && capped.length > rowsSource.length) {
      footerParts.push(`+${capped.length - rowsSource.length} more capped`);
    }
    if (!filterId && uncapped > 0) footerParts.push(`${uncapped} uncapped`);
    footerParts.push("See full budget");
    const footer = footerParts.join(" · ");

    const periodLabel = period === "this_month" ? "This month" : period === "last_month" ? "Last month" : "Next month";
    const block: PresentationBlock = {
      type: "budget_list",
      title: "Budget",
      period_label: periodLabel,
      currency: workspace.currency,
      headline,
      rows,
      footer,
    };
    return { plan: snap, block };
  },
};

function ratio(c: BudgetSnapshotCategory): number {
  const a = parseFloat(c.allocated ?? "0");
  return a > 0 ? parseFloat(c.spent) / a : 0;
}
