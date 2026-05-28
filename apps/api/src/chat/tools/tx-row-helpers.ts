import type { PresentationBlock } from "@fina/shared";
import { dateKeyInTz } from "./periods.js";

type RecentLabelCtx = {
  /** Today's date key in the user's tz (YYYY-MM-DD). */
  today: string;
  /** Yesterday's date key in the user's tz. */
  yesterday: string;
};

/** Pre-format a transaction's occurredAt for the transactions_list block.
 *  "Today" / "Yesterday" for the two most recent days; "Mon May 5" for the
 *  current calendar year; "May 5, 2025" for older.
 *
 *  This intentionally runs server-side so the block can ship plain strings
 *  the mobile renderer doesn't have to reformat — keeps the block stable
 *  across i18n / locale changes too (we choose the locale here once). */
export function dateLabelForRow(occurredAt: Date, tz: string, ctx: RecentLabelCtx): string {
  const key = dateKeyInTz(occurredAt, tz);
  if (key === ctx.today) return "Today";
  if (key === ctx.yesterday) return "Yesterday";

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(occurredAt).map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const thisYear = ctx.today.slice(0, 4);
  if (key.slice(0, 4) === thisYear) {
    // Mon May 5
    return `${parts.weekday} ${parts.month} ${parts.day}`;
  }
  // May 5, 2025
  return `${parts.month} ${parts.day}, ${parts.year}`;
}

/** Compute today + yesterday keys in the user's tz once per tool call,
 *  then reuse for every row. */
export function recentLabelContext(now: Date, tz: string): RecentLabelCtx {
  const today = dateKeyInTz(now, tz);
  const yMs = now.getTime() - 24 * 60 * 60 * 1000;
  const yesterday = dateKeyInTz(new Date(yMs), tz);
  return { today, yesterday };
}

/** Hard cap on rows rendered inside the chat card. The tool's raw output
 *  still returns the full list (up to its own limit) so the LLM can quote
 *  numbers or chain another call. */
export const MAX_TX_ROWS_IN_BLOCK = 10;

export type TxRowInput = {
  id: string;
  occurredAt: Date;
  amount: string;
  /** Raw merchant text from Plaid. */
  merchant: string;
  category: { name: string; color?: string | null; icon?: string | null } | null;
  account: string | null;
  needsReview: boolean;
};

export type TxRowBlock = Extract<PresentationBlock, { type: "transactions_list" }>["rows"][number];

/** Convert a raw tx row to the block's row shape, filling the date_label
 *  and pruning unset optional fields per @fina/shared exactOptional rules. */
export function txRowToBlockRow(input: TxRowInput, ctx: RecentLabelCtx, tz: string): TxRowBlock {
  const row: TxRowBlock = {
    id: input.id,
    date_label: dateLabelForRow(input.occurredAt, tz, ctx),
    merchant: input.merchant,
    amount: input.amount,
  };
  if (input.category) row.category = input.category;
  if (input.account) row.account = input.account;
  if (input.needsReview) row.needs_review = true;
  return row;
}
