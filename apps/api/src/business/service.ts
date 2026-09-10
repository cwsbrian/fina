import { Prisma } from "@prisma/client";
import type { BusinessExpenseRow, BusinessOverview } from "@fina/shared";
import { prisma } from "../db.js";
import { evidenceStatus } from "./evidence.js";
import { ensureRefundLinks } from "../transactions/refunds.js";

const receiptSelect = {
  role: true,
  status: true,
  merchantName: true,
  receiptDate: true,
  totalAmount: true,
  deletedAt: true,
  verifiedAt: true,
  lineItems: { select: { id: true } },
} as const;

function monthRange(yearMonth: string): { start: Date; end: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) throw new Error("invalid_year_month");
  const [year, month] = yearMonth.split("-").map(Number) as [number, number];
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

type ExpenseTx = Prisma.TransactionGetPayload<{ include: {
  allocations: true;
  receipts: { select: typeof receiptSelect };
  refunds: { select: { amount: true } };
} }>;

function businessBreakdown(tx: ExpenseTx): { confirmed: Prisma.Decimal; unreviewed: Prisma.Decimal } {
  const grossBusiness = tx.allocations.reduce((sum, a) => sum.plus(a.businessAmount ?? 0), new Prisma.Decimal(0));
  const unreviewed = tx.allocations.reduce(
    (sum, a) => a.businessAmount === null ? sum.plus(a.amount.abs()) : sum,
    new Prisma.Decimal(0),
  );
  if (grossBusiness.equals(0) || tx.amount.equals(0)) return { confirmed: grossBusiness, unreviewed };
  const ratio = grossBusiness.dividedBy(tx.amount.abs());
  const businessRefunds = tx.refunds.reduce(
    (sum, refund) => sum.plus(refund.amount.abs().times(ratio)),
    new Prisma.Decimal(0),
  );
  return { confirmed: Prisma.Decimal.max(0, grossBusiness.minus(businessRefunds)), unreviewed };
}

function toRow(tx: ExpenseTx, currency: string): BusinessExpenseRow {
  const { confirmed: business, unreviewed } = businessBreakdown(tx);
  return {
    transactionId: tx.id,
    version: tx.version,
    merchant: tx.merchantNormalized ?? tx.merchantRaw,
    occurredAt: tx.occurredAt.toISOString(),
    totalAmount: tx.amount.abs().toFixed(2),
    businessAmount: business.toFixed(2),
    currency,
    partial: business.greaterThan(0) && business.lessThan(tx.amount.abs()),
    evidenceStatus: evidenceStatus(tx),
    expenseReview: unreviewed.greaterThan(0),
    unreviewedAmount: unreviewed.toFixed(2),
  };
}

async function expenseTransactions(workspaceId: string, yearMonth: string): Promise<{ currency: string; transactions: ExpenseTx[] }> {
  const { start, end } = monthRange(yearMonth);
  await ensureRefundLinks(workspaceId);
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } });
  const transactions = await prisma.transaction.findMany({
    where: {
      workspaceId,
      occurredAt: { gte: start, lt: end },
      removedAt: null,
      billingGraceHiddenAt: null,
      budgetImpact: "expense",
    },
    include: {
      allocations: true,
      receipts: { select: receiptSelect },
      refunds: { where: { budgetImpact: "refund", removedAt: null, pending: false }, select: { amount: true } },
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
  return { currency: workspace.currency, transactions };
}

export async function listBusinessExpenses(
  workspaceId: string,
  yearMonth: string,
  view?: "business" | "review" | "missing",
): Promise<BusinessExpenseRow[]> {
  const { currency, transactions } = await expenseTransactions(workspaceId, yearMonth);
  return transactions.map((tx) => toRow(tx, currency)).filter((row) => {
    if (view === "review") return row.expenseReview;
    if (view === "missing") return row.businessAmount !== "0.00" && row.evidenceStatus !== "complete";
    if (view === "business") return row.businessAmount !== "0.00";
    return true;
  });
}

export async function getBusinessOverview(workspaceId: string, yearMonth: string): Promise<BusinessOverview> {
  const { start, end } = monthRange(yearMonth);
  const [{ currency, transactions }, incomes] = await Promise.all([
    expenseTransactions(workspaceId, yearMonth),
    prisma.transaction.findMany({
      where: { workspaceId, occurredAt: { gte: start, lt: end }, removedAt: null, billingGraceHiddenAt: null, budgetImpact: "income" },
      include: { allocations: true },
    }),
  ]);
  const rows = transactions.map((tx) => toRow(tx, currency));
  const income = incomes.reduce((total, tx) => total.plus(
    tx.allocations.reduce((sum, a) => sum.plus(a.businessAmount ?? 0), new Prisma.Decimal(0)),
  ), new Prisma.Decimal(0));
  let expenses = new Prisma.Decimal(0);
  let reviewAmount = new Prisma.Decimal(0);
  for (const tx of transactions) {
    const amount = businessBreakdown(tx);
    expenses = expenses.plus(amount.confirmed);
    reviewAmount = reviewAmount.plus(amount.unreviewed);
  }
  return {
    yearMonth,
    currency,
    incomeRecorded: income.toFixed(2),
    confirmedBusinessExpenses: expenses.toFixed(2),
    incomeMinusConfirmedExpenses: income.minus(expenses).toFixed(2),
    expenseReviewAmount: reviewAmount.toFixed(2),
    expenseReviewCount: rows.filter((r) => r.expenseReview).length,
    missingEvidenceCount: rows.filter((r) => r.businessAmount !== "0.00" && r.evidenceStatus !== "complete").length,
    hasUnreviewedTransactions: rows.some((r) => r.expenseReview),
    recentExpenses: rows.filter((r) => r.businessAmount !== "0.00").slice(0, 5),
  };
}
