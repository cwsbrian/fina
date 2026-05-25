import { prisma } from "../db.js";
import {
  DEFAULT_PERIOD,
  firstOfMonth,
  monthlySpendByCategory,
} from "../budget-plans/service.js";

/** A goal's strategy-item shape that the savings algorithm cares about.
 *  Mirrors `GoalStrategyItem` in generate-strategy.ts but local — we
 *  don't depend on the LLM module here. */
type StrategyItem = { categoryName: string; monthlyAmount: number };

function parseStrategyItems(raw: unknown): StrategyItem[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: StrategyItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const name = typeof r["categoryName"] === "string" ? r["categoryName"] : null;
    const amt = typeof r["monthlyAmount"] === "number" ? r["monthlyAmount"] : null;
    if (!name || amt === null || amt <= 0) continue;
    out.push({ categoryName: name, monthlyAmount: amt });
  }
  return out;
}

function monthsBetweenInclusive(
  start: Date,
  end: Date,
): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth() + 1;
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth() + 1;
  // Cap to 60 months as a runaway guard. Goals older than 5 years
  // would be unusual and the math gets noisy past that anyway.
  let safety = 0;
  while ((y < endY || (y === endY && m <= endM)) && safety < 60) {
    result.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    safety += 1;
  }
  return result;
}

function readCapsFromAllocations(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(raw)) return out;
  for (const a of raw as Array<{ categoryId?: unknown; amount?: unknown }>) {
    if (typeof a.categoryId === "string" && typeof a.amount === "number" && a.amount > 0) {
      out.set(a.categoryId, a.amount);
    }
  }
  return out;
}

/**
 * Compute a goal's "Saved so far" amount from actual under-budget behavior.
 *
 * For every month since the goal was created:
 *   savings_in_category = max(0, budgetCap - actualSpend)
 *
 * Multiple goals may target the same category. Allocation order is by
 * `Goal.createdAt` ascending — older goals "claim" first up to their
 * planned monthly cut. The LAST goal in line for a category absorbs
 * any remaining overflow (so a single goal with plan $50 still credits
 * the full $70 you actually saved that month).
 *
 * The displayed savedAmount is the cumulative sum across all months
 * since goal creation. Current month counts in real-time — it can move
 * up or down as new transactions land.
 */
export async function computeGoalSavings(
  workspaceId: string,
  goalId: string,
): Promise<number> {
  const [thisGoal, allGoals, categories, defaultPlan] = await Promise.all([
    prisma.goal.findUnique({ where: { id: goalId } }),
    prisma.goal.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, createdAt: true, strategy: true },
    }),
    prisma.category.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, name: true },
    }),
    prisma.budgetPlan.findUnique({
      where: {
        workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
      },
      select: { categoryAllocations: true },
    }),
  ]);
  if (!thisGoal || thisGoal.workspaceId !== workspaceId) return 0;
  const thisItems = parseStrategyItems(thisGoal.strategy);
  if (thisItems.length === 0) return 0;

  // Name → catId (case-insensitive). Strategy items use free-text
  // category names; this maps them back to IDs the budget + spend
  // tables use.
  const catByName = new Map<string, string>();
  for (const c of categories) catByName.set(c.name.toLowerCase(), c.id);

  const defaultCap = readCapsFromAllocations(
    defaultPlan?.categoryAllocations as unknown,
  );

  // Build, per category-id, the ordered list of competing goals + each
  // one's monthly plan for that category. Already sorted by createdAt
  // since allGoals was queried that way.
  type Competitor = { goalId: string; plan: number };
  const competitorsByCatId = new Map<string, Competitor[]>();
  for (const g of allGoals) {
    const items = parseStrategyItems(g.strategy);
    for (const it of items) {
      const catId = catByName.get(it.categoryName.toLowerCase());
      if (!catId) continue;
      const arr = competitorsByCatId.get(catId) ?? [];
      arr.push({ goalId: g.id, plan: it.monthlyAmount });
      competitorsByCatId.set(catId, arr);
    }
  }

  const months = monthsBetweenInclusive(thisGoal.createdAt, new Date());

  let total = 0;
  for (const { year, month } of months) {
    // Caps for this month: prefer a snapshot, fall back to default.
    const snap = await prisma.budgetPlan.findUnique({
      where: {
        workspaceId_periodStart: {
          workspaceId,
          periodStart: firstOfMonth(year, month),
        },
      },
      select: { categoryAllocations: true },
    });
    const monthCap = snap
      ? readCapsFromAllocations(snap.categoryAllocations as unknown)
      : defaultCap;

    // Actual spend per category this month — one query for all categories.
    const spendRows = await monthlySpendByCategory(workspaceId, year, month);
    const spendByCat = new Map(spendRows.map((s) => [s.categoryId, s.spent]));

    for (const item of thisItems) {
      const catId = catByName.get(item.categoryName.toLowerCase());
      if (!catId) continue;
      const cap = monthCap.get(catId) ?? 0;
      if (cap <= 0) continue;
      const spent = spendByCat.get(catId) ?? 0;
      const savings = Math.max(0, cap - spent);
      if (savings <= 0) continue;

      const competitors = competitorsByCatId.get(catId) ?? [];
      if (competitors.length === 0) continue;

      // Cascade allocation: each competitor takes up to its plan, except
      // the LAST one which absorbs all remaining overflow (so a single
      // goal still gets the full over-savings, per user spec).
      let remaining = savings;
      const lastIdx = competitors.length - 1;
      for (let i = 0; i < competitors.length; i++) {
        const c = competitors[i]!;
        const isLast = i === lastIdx;
        const take = isLast ? remaining : Math.min(remaining, c.plan);
        if (c.goalId === goalId) {
          total += take;
          break;
        }
        remaining -= take;
        if (remaining <= 0) break;
      }
    }
  }
  return Math.round(total * 100) / 100;
}
