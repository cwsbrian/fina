import type { ChatMessageRole } from "../enums.js";

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
    };
