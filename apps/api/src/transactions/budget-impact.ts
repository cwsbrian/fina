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

const INVESTMENT_ACCOUNT_KEYWORDS = [
  "RSP",
  "RRSP",
  "TFSA",
  "RESP",
  "RDSP",
  "FHSA",
  "LIRA",
  "LRSP",
  "RRIF",
  "IRA",
  "401K",
  "403B",
  "457B",
  "HSA",
  "529",
] as const;

const INVESTMENT_GENERIC_KEYWORDS = [
  "ROTH",
  "INVEST",
  "INVESTMENT",
  "BROKERAGE",
  "WEALTH",
  "SECURITIES",
  "TRADING",
  "RETIREMENT",
  "PENSION",
  "REGISTERED",
] as const;

const INVESTMENT_PROVIDER_KEYWORDS = [
  "WEALTHSIMPLE",
  "QUESTRADE",
  "RBC DIRECT INVESTING",
  "TD DIRECT INVESTING",
  "FIDELITY",
  "VANGUARD",
  "SCHWAB",
  "E-TRADE",
  "ROBINHOOD",
  "MERRILL",
] as const;

const SAFE_EXPENSE_DETAILED = [
  "TRANSFER_OUT_WITHDRAWAL",
  "LOAN_PAYMENTS_MORTGAGE_PAYMENT",
  "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT",
  "LOAN_PAYMENTS_BNPL",
  "BANK_FEES",
] as const;

const INVESTMENT_KEYWORDS = [
  ...INVESTMENT_GENERIC_KEYWORDS,
  ...INVESTMENT_PROVIDER_KEYWORDS,
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKeyword(text: string, keyword: string): boolean {
  return new RegExp(`(^|[^A-Z0-9])${escapeRegExp(keyword)}([^A-Z0-9]|$)`).test(text);
}

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

  const primary = t.personal_finance_category?.primary?.toUpperCase() ?? "";
  const detailed = t.personal_finance_category?.detailed?.toUpperCase() ?? "";
  const text = `${t.name ?? ""} ${t.merchant_name ?? ""}`.toUpperCase();

  if (SAFE_EXPENSE_DETAILED.some((value) => detailed.startsWith(value))) return "expense";
  if (detailed.includes("INVESTMENT") || detailed.includes("RETIREMENT")) return "excluded";
  if (detailed.includes("CREDIT_CARD_PAYMENT")) return "excluded";
  if (/\b(PAYMENT|PYMT|PMT)\b/.test(text) && /\b(CREDIT|CARD|VISA|MASTERCARD|AMEX)\b/.test(text)) {
    return "excluded";
  }
  if (INVESTMENT_ACCOUNT_KEYWORDS.some((keyword) => hasKeyword(text, keyword))) {
    return "excluded";
  }
  if (
    (primary.startsWith("TRANSFER_") || detailed.startsWith("TRANSFER_"))
    && INVESTMENT_KEYWORDS.some((keyword) => hasKeyword(text, keyword))
  ) {
    return "excluded";
  }

  return "expense";
}
