import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { customRange, dateKeyInTz, resolveUserTz } from "./periods.js";
import { formatPeriodLabel } from "./recap-label.js";

const Args = z.object({
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Inclusive start date (YYYY-MM-DD) in the user's timezone."),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Exclusive end date (YYYY-MM-DD) in the user's timezone — must be > since."),
  group_by: z
    .enum(["day", "account"])
    .describe("Optional grouping dimension. Defaults to day.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Group = {
  key: string;
  label: string;
  incomeTotal: string;
  expenseTotal: string;
  netTotal: string;
  count: number;
};

type Result = {
  since: string;
  until: string;
  groupBy: "day" | "account";
  currency: string;
  incomeTotal: string;
  expenseTotal: string;
  netTotal: string;
  groups: Group[];
  block: PresentationBlock;
};

const MAX_RECAP_ROWS = 8;

export const getCashflowSummary: ToolDef<Args, Result> = {
  name: "getCashflowSummary",
  description:
    "Summarize CAD income, expenses, and net cashflow for a date range, grouped by day or account. " +
    "Pass YYYY-MM-DD since/until from the 'Today' anchor in your context. " +
    "Use this whenever the user asks about both directions (income vs expense) or net flow.",
  args: Args,
  async run(ctx, args) {
    const groupBy = args.group_by ?? "day";
    const [{ gte, lt }, tz, workspace] = await Promise.all([
      customRange(ctx.userId, args.since, args.until),
      resolveUserTz(ctx.userId),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    const rows = await prisma.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        removedAt: null,
        occurredAt: { gte, lt },
      },
      select: {
        amount: true,
        accountId: true,
        account: { select: { id: true, name: true } },
        occurredAt: true,
      },
    });

    type Agg = { key: string; label: string; income: Prisma.Decimal; expense: Prisma.Decimal; count: number };
    const buckets = new Map<string, Agg>();
    let totalIncome = new Prisma.Decimal(0);
    let totalExpense = new Prisma.Decimal(0);

    for (const r of rows) {
      const amt = new Prisma.Decimal(r.amount);
      let key: string;
      let label: string;
      if (groupBy === "day") {
        key = dateKeyInTz(r.occurredAt, tz);
        label = key;
      } else {
        key = r.accountId;
        label = r.account.name;
      }
      let b = buckets.get(key);
      if (!b) {
        b = { key, label, income: new Prisma.Decimal(0), expense: new Prisma.Decimal(0), count: 0 };
        buckets.set(key, b);
      }
      if (amt.greaterThan(0)) {
        b.expense = b.expense.plus(amt);
        totalExpense = totalExpense.plus(amt);
      } else if (amt.lessThan(0)) {
        const abs = amt.abs();
        b.income = b.income.plus(abs);
        totalIncome = totalIncome.plus(abs);
      }
      b.count += 1;
    }

    const groups: Group[] = [...buckets.values()].map((b) => ({
      key: b.key,
      label: b.label,
      incomeTotal: b.income.toFixed(2),
      expenseTotal: b.expense.toFixed(2),
      netTotal: b.income.minus(b.expense).toFixed(2),
      count: b.count,
    }));

    if (groupBy === "day") {
      groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } else {
      groups.sort((a, b) => {
        const aAct = Math.abs(parseFloat(a.incomeTotal)) + Math.abs(parseFloat(a.expenseTotal));
        const bAct = Math.abs(parseFloat(b.incomeTotal)) + Math.abs(parseFloat(b.expenseTotal));
        if (bAct !== aAct) return bAct - aAct;
        return a.label.localeCompare(b.label);
      });
    }

    const netStr = totalIncome.minus(totalExpense).toFixed(2);
    return {
      since: args.since,
      until: args.until,
      groupBy,
      currency: workspace.currency,
      incomeTotal: totalIncome.toFixed(2),
      expenseTotal: totalExpense.toFixed(2),
      netTotal: netStr,
      groups,
      block: toRecapBlock(
        args.since,
        args.until,
        workspace.currency,
        totalIncome.toFixed(2),
        totalExpense.toFixed(2),
        netStr,
        groups,
      ),
    };
  },
};

function toRecapBlock(
  since: string,
  until: string,
  currency: string,
  incomeTotal: string,
  expenseTotal: string,
  netTotal: string,
  groups: Group[],
): PresentationBlock {
  const netNum = parseFloat(netTotal);

  const summaryRows = [
    {
      label: "Income",
      amount: incomeTotal,
      delta: { value: incomeTotal, direction: "up" as const },
    },
    {
      label: "Expenses",
      amount: expenseTotal,
      delta: { value: expenseTotal, direction: "down" as const },
    },
  ];

  const detailRows = groups.slice(0, MAX_RECAP_ROWS).map((g) => ({
    label: g.label,
    amount: g.netTotal,
    sub: `In ${g.incomeTotal} · Out ${g.expenseTotal}`,
  }));

  const rows = [...summaryRows, ...detailRows];

  return {
    type: "recap",
    title: "Cashflow",
    period_label: formatPeriodLabel(since, until),
    headline: {
      label: "Net",
      amount: netTotal,
      currency,
      ...(netNum !== 0
        ? {
            delta: {
              value: Math.abs(netNum).toFixed(2),
              direction: (netNum > 0 ? "up" : "down") as "up" | "down",
            },
          }
        : {}),
    },
    rows,
    ...(groups.length > MAX_RECAP_ROWS
      ? { footer: `Top ${MAX_RECAP_ROWS} of ${groups.length}` }
      : {}),
  };
}
