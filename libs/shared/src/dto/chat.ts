import type { ChatMessageRole, Cadence, ScheduledSpendStatus, RiskTier } from "../enums.js";
import type { PlaidItemStatus } from "./plaid.js";

/** Plan 2-chat-user-scope: threads are user-owned with nullable workspace.
 *  workspaceId is `null` until the user's first message binds the thread. */
export type ChatThreadDTO = {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  /** ISO 8601 timestamps. */
  lastMessageAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 timestamp the user last marked this thread as read, or null
   *  if the thread has never been opened. */
  lastReadAt: string | null;
  /** Server-computed count of assistant messages in this thread whose
   *  createdAt is after lastReadAt (or all assistant messages if
   *  lastReadAt is null). user/tool role messages are NOT counted. */
  unreadCount: number;
};

/** A row from `GET /chat/threads/:tid` messages list, or the user/assistant
 *  messages returned by `POST /chat/threads/:tid/messages`. */
export type ChatMessageDTO = {
  id: string;
  role: ChatMessageRole;
  /** Discriminated union of presentation blocks — see PresentationBlock. */
  blocks: unknown;
  /** ISO 8601 timestamp. */
  createdAt: string;
};

/** UI block kinds the assistant can emit. Renderers in mobile/web should
 *  exhaustively handle this union. */
