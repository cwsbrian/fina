import { prisma } from "../db.js";
import {
  DEFAULT_PERIOD,
  firstOfMonth,
  monthlySpendByCategory,
} from "../budget-plans/service.js";

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
  const [thisGoal, allAllocations, defaultPlan] = await Promise.all([
    prisma.goal.findUnique({
      where: { id: goalId },
      select: { id: true, workspaceId: true, createdAt: true },
    }),
    // Every allocation in the workspace, joined with its goal so we can
    // order competitors by goal createdAt and exclude archived goals.
    prisma.goalAllocation.findMany({
      where: { goal: { workspaceId, archivedAt: null } },
      select: {
        goalId: true,
        categoryId: true,
        monthlyAmount: true,
        goal: { select: { createdAt: true } },
      },
    }),
    prisma.budgetPlan.findUnique({
      where: {
        workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
      },
      select: { categoryAllocations: true },
    }),
  ]);
  if (!thisGoal || thisGoal.workspaceId !== workspaceId) return 0;

  // Build the per-category competitor list, ordered by goal createdAt
  // ascending. Older goals "claim" first; the last in line absorbs
  // overflow.
  type Competitor = { goalId: string; plan: number; createdAt: Date };
  const competitorsByCatId = new Map<string, Competitor[]>();
  for (const a of allAllocations) {
    const plan = Number(a.monthlyAmount);
    if (plan <= 0) continue;
    const arr = competitorsByCatId.get(a.categoryId) ?? [];
    arr.push({ goalId: a.goalId, plan, createdAt: a.goal.createdAt });
    competitorsByCatId.set(a.categoryId, arr);
  }
  for (const arr of competitorsByCatId.values()) {
    arr.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  // The categories THIS goal targets.
  const myCategoryIds = new Set(
    allAllocations.filter((a) => a.goalId === goalId).map((a) => a.categoryId),
  );
  if (myCategoryIds.size === 0) return 0;

  const defaultCap = readCapsFromAllocations(
    defaultPlan?.categoryAllocations as unknown,
  );

  const months = monthsBetweenInclusive(thisGoal.createdAt, new Date());

  let total = 0;
  for (const { year, month } of months) {
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

    const spendRows = await monthlySpendByCategory(workspaceId, year, month);
    const spendByCat = new Map(spendRows.map((s) => [s.categoryId, s.spent]));

    for (const catId of myCategoryIds) {
      const cap = monthCap.get(catId) ?? 0;
      if (cap <= 0) continue;
      const spent = spendByCat.get(catId) ?? 0;
      const savings = Math.max(0, cap - spent);
      if (savings <= 0) continue;

      const competitors = competitorsByCatId.get(catId) ?? [];
      if (competitors.length === 0) continue;

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
