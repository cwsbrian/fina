import type { Prisma } from "@prisma/client";

type PlaidBudgetTx = {
  amount: number;
  name?: string | null;
  merchant_name?: string | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
  } | null;
};

export type BudgetImpactValue = "expense" | "excluded";

export function budgetImpactForAmount(amount: number): BudgetImpactValue {
  return amount > 0 ? "expense" : "excluded";
}

export function budgetExpenseTransactionWhere(
  extra: Prisma.TransactionWhereInput = {},
): Prisma.TransactionWhereInput {
  return {
    ...extra,
    removedAt: null,
    amount: { gt: 0 },
    budgetImpact: "expense",
  };
}

export function budgetExpenseAllocationWhere(
  transaction: Prisma.TransactionWhereInput = {},
): Prisma.TransactionAllocationWhereInput {
  return {
    amount: { gt: 0 },
    transaction: budgetExpenseTransactionWhere(transaction),
  };
}

export function classifyPlaidBudgetImpact(t: PlaidBudgetTx): BudgetImpactValue {
  if (budgetImpactForAmount(t.amount) === "excluded") return "excluded";

  const detailed = t.personal_finance_category?.detailed?.toUpperCase() ?? "";
  const text = `${t.name ?? ""} ${t.merchant_name ?? ""}`.toUpperCase();

  if (detailed.includes("INVESTMENT") || detailed.includes("RETIREMENT")) return "excluded";
  if (detailed.includes("CREDIT_CARD_PAYMENT")) return "excluded";
  if (/\b(PAYMENT|PYMT|PMT)\b/.test(text) && /\b(CREDIT|CARD|VISA|MASTERCARD|AMEX)\b/.test(text)) {
    return "excluded";
  }

  return "expense";
}
