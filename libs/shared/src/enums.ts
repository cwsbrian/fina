// Cross-app string-literal unions. Use these instead of redeclaring the
// same string union in each app.

export const CADENCES = ["monthly", "semimonthly", "biweekly", "weekly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

/** Periods used by `setBudget` / `getBudget` / `compareSpendingVsBudget`. */
export const BUDGET_PERIODS = ["this_month", "last_month", "next_month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** Periods used by `getSpendingSummary` and similar read tools. */
export const BASIC_PERIODS = ["today", "this_week", "this_month", "last_month"] as const;
export type BasicPeriod = (typeof BASIC_PERIODS)[number];

/** Status values surfaced on a ScheduledSpend list. `"all"` is a list filter,
 * not a real status — exclude when narrowing a row's actual state. */
export const SCHEDULED_SPEND_STATUSES = [
  "upcoming",
  "unresolved",
  "resolved-matched",
  "resolved-dismissed",
] as const;
export type ScheduledSpendStatus = (typeof SCHEDULED_SPEND_STATUSES)[number];

export const SCHEDULED_SPEND_LIST_FILTERS = [
  ...SCHEDULED_SPEND_STATUSES,
  "all",
] as const;
export type ScheduledSpendListFilter = (typeof SCHEDULED_SPEND_LIST_FILTERS)[number];

/** Chat message author roles. Mirror of the Prisma `ChatMessageRole` enum. */
export const CHAT_MESSAGE_ROLES = ["user", "assistant", "tool"] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

/** Forecast severity tiers surfaced by the chat advisor + daily brief.
 *  Ordered by increasing risk; `insufficient_history` means "too new to
 *  forecast", not a risk level. */
export const RISK_TIERS = [
  "on_track",
  "watch",
  "at_risk",
  "insufficient_history",
] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
