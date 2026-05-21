/** Allocation row — a transaction's amount is split into one or more
 *  category allocations (Plan 1C-split-transaction). The set always covers
 *  the full tx amount; allocations with `categoryId: null` are uncategorised. */
export type AllocationDTO = {
  id: string;
  categoryId: string | null;
  /** Decimal serialized as a string (e.g. "12.34"). */
  amount: string;
  /** Where the allocation came from. `null` for uncategorised. */
  source: "manual" | "ai" | "mapping" | null;
};

/** A row in `GET /workspaces/:id/transactions`. */
export type TransactionDTO = {
  id: string;
  accountId: string;
  plaidTransactionId: string | null;
  /** Decimal serialized as a string. */
  amount: string;
  /** Workspace currency at fetch time (e.g. "CAD"). */
  currency: string;
  merchantRaw: string;
  merchantNormalized: string | null;
  /** ISO 8601 timestamps. */
  occurredAt: string;
  postedAt: string | null;
  pending: boolean;
  source: "plaid" | "manual";
  note: string | null;
  /** ISO 8601 timestamp; null when not soft-removed. */
  removedAt: string | null;
  needsReclassification: boolean;
  allocations: AllocationDTO[];
};

export type CategoryDTO = {
  id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  color: string | null;
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
};
