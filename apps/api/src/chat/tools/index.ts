import type { ToolDef } from "./types.js";
import { listTransactions } from "./list-transactions.js";
import { getSpendingSummary } from "./get-spending-summary.js";
import { listCategories } from "./list-categories.js";
import { categorizeTransaction } from "./categorize-transaction.js";
import { listAccounts } from "./list-accounts.js";
import { getTransactionDetails } from "./get-transaction-details.js";
import { findUncategorizedTransactions } from "./find-uncategorized-transactions.js";
import { getCategoryBreakdown } from "./get-category-breakdown.js";
import { compareSpendingPeriods } from "./compare-spending-periods.js";
import { detectRecurringMerchants } from "./detect-recurring-merchants.js";
import { getCashflowSummary } from "./get-cashflow-summary.js";
import { findTransactions } from "./find-transactions.js";

export const REGISTRY: ToolDef[] = [
  listTransactions as ToolDef,
  getSpendingSummary as ToolDef,
  listCategories as ToolDef,
  categorizeTransaction as ToolDef,
  listAccounts as ToolDef,
  getTransactionDetails as ToolDef,
  findUncategorizedTransactions as ToolDef,
  getCategoryBreakdown as ToolDef,
  compareSpendingPeriods as ToolDef,
  detectRecurringMerchants as ToolDef,
  getCashflowSummary as ToolDef,
  findTransactions as ToolDef,
];
