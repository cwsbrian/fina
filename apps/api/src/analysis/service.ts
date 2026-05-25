import { prisma } from "../db.js";
import { firstOfMonth } from "../budget-plans/service.js";

export type CategorySpend = {
  categoryId: string;
  categoryName: string;
  icon: string | null;
  color: string | null;
  amount: number;
};

export type MonthAnalysis = {
  year: number;
  month: number;
  /** "May 2026". */
  label: string;
  /** Sum of incoming money this month (negative tx.amount * -1). */
  income: number;
  /** Sum of outgoing money this month (positive tx.amount). */
  spend: number;
  /** income - spend. */
  net: number;
  spendByCategory: CategorySpend[];
};

export type CashflowPoint = {
  year: number;
  month: number;
  /** Short month label e.g. "May". */
  label: string;
  income: number;
  spend: number;
};

export type AnalysisResult = {
  current: MonthAnalysis;
  previous: MonthAnalysis | null;
  /** Five most recent months ending at `current`, oldest → newest. */
  monthlyHistory: CashflowPoint[];
};

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthRange(year: number, month1to12: number): { from: Date; to: Date } {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(
    month1to12 === 12 ? year + 1 : year,
    month1to12 === 12 ? 1 : month1to12 + 1,
  );
  return { from, to };
}

function prevMonth(year: number, month1to12: number): { year: number; month: number } {
  if (month1to12 === 1) return { year: year - 1, month: 12 };
  return { year, month: month1to12 - 1 };
}

async function monthFlows(
  workspaceId: string,
  year: number,
  month: number,
): Promise<{ income: number; spend: number }> {
  const { from, to } = monthRange(year, month);
  // Positive amount = expense; negative amount = income (Plaid convention,
  // mirrored in our manual-tx form).
  const [spendAgg, incomeAgg] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        workspaceId,
        removedAt: null,
        occurredAt: { gte: from, lt: to },
        amount: { gt: 0 },
      },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: {
        workspaceId,
        removedAt: null,
        occurredAt: { gte: from, lt: to },
        amount: { lt: 0 },
      },
      _sum: { amount: true },
    }),
  ]);
  return {
    spend: Number(spendAgg._sum.amount ?? 0),
    // income flows in as negative — flip sign for the user-facing number.
    income: -Number(incomeAgg._sum.amount ?? 0),
  };
}

async function spendByCategory(
  workspaceId: string,
  year: number,
  month: number,
): Promise<CategorySpend[]> {
  const { from, to } = monthRange(year, month);
  const rows = await prisma.transactionAllocation.findMany({
    where: {
      amount: { gt: 0 },
      categoryId: { not: null },
      transaction: {
        workspaceId,
        removedAt: null,
        occurredAt: { gte: from, lt: to },
        amount: { gt: 0 },
      },
    },
    select: {
      amount: true,
      categoryId: true,
      category: { select: { name: true, icon: true, color: true } },
    },
  });
  const sums = new Map<
    string,
    { name: string; icon: string | null; color: string | null; amount: number }
  >();
  for (const r of rows) {
    if (!r.categoryId || !r.category) continue;
    const cur = sums.get(r.categoryId) ?? {
      name: r.category.name,
      icon: r.category.icon,
      color: r.category.color,
      amount: 0,
    };
    cur.amount += Number(r.amount);
    sums.set(r.categoryId, cur);
  }
  return Array.from(sums, ([categoryId, v]) => ({
    categoryId,
    categoryName: v.name,
    icon: v.icon,
    color: v.color,
    amount: Math.round(v.amount * 100) / 100,
  })).sort((a, b) => b.amount - a.amount);
}

async function buildMonth(
  workspaceId: string,
  year: number,
  month: number,
): Promise<MonthAnalysis> {
  const [flows, byCat] = await Promise.all([
    monthFlows(workspaceId, year, month),
    spendByCategory(workspaceId, year, month),
  ]);
  return {
    year,
    month,
    label: `${MONTH_LONG[month - 1] ?? ""} ${year}`,
    income: Math.round(flows.income * 100) / 100,
    spend: Math.round(flows.spend * 100) / 100,
    net: Math.round((flows.income - flows.spend) * 100) / 100,
    spendByCategory: byCat,
  };
}

export async function getAnalysis(
  workspaceId: string,
  year: number,
  month: number,
): Promise<AnalysisResult> {
  // Current + previous in parallel; previous null when out of range.
  const prev = prevMonth(year, month);
  const [current, previous] = await Promise.all([
    buildMonth(workspaceId, year, month),
    buildMonth(workspaceId, prev.year, prev.month),
  ]);

  // 5-month history ending at `current`, oldest first.
  const points: Array<{ year: number; month: number }> = [];
  let cy = year;
  let cm = month;
  for (let i = 0; i < 5; i++) {
    points.unshift({ year: cy, month: cm });
    const p = prevMonth(cy, cm);
    cy = p.year;
    cm = p.month;
  }
  const monthlyHistory = await Promise.all(
    points.map(async (p) => {
      const flows = await monthFlows(workspaceId, p.year, p.month);
      return {
        year: p.year,
        month: p.month,
        label: MONTH_SHORT[p.month - 1] ?? "",
        income: Math.round(flows.income * 100) / 100,
        spend: Math.round(flows.spend * 100) / 100,
      };
    }),
  );

  // Heuristic: if every history point has both income and spend at 0, the
  // workspace has no transactions yet — return previous as null so the UI
  // can show "no comparison yet" instead of "-100% vs previous".
  const previousHasData =
    previous.income > 0 || previous.spend > 0 || previous.spendByCategory.length > 0;

  return {
    current,
    previous: previousHasData ? previous : null,
    monthlyHistory,
  };
}
