/** Status surfaced by the API for a Plaid item connection. */
export type PlaidItemStatus = "active" | "error" | "relink_required" | "disconnected";

/** A row in `GET /workspaces/:id/plaid-items`. */
export type PlaidItemDTO = {
  id: string;
  institutionName: string;
  status: PlaidItemStatus;
  errorCode: string | null;
  /** ISO 8601 timestamp; null if never synced. */
  lastSyncAt: string | null;
  accountCount: number;
};
