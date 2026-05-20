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
import { createCategory } from "./create-category.js";
import { addTransactionNote } from "./add-transaction-note.js";
import { setBudget } from "./set-budget.js";
import { getBudget } from "./get-budget.js";
import { compareSpendingVsBudget } from "./compare-spending-vs-budget.js";
import { mapMerchantToCategory } from "./map-merchant-to-category.js";
import { addRecurring } from "./add-recurring.js";
import { listRecurring } from "./list-recurring.js";
import { removeRecurring } from "./remove-recurring.js";
import { presentConfirmCard } from "./present-confirm-card.js";
import { addScheduledSpend } from "./add-scheduled-spend.js";
import { listScheduledSpends } from "./list-scheduled-spends.js";
import { listUnresolvedSchedules } from "./list-unresolved-schedules.js";
import { dismissScheduledSpend } from "./dismiss-scheduled-spend.js";
import { removeScheduledSpend } from "./remove-scheduled-spend.js";

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
  createCategory as ToolDef,
  addTransactionNote as ToolDef,
  setBudget as ToolDef,
  getBudget as ToolDef,
  compareSpendingVsBudget as ToolDef,
  mapMerchantToCategory as ToolDef,
  addRecurring as ToolDef,
  listRecurring as ToolDef,
  removeRecurring as ToolDef,
  presentConfirmCard as ToolDef,
  addScheduledSpend as ToolDef,
  listScheduledSpends as ToolDef,
  listUnresolvedSchedules as ToolDef,
  dismissScheduledSpend as ToolDef,
  removeScheduledSpend as ToolDef,
];
