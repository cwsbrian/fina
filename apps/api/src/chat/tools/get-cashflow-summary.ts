import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { basicPeriodRange, dateKeyInTz, resolveUserTz, type BasicPeriod } from "./periods.js";

const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month"]).describe("Period to summarize cashflow."),
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
  period: BasicPeriod;
  groupBy: "day" | "account";
  currency: "CAD";
  incomeTotal: string;
  expenseTotal: string;
  netTotal: string;
  excludedNonCadCount: number;
  groups: Group[];
};

export const getCashflowSummary: ToolDef<Args, Result> = {
  name: "getCashflowSummary",
  description: "Summarize CAD income, expenses, and net cashflow for a period, grouped by day or account.",
  args: Args,
  async run(ctx, args) {
    const groupBy = args.group_by ?? "day";
    const [{ gte, lt }, tz] = await Promise.all([
      basicPeriodRange(ctx.userId, args.period),
      resolveUserTz(ctx.userId),
    ]);

    const [rows, excludedNonCadCount] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: "CAD",
          occurredAt: { gte, lt },
        },
        select: {
          amount: true,
          accountId: true,
          account: { select: { id: true, name: true } },
          occurredAt: true,
        },
      }),
      prisma.transaction.count({
        where: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          currency: { not: "CAD" },
          occurredAt: { gte, lt },
        },
      }),
    ]);

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

    return {
      period: args.period,
      groupBy,
      currency: "CAD",
      incomeTotal: totalIncome.toFixed(2),
      expenseTotal: totalExpense.toFixed(2),
      netTotal: totalIncome.minus(totalExpense).toFixed(2),
      excludedNonCadCount,
      groups,
    };
  },
};
