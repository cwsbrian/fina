import { prisma } from "../db.js";
import { resolveUserTz, partsInTz } from "./tools/periods.js";
import { budgetPlanSnapshot } from "../budget-plans/service.js";

export type BriefType = "daily" | "weekly" | "monthly";

export type WorkspaceContext = {
  id: string;
  name: string;
  currency: string;
  /** New transactions in the relevant window. Pre-formatted display strings. */
  newTransactions: {
    count: number;
    sample: Array<{
      merchant: string;
      amount: string;
      occurredAt: string;
      category: string | null;
    }>;
  };
  uncategorizedCount: number;
  /** Upcoming schedule items in the relevant window. */
  schedule: Array<{ category: string; amount: string; date: string }>;
  /** Overall monthly budget (BudgetPlan total cap) progress, or null when
   *  the workspace has no plan. */
  budgetTotal: { cap: string; spent: string; percent: number } | null;
  /** Per-capped-category budget progress for the current month. */
  budgets: Array<{
    category: string;
    budgeted: string;
    spent: string;
    percent: number;
  }>;
  /** Recurring expenses due in the relevant window. */
  recurring: Array<{
    merchant: string;
    amount: string;
    cadence: string;
    nextDate: string;
  }>;
  /** Pace deviation summary (one sentence). */
  deviation: string | null;
};

export type BriefContext = {
  user: { id: string; name: string | null; tz: string; morningTime: string };
  briefType: BriefType;
  /** ISO date in user's tz at generation time. */
  date: string;
  workspaces: WorkspaceContext[];
};

export async function buildBriefContext(
  userId: string,
  briefType: BriefType,
): Promise<BriefContext> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, name: true, tz: true, morningTime: true },
  });
  const tz = await resolveUserTz(userId);
  const dateIso = isoDateInTz(new Date(), tz);

  const memberships = await prisma.membership.findMany({
    where: { userId },
    include: {
      workspace: { select: { id: true, name: true, currency: true } },
    },
  });

  const workspaces: WorkspaceContext[] = [];
  for (const m of memberships) {
    workspaces.push(
      await buildWorkspaceContext(m.workspaceId, m.workspace, briefType, tz),
    );
  }

  return { user, briefType, date: dateIso, workspaces };
}

/** Per-workspace data fetch + format. */
async function buildWorkspaceContext(
  workspaceId: string,
  ws: { id: string; name: string; currency: string },
  briefType: BriefType,
  tz: string,
): Promise<WorkspaceContext> {
  const now = new Date();
  const txWindowStart = txWindowStartFor(briefType, now, tz);
  const scheduleWindowEnd = scheduleWindowEndFor(briefType, now, tz);

  // New transactions in the window.
  const txs = await prisma.transaction.findMany({
    where: {
      workspaceId,
      removedAt: null,
      occurredAt: { gte: txWindowStart },
    },
    select: {
      id: true,
      amount: true,
      merchantRaw: true,
      occurredAt: true,
      allocations: { select: { category: { select: { name: true } } } },
    },
    orderBy: { occurredAt: "desc" },
    take: 200,
  });

  const newCount = txs.length;
  const uncategorizedCount = txs.filter((t) => t.allocations.length === 0).length;
  const sample = txs.slice(0, 5).map((t) => ({
    merchant: t.merchantRaw,
    amount: t.amount.toString(),
    occurredAt: t.occurredAt.toISOString(),
    category: t.allocations[0]?.category?.name ?? null,
  }));

  // Schedule (upcoming).
  const schedule = await prisma.scheduledSpend.findMany({
    where: {
      workspaceId,
      dismissedAt: null,
      matchedTxId: null,
      scheduledDate: { gte: now, lte: scheduleWindowEnd },
    },
    select: {
      amount: true,
      scheduledDate: true,
      category: { select: { name: true } },
    },
    orderBy: { scheduledDate: "asc" },
    take: 20,
  });
  const scheduleFmt = schedule.map((s) => ({
    category: s.category.name,
    amount: s.amount.toString(),
    date: s.scheduledDate.toISOString().slice(0, 10),
  }));

  // Budgets — from the real BudgetPlan (total cap + per-category caps) with
  // actual spend, the same source as the Budget screen and chat. Uses the
  // user's local calendar month. (Replaces the legacy per-category Budget
  // table, which the app no longer writes — it was always empty here.)
  const nowInUserTz = partsInTz(now, tz);
  const snapshot = await budgetPlanSnapshot(workspaceId, nowInUserTz.year, nowInUserTz.month);
  let budgetTotal: { cap: string; spent: string; percent: number } | null = null;
  if (snapshot && parseFloat(snapshot.totalAmount) > 0) {
    const cap = parseFloat(snapshot.totalAmount);
    const spent = parseFloat(snapshot.totalSpent);
    budgetTotal = {
      cap: snapshot.totalAmount,
      spent: snapshot.totalSpent,
      percent: cap > 0 ? Math.round((spent / cap) * 100) : 0,
    };
  }
  const budgetsFmt = (snapshot?.categories ?? [])
    .filter((c) => c.allocated !== null)
    .map((c) => {
      const allocated = parseFloat(c.allocated!);
      const spent = parseFloat(c.spent);
      return {
        category: c.categoryName,
        budgeted: c.allocated!,
        spent: c.spent,
        percent: allocated > 0 ? Math.round((spent / allocated) * 100) : 0,
      };
    });

  // Recurring expenses due in window.
  const recurring = await prisma.recurringExpense.findMany({
    where: {
      workspaceId,
      nextOccurrenceDate: { gte: now, lte: scheduleWindowEnd },
    },
    select: {
      name: true,
      amount: true,
      cadence: true,
      nextOccurrenceDate: true,
    },
    orderBy: { nextOccurrenceDate: "asc" },
    take: 20,
  });
  const recurringFmt = recurring.map((r) => ({
    merchant: r.name,
    amount: r.amount.toString(),
    cadence: r.cadence,
    nextDate: r.nextOccurrenceDate.toISOString().slice(0, 10),
  }));

  return {
    id: ws.id,
    name: ws.name,
    currency: ws.currency,
    newTransactions: { count: newCount, sample },
    uncategorizedCount,
    schedule: scheduleFmt,
    budgetTotal,
    budgets: budgetsFmt,
    recurring: recurringFmt,
    deviation: null,
  };
}

/** Window-start for "new transactions" per brief type. */
function txWindowStartFor(briefType: BriefType, now: Date, tz: string): Date {
  switch (briefType) {
    case "daily":
      return shiftDaysInTz(now, -1, tz);
    case "weekly":
      return shiftDaysInTz(now, -7, tz);
    case "monthly":
      return shiftDaysInTz(now, -30, tz);
  }
}

/** Window-end for "upcoming schedule" per brief type. */
function scheduleWindowEndFor(
  briefType: BriefType,
  now: Date,
  tz: string,
): Date {
  switch (briefType) {
    case "daily":
      return shiftDaysInTz(now, 7, tz);
    case "weekly":
      return shiftDaysInTz(now, 28, tz);
    case "monthly":
      return shiftDaysInTz(now, 30, tz);
  }
}

function shiftDaysInTz(d: Date, days: number, _tz: string): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDateInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}
