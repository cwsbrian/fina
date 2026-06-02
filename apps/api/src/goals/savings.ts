import { prisma } from "../db.js";
import {
  DEFAULT_PERIOD,
  firstOfMonth,
} from "../budget-plans/service.js";
import { serverNow } from "../dev-clock.js";
import { logger } from "../logger.js";

const DEBUG_GOAL_SAVINGS = process.env.DEBUG_GOAL_SAVINGS === "1";

function debugGoalLog(context: Record<string, unknown>): void {
  if (!DEBUG_GOAL_SAVINGS) return;
  logger.info(context, "Goal savings debug");
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

function isSameMonth(year: number, month: number, d: Date): boolean {
  return year === d.getUTCFullYear() && month === d.getUTCMonth() + 1;
}

/** Sum positive expense allocations grouped by categoryId in the given
 *  half-open date range. Used by goal-savings so we can constrain a
 *  goal's first month to the post-creation portion only. */
async function categorySpendInDateRange(
  workspaceId: string,
  from: Date,
  to: Date,
  opts?: { asOf?: Date },
): Promise<Map<string, number>> {
  debugGoalLog({
    action: "categorySpendInDateRange",
    workspaceId,
    periodStart: from.toISOString(),
    periodEnd: to.toISOString(),
    asOf: opts?.asOf?.toString() ?? null,
  });
  // Keep read-window deterministic across retries of the same request.
  // We intentionally avoid `createdAt/updatedAt` filters here because those
  // timestamps can be in a different update domain than spend visibility.
  if (opts?.asOf && Number.isNaN(new Date(opts.asOf).getTime())) {
    throw new Error("Invalid asOf date passed to categorySpendInDateRange");
  }
  const rows = await prisma.transactionAllocation.findMany({
    where: {
      amount: { gt: 0 },
      categoryId: { not: null },
      transaction: {
        workspaceId,
        removedAt: null,
        pending: false,
        occurredAt: { gte: from, lt: to },
        amount: { gt: 0 },
      },
    },
    select: { amount: true, categoryId: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    out.set(r.categoryId, (out.get(r.categoryId) ?? 0) + Number(r.amount));
  }
  return out;
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
 * planned monthly cut. Any remaining savings after all plans are fully
 * claimed are unassigned.
 *
 * The displayed savedAmount is the cumulative sum across all months
 * since goal creation. Current month counts month-to-date with prorated
 * caps — it can move up or down as new transactions land.
 */
export async function computeGoalSavings(
  workspaceId: string,
  goalId: string,
  opts?: { asOf?: Date },
): Promise<number> {
  const asOf = opts?.asOf
    ? new Date(opts.asOf)
    : serverNow();
  if (Number.isNaN(asOf.getTime())) {
    throw new Error("Invalid asOf date passed to computeGoalSavings");
  }
  debugGoalLog({
    action: "computeGoalSavings.start",
    workspaceId,
    goalId,
    asOf: asOf.toISOString(),
    serverNow: serverNow().toISOString(),
  });
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

  const defaultCap = readCapsFromAllocations(
    defaultPlan?.categoryAllocations as unknown,
  );

  debugGoalLog({
    action: "computeGoalSavings.base",
    goalCreatedAt: thisGoal.createdAt.toISOString(),
    allocationCount: allAllocations.length,
    myCategoryCount: allAllocations.filter((a) => a.goalId === goalId).length,
    defaultCapCount: defaultCap.size,
  });

  // Build the per-category competitor list, ordered by goal createdAt
  // ascending. Older goals "claim" first.
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
    // Deterministic tie-breaker avoids nondeterministic allocation when
    // multiple goals share the same createdAt (DB order is not guaranteed).
    arr.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || a.goalId.localeCompare(b.goalId),
    );
  }

  // The categories THIS goal targets.
  const myCategoryIds = new Set(
    allAllocations.filter((a) => a.goalId === goalId).map((a) => a.categoryId),
  );
  if (myCategoryIds.size === 0) return 0;

  // Use day precision for goal progress so repeated refreshes during the
  // same day stay stable (no sub-day flicker), while still advancing
  // automatically as the day rolls over.
  const today = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()),
  );
  const months = monthsBetweenInclusive(thisGoal.createdAt, today);

  // Normalize the goal's createdAt to a UTC date (drop time-of-day) so
  // proration counts whole days from the create-date forward.
  const createdDay = new Date(
    Date.UTC(
      thisGoal.createdAt.getUTCFullYear(),
      thisGoal.createdAt.getUTCMonth(),
      thisGoal.createdAt.getUTCDate(),
    ),
  );

  let total = 0;
  for (const { year, month } of months) {
    // Month plans use the UTC month start, while proration math always uses
    // explicit midnight UTC boundaries for deterministic day counts.
    const planMonthStart = firstOfMonth(year, month);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(
      Date.UTC(
        month === 12 ? year + 1 : year,
        month === 12 ? 0 : month,
        1,
      ),
    );
    const isCurrentMonth = isSameMonth(year, month, today);
    const periodEnd = isCurrentMonth ? today : monthEnd;

    // First month is prorated: budget caps and tx spend both clipped
    // to [createdAt, periodEnd) so pre-goal spending doesn't count and
    // the cap is only the share of the month the goal existed.
    const isFirstMonth = isSameMonth(year, month, createdDay);
    const periodStart =
      isFirstMonth && createdDay > monthStart ? createdDay : monthStart;
    if (periodEnd <= periodStart) continue;
    const totalDaysInMonth =
      (monthEnd.getTime() - monthStart.getTime()) / 86_400_000;
    const activeDays =
      (periodEnd.getTime() - periodStart.getTime()) / 86_400_000;
    const ratio =
      isFirstMonth || isCurrentMonth ? activeDays / totalDaysInMonth : 1;

    const snap = await prisma.budgetPlan.findUnique({
      where: {
        workspaceId_periodStart: { workspaceId, periodStart: planMonthStart },
      },
      select: { categoryAllocations: true },
    });
    const monthCap = snap
      ? readCapsFromAllocations(snap.categoryAllocations as unknown)
      : defaultCap;

    debugGoalLog({
      action: "computeGoalSavings.monthlyContext",
      goalId,
      year,
      month,
      isCurrentMonth,
      isFirstMonth,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      ratio,
      hasPeriodCap: monthCap.size > 0,
      hasSnap: !!snap,
    });

    const spendByCat = await categorySpendInDateRange(
      workspaceId,
      periodStart,
      periodEnd,
      { asOf },
    );

    for (const catId of myCategoryIds) {
      const cap = (monthCap.get(catId) ?? 0) * ratio;
      if (cap <= 0) continue;
      const spent = spendByCat.get(catId) ?? 0;
      const savings = Math.max(0, cap - spent);
      if (savings <= 0) continue;

      debugGoalLog({
        action: "computeGoalSavings.category",
        goalId,
        year,
        month,
        categoryId: catId,
        cap,
        spent,
        savings,
      });

      const competitors = competitorsByCatId.get(catId) ?? [];
      if (competitors.length === 0) continue;

      let remaining = savings;
      for (const c of competitors) {
        const take = Math.min(remaining, c.plan);
        if (c.goalId === goalId) {
          total += take;
        }
        remaining -= take;
        debugGoalLog({
          action: "computeGoalSavings.allocation",
          goalId,
          year,
          month,
          categoryId: catId,
          receiverGoal: c.goalId,
          plan: c.plan,
          take,
          remaining,
        });
        if (remaining <= 0) break;
      }
    }
  }
  const rounded = Math.round(total * 100) / 100;
  debugGoalLog({
    action: "computeGoalSavings.end",
    goalId,
    total,
    rounded,
  });
  return rounded;
}
