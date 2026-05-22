import { prisma } from "../db.js";
import { resolveUserTz, partsInTz } from "./tools/periods.js";

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
  /** Budget progress for the relevant period. */
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

  // Budgets — fetch this-month budgets via periodStart (DateTime @db.Date,
  // first day of month). Compute first-of-this-month in the USER's tz so
  // edge-of-month edge cases (e.g., UTC May 1 00:30 = Toronto April 30
  // 20:30, user is still on April) match the user's intent.
  const nowInUserTz = partsInTz(now, tz);
  const firstOfMonth = new Date(
    Date.UTC(nowInUserTz.year, nowInUserTz.month - 1, 1),
  );
  const budgets = await prisma.budget.findMany({
    where: { workspaceId, periodStart: firstOfMonth },
    include: { category: { select: { name: true } } },
    take: 50,
  });
  const budgetsFmt = budgets.map((b) => ({
    category: b.category.name,
    budgeted: b.amount.toString(),
    // Spent amount: query allocations for this category in current month.
    // For v1, we leave spent as placeholder "0" — real computation deferred
    // to v1.5. The LLM can still produce a useful brief with budgeted alone.
    spent: "0",
    percent: 0,
  }));

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
