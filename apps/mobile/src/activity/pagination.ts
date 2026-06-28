import type { TransactionDTO } from "@fina/shared";
import { isExpenseAmount } from "../format/money";

export const ACTIVITY_PAGE_LIMIT = 100;

export type ActivityRange = {
  from?: string;
  to?: string;
};

export function buildActivityTransactionsPath({
  workspaceId,
  limit = ACTIVITY_PAGE_LIMIT,
  cursor,
  query,
  range = {},
}: {
  workspaceId: string;
  limit?: number;
  cursor?: string | null;
  query?: string;
  range?: ActivityRange;
}): string {
  const params = new URLSearchParams({ limit: String(limit) });
  const trimmed = query?.trim();
  if (trimmed) params.set("q", trimmed);
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (cursor) params.set("cursor", cursor);
  return `/workspaces/${workspaceId}/transactions?${params.toString()}`;
}

export function mergeActivityTransactionPages(
  current: TransactionDTO[],
  incoming: TransactionDTO[],
): TransactionDTO[] {
  const seen = new Set(current.map((tx) => tx.id));
  const next = [...current];
  for (const tx of incoming) {
    if (seen.has(tx.id) || !isExpenseAmount(tx.amount)) continue;
    seen.add(tx.id);
    next.push(tx);
  }
  return next;
}
