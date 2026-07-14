import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { ensureRefundLinks } from "./refunds.js";

function refundedAmount(refunds: Array<{ amount: Prisma.Decimal }>): number {
  return refunds.reduce((sum, refund) => sum + refund.amount.abs().toNumber(), 0);
}

export type EffectiveExpenseTransaction = {
  id: string;
  amount: number;
  grossAmount: number;
  occurredAt: Date;
  accountId: string;
  accountName: string;
  merchantRaw: string;
  merchantNormalized: string | null;
};

export async function effectiveExpenseTransactions(
  workspaceId: string,
  extra: Prisma.TransactionWhereInput = {},
): Promise<EffectiveExpenseTransaction[]> {
  await ensureRefundLinks(workspaceId);
  const rows = await prisma.transaction.findMany({
    where: {
      ...extra,
      workspaceId,
      removedAt: null,
      amount: { gt: 0 },
      budgetImpact: "expense",
    },
    select: {
      id: true,
      amount: true,
      occurredAt: true,
      accountId: true,
      account: { select: { name: true } },
      merchantRaw: true,
      merchantNormalized: true,
      refunds: {
        where: { budgetImpact: "refund", removedAt: null, pending: false },
        select: { amount: true },
      },
    },
  });
  return rows.map((row) => {
    const grossAmount = row.amount.toNumber();
    return {
      id: row.id,
      amount: Math.max(0, grossAmount - refundedAmount(row.refunds)),
      grossAmount,
      occurredAt: row.occurredAt,
      accountId: row.accountId,
      accountName: row.account.name,
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
    };
  });
}

export type EffectiveExpenseAllocation = {
  transactionId: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryIcon: string | null;
  categoryColor: string | null;
  amount: number;
  occurredAt: Date;
  merchantRaw: string;
  merchantNormalized: string | null;
};

export async function effectiveExpenseAllocations(
  workspaceId: string,
  extra: Prisma.TransactionWhereInput = {},
  categoryIds?: string[],
): Promise<EffectiveExpenseAllocation[]> {
  await ensureRefundLinks(workspaceId);
  const rows = await prisma.transaction.findMany({
    where: {
      ...extra,
      workspaceId,
      removedAt: null,
      amount: { gt: 0 },
      budgetImpact: "expense",
    },
    select: {
      id: true,
      amount: true,
      occurredAt: true,
      merchantRaw: true,
      merchantNormalized: true,
      allocations: {
        where: {
          amount: { gt: 0 },
          ...(categoryIds ? { categoryId: { in: categoryIds } } : {}),
        },
        select: {
          amount: true,
          categoryId: true,
          category: { select: { name: true, icon: true, color: true } },
        },
      },
      refunds: {
        where: { budgetImpact: "refund", removedAt: null, pending: false },
        select: { amount: true },
      },
    },
  });

  return rows.flatMap((row) => {
    const gross = row.amount.toNumber();
    const effective = Math.max(0, gross - refundedAmount(row.refunds));
    if (effective < 0.005 || gross <= 0) return [];
    const ratio = effective / gross;
    return row.allocations.map((allocation) => ({
      transactionId: row.id,
      categoryId: allocation.categoryId,
      categoryName: allocation.category?.name ?? null,
      categoryIcon: allocation.category?.icon ?? null,
      categoryColor: allocation.category?.color ?? null,
      amount: allocation.amount.toNumber() * ratio,
      occurredAt: row.occurredAt,
      merchantRaw: row.merchantRaw,
      merchantNormalized: row.merchantNormalized,
    }));
  });
}

export type CashflowEntry = {
  transactionId: string;
  direction: "expense" | "income";
  amount: number;
  occurredAt: Date;
  accountId: string;
  accountName: string;
};

export async function cashflowEntries(
  workspaceId: string,
  extra: Prisma.TransactionWhereInput = {},
): Promise<CashflowEntry[]> {
  await ensureRefundLinks(workspaceId);
  const [expenses, income] = await Promise.all([
    effectiveExpenseTransactions(workspaceId, extra),
    prisma.transaction.findMany({
      where: {
        ...extra,
        workspaceId,
        removedAt: null,
        amount: { lt: 0 },
        budgetImpact: "income",
      },
      select: {
        id: true,
        amount: true,
        occurredAt: true,
        accountId: true,
        account: { select: { name: true } },
      },
    }),
  ]);
  return [
    ...expenses.flatMap((row) => row.amount < 0.005 ? [] : [{
      transactionId: row.id,
      direction: "expense" as const,
      amount: row.amount,
      occurredAt: row.occurredAt,
      accountId: row.accountId,
      accountName: row.accountName,
    }]),
    ...income.map((row) => ({
      transactionId: row.id,
      direction: "income" as const,
      amount: row.amount.abs().toNumber(),
      occurredAt: row.occurredAt,
      accountId: row.accountId,
      accountName: row.account.name,
    })),
  ];
}
