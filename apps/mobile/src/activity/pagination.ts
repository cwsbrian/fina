import type { TransactionDTO } from "@fina/shared";

export const ACTIVITY_PAGE_LIMIT = 100;

export type ActivityRange = {
  from?: string;
  to?: string;
};

export type ActivityCategoryFilter = {
  categoryIds?: string[];
  includeUncategorized?: boolean;
};

export function buildActivityTransactionsPath({
  workspaceId,
  limit = ACTIVITY_PAGE_LIMIT,
  cursor,
  query,
  range = {},
  categoryFilter = {},
}: {
  workspaceId: string;
  limit?: number;
  cursor?: string | null;
  query?: string;
  range?: ActivityRange;
  categoryFilter?: ActivityCategoryFilter;
}): string {
  const params = new URLSearchParams({ limit: String(limit) });
  const trimmed = query?.trim();
  if (trimmed) params.set("q", trimmed);
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  if (categoryFilter.categoryIds?.length) {
    params.set("categoryIds", categoryFilter.categoryIds.join(","));
  }
  if (categoryFilter.includeUncategorized) {
    params.set("uncategorizedOnly", "true");
  }
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
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    next.push(tx);
  }
  return next;
}