export type PresentationBlock =
  | { type: "text"; markdown: string }
  | {
      type: "confirm_card";
      question: string;
      accept_label: string;
      reject_label: string;
      accept_intent: string;
      reject_intent?: string;
    }
  | {
      type: "categorize_confirm_card";
      count: number;
      items: { txId: string; merchant: string; categoryName: string }[];
      moreCount: number;
    }
  | {
      /** Read-only recap card. Used by getSpendingSummary,
       *  getCategoryBreakdown, compareSpendingPeriods, getCashflowSummary,
       *  compareSpendingVsBudget. Fields are intentionally generic so a
       *  single renderer covers all five tools.
       *
       *  Amounts are strings (Decimal serialization-safe) without currency
       *  symbols; renderer formats with `currency`. Bars (`bar_pct`) scale
       *  0–100; renderer decides whether to draw them.
       */
      type: "recap";
      /** Card title — e.g. "Spending · this month", "vs last month". */
      title: string;
      /** Optional human-readable period label under the title — e.g.
       *  "Nov 1 — Nov 27, 2026". */
      period_label?: string;
      /** Optional headline number (large) — total / net / used. */
      headline?: {
        /** Small label above the amount — e.g. "Total" / "Net" / "Used". */
        label?: string;
        amount: string;
        /** ISO 4217 — "CAD" / "USD". Renderer formats. */
        currency?: string;
        /** Optional delta vs reference (used by compare tools). */
        delta?: {
          /** Stringified absolute delta (e.g. "12.40" or "8%"). */
          value: string;
          direction: "up" | "down";
        };
        /** Optional projected month-end total, stringified, no currency symbol. */
        projected?: string;
      };
      /** Detail rows. Empty array means "no data this period" — renderer
       *  shows a friendly empty state. */
      rows: Array<{
        /** Display label — category, merchant, day, or fixed row name. */
        label: string;
        /** Stringified amount (no currency symbol). */
        amount: string;
        /** Optional secondary text — "3 tx" / "budget $200" / "vs $180". */
        sub?: string;
        /** Optional 0–100 bar value for relative visualization. */
        bar_pct?: number;
        delta?: {
          value: string;
          direction: "up" | "down";
        };
        /** Optional projected month-end spend for this row. */
        projected?: string;
        /** Optional forecast severity for this row. */
        severity?: RiskTier;
      }>;
      /** Optional footer line — e.g. "Top 5 of 23 categories" or trend
       *  commentary. Renderer styles as small muted text. */
      footer?: string;
    }
  | {
      /** Read-only transactions list card. Used by listTransactions,
       *  findTransactions, findUncategorizedTransactions. Generic enough
       *  for "recent N", search results, and the review queue alike;
       *  presence/absence of the optional fields (category chip, account
       *  badge, needs_review flag) lets one renderer cover all three.
       *
       *  Amounts are signed strings — positive = expense (money out),
       *  negative = income (money in) — matching Plaid + our DB
       *  convention. The renderer colorizes income green and expense ink,
       *  and shows a leading sign only on income. */
      type: "transactions_list";
      title: string;
      /** Optional period subtitle ("This month", "Search: starbucks", etc). */
      period_label?: string;
      /** Total rows in the result set; may exceed `rows.length` if the
       *  card is capped. Used by the footer for "Showing N of M". */
      total_count: number;
      /** Optional summed amount across the result set. Server-computed so
       *  the LLM doesn't redo the math. */
      total_amount?: string;
      /** ISO 4217 — defaults to CAD. */
      currency?: string;
      rows: Array<{
        /** Transaction id (for future tap-to-detail navigation). */
        id: string;
        /** Pre-formatted date label — server picks "Today" / "Yesterday"
         *  / "Mon May 5" / "May 5, 2026" based on recency. */
        date_label: string;
        /** Display merchant name (raw text from Plaid, NOT the
         *  normalized key). */
        merchant: string;
        /** Signed amount string ("12.34" or "-87.43"). */
        amount: string;
        /** Optional category chip — color/icon mirror the Category DTO. */
        category?: {
          name: string;
          color?: string | null;
          icon?: string | null;
        };
        /** Optional account name (small text on the right column). */
        account?: string;
        /** When true, the row should render a "needs review" indicator. */
        needs_review?: boolean;
      }>;
      /** Optional footer ("Showing 8 of 47", "All categorized", etc). */
      footer?: string;
    }
  | {
      /** Read-only recurring expenses list. Used by listRecurring (and
       *  later detectRecurringMerchants for proposed ones).
       *
       *  Amounts are plain decimal strings (positive, no sign — recurring
       *  is always an expense by definition). Cadence is the same enum
       *  surfaced elsewhere; the renderer maps it to "monthly" / "weekly"
       *  / etc. for the row line. nextOccurrence is YYYY-MM-DD in the
       *  workspace's timezone. */
      type: "recurring_list";
      title: string;
      period_label?: string;
      /** Total rows in the result set; may exceed `rows.length` if capped. */
      total_count: number;
      /** Optional summed monthly-equivalent across the result set so the
       *  card can show "$134.50 / mo" — computed server-side. */
      total_monthly_amount?: string;
      currency?: string;
      rows: Array<{
        id: string;
        name: string;
        amount: string;
        cadence: Cadence;
        /** YYYY-MM-DD in the workspace's timezone. */
        next_occurrence_date: string;
        category?: {
          name: string;
          color?: string | null;
          icon?: string | null;
        };
      }>;
      footer?: string;
    }
  | {
      /** Inline form for adding a recurring expense. Server emits this
       *  (via presentRecurringForm) when the user's request is ambiguous
       *  on amount / cadence / date but clearly recurring in intent —
       *  rather than the LLM asking each field in turn, the mobile
       *  renders editable inputs and the user fills + submits.
       *
       *  Submission flow: mobile POSTs the field values to
       *  /workspaces/:wsId/intents/:intent_id/consume with the form
       *  values as overrides. Server merges over the intent's stored
       *  defaults and runs addRecurring. */
      type: "recurring_form_card";
      /** Question shown above the inputs (LLM-authored, language
       *  mirrors the user). */
      question: string;
      /** Action intent id created server-side; submission sends to
       *  /intents/:id/consume. */
      intent_id: string;
      /** Pre-filled defaults the LLM inferred from the user's message
       *  (name almost always present; amount/cadence/date optional). */
      defaults: {
        name: string;
        amount?: string;
        cadence?: Cadence;
        /** YYYY-MM-DD in the user's tz. */
        next_occurrence_date?: string;
        category_name?: string;
      };
      /** Currency for the amount input — defaults to "CAD" on render
       *  if omitted. */
      currency?: string;
      /** "add" when no existing recurring matches the name (fresh
       *  insert), "update" when the form pre-filled from an existing
       *  row. Drives the submit button copy ("Add" vs "Update") and
       *  the post-submit confirmation message. Optional for backward
       *  compatibility — older clients fall back to "add". */
      mode?: "add" | "update";
    }
  | {
      /** Read-only budgets card. Used by getBudget. Each row pairs a
       *  category's configured budget `amount` with the period `spent`
       *  and a `bar_pct` (spent/amount*100, may exceed 100). `over` is
       *  true when spent > amount. Amounts are decimal strings without a
       *  currency symbol; the renderer formats with `currency`. */
      type: "budget_list";
      title: string;
      period_label?: string;
      currency?: string;
      /** Optional total-cap headline (BudgetPlan). Present only when the
       *  plan has a positive total cap, so `bar_pct` (= spent/cap*100) is
       *  always well-defined. Amounts are decimal strings formatted in the
       *  block's `currency`. `left` = cap − spent, server-computed for
       *  direct display. */
      headline?: {
        cap: string;
        spent: string;
        /** = cap − spent. */
        left: string;
        bar_pct: number;
        scheduled?: string;
      };
      rows: Array<{
        id: string;
        category: { name: string; color?: string | null; icon?: string | null };
        amount: string;
        spent: string;
        /** spent/amount*100, clamped 0..100+ by the producer; renderer clamps the bar. */
        bar_pct: number;
        over?: boolean;
      }>;
      footer?: string;
    }
  | {
      /** Read-only bank accounts card. Used by listAccounts. `status`
       *  is the Plaid connection status (null for manual/CSV accounts).
       *  `total_balance` is present ONLY when every row shares one
       *  currency. */
      type: "accounts_list";
      title: string;
      total_balance?: string;
      currency?: string;
      rows: Array<{
        id: string;
        name: string;
        balance?: string | null;
        institution?: string | null;
        status?: PlaidItemStatus | null;
      }>;
      footer?: string;
    }
  | {
      /** Read-only scheduled-spend card. Shared by listScheduledSpends
       *  and listUnresolvedSchedules. `name` is the schedule's note if
       *  present, else its category name. `dismiss_intent` is present
       *  ONLY on unresolved rows — tapping Dismiss consumes that intent
       *  (runs dismissScheduledSpend). */
      type: "scheduled_list";
      title: string;
      period_label?: string;
      total_count: number;
      currency?: string;
      rows: Array<{
        id: string;
        name: string;
        amount: string;
        /** YYYY-MM-DD. */
        scheduled_date: string;
        status: ScheduledSpendStatus;
        category?: { name: string; color?: string | null; icon?: string | null };
        dismiss_intent?: string;
      }>;
      footer?: string;
    }
  | {
      /** Detected recurring-merchant candidates. Used by
       *  detectRecurringMerchants. Each row's "Add" opens a prefilled
       *  recurring form bound to `add_form_intent` (a server-created
       *  addRecurring intent). Irregular-cadence candidates are excluded
       *  by the producer, so `cadence` is always a valid Cadence. */
      type: "recurring_candidates";
      title: string;
      currency?: string;
      rows: Array<{
        merchant: string;
        amount: string;
        cadence: Cadence;
        occurrences: number;
        add_form_intent: string;
        defaults: {
          name: string;
          amount?: string;
          cadence?: Cadence;
          /** YYYY-MM-DD, derived server-side as lastSeen + one cadence interval. */
          next_occurrence_date?: string;
        };
      }>;
      footer?: string;
    }
  | {
      /** Single-transaction detail card. Used by getTransactionDetails.
       *  `amount` is a signed decimal string. `allocations` each carry a
       *  full category chip. */
      type: "transaction_detail";
      id: string;
      merchant: string;
      amount: string;
      currency?: string;
      date_label: string;
      account?: string;
      category?: { name: string; color?: string | null; icon?: string | null };
      note?: string | null;
      pending?: boolean;
      /** Where the transaction came from — drives a "via Plaid / Manual" row. */
      source?: "plaid" | "manual" | "csv";
      allocations?: Array<{
        category: { name: string; color?: string | null; icon?: string | null };
        amount: string;
      }>;
    }
  | {
      /** Read-only category chips. Used by listCategories. */
      type: "category_list";
      title: string;
      rows: Array<{ id: string; name: string; color?: string | null; icon?: string | null }>;
      footer?: string;
    }
  | {
      /** Read-only goals card. Used by listGoals. Each row pairs a goal's
       *  COMPUTED `saved` with its `target` and a `bar_pct`
       *  (saved/target*100, may exceed 100). `over` is true when
       *  saved > target. `due_label` is a D-day string ("D-42", "D-DAY",
       *  "D+3" when overdue). Amounts are decimal strings without a
       *  currency symbol; the renderer formats with `currency`. */
      type: "goals_list";
      title: string;
      currency?: string;
      rows: Array<{
        id: string;
        title: string;
        saved: string;
        target: string;
        bar_pct: number;
        over?: boolean;
        due_label: string;
        icon?: string | null;
        color?: string | null;
      }>;
      footer?: string;
    }
  | {
      /** Single-goal detail card. Used by getGoalDetails. `note` is a
       *  TOOL-TEMPLATED constant explaining savings accrue automatically
       *  from staying under budget in the listed categories (NOT from
       *  data). `strategy_note` carries Goal.strategy.notice ONLY (set
       *  only when the LLM strategy generation failed; usually absent) —
       *  do not expect a positive plan sentence here. `allocations` are
       *  the per-category cuts from the saved plan. */
      type: "goal_detail";
      id: string;
      title: string;
      saved: string;
      target: string;
      bar_pct: number;
      over?: boolean;
      currency?: string;
      due_label: string;
      /** Whole days until the due date; negative when overdue. */
      days_left?: number;
      note?: string;
      allocations?: Array<{
        category: { name: string; color?: string | null; icon?: string | null };
        monthly: string;
        rationale?: string;
      }>;
      strategy_note?: string;
    }
  | {
      /** Goal add/update form. Used by presentGoalForm. Mirrors
       *  recurring_form_card. `target_amount` is a decimal STRING for
       *  display; the stored intent arg is the NUMBER
       *  parseFloat(target_amount). `due_date` default is always
       *  >= minDueDateOneMonthUTC(). */
      type: "goal_form_card";
      question: string;
      intent_id: string;
      defaults: {
        title?: string;
        target_amount?: string;
        /** YYYY-MM-DD. */
        due_date?: string;
      };
      currency?: string;
      mode?: "add" | "update";
    };
