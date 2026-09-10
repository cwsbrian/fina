/** Allocation row — a transaction's amount is split into one or more
 *  category allocations (Plan 1C-split-transaction). The set always covers
 *  the full tx amount; allocations with `categoryId: null` are uncategorised. */
export type AllocationDTO = {
  id: string;
  categoryId: string | null;
  /** Decimal serialized as a string (e.g. "12.34"). */
  amount: string;
  /** Where the allocation came from. `null` for uncategorised. */
  source: "manual" | "ai" | "mapping" | "history" | null;
  /** True when the allocation is awaiting user confirmation. */
  needsConfirmation: boolean;
  /** ISO 8601 timestamp. When in the future, this allocation is snoozed
   *  (hidden from Activity pill and Daily Brief confirm card). */
  dismissedUntil: string | null;
  /** Non-negative portion used for business. null means not reviewed. */
  businessAmount: string | null;
  receiptLineItemId: string | null;
};

/** A row in `GET /workspaces/:id/transactions`. */
export type TransactionDTO = {
  id: string;
  version: number;
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
  budgetImpact: "expense" | "income" | "refund" | "excluded";
  budgetImpactSource: "auto" | "user";
  /** True while future transactions from this merchant are also excluded. */
  merchantExclusionActive?: boolean;
  /** Original expense linked to this refund, when confidently matched. */
  refundOfTransactionId: string | null;
  classificationSourceReceiptId: string | null;
  businessPurpose: string | null;
  receiptMissingReason: string | null;
  receiptMissingNote: string | null;
  /** Posted refunds matched to this expense. Raw transaction amount is unchanged. */
  refundedAmount: string;
  allocations: AllocationDTO[];
};

export type CategoryDTO = {
  id: string;
  name: string;
  /** "expense" | "income" — drives picker filtering by transaction direction. */
  type: "expense" | "income";
  parentId: string | null;
  icon: string | null;
  color: string | null;
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
};
