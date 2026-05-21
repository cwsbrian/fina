/** A row in `GET /workspaces/:id/accounts`. */
export type BankAccountDTO = {
  id: string;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  status: "active" | "archived";
  /** Decimal serialized as a string; null for accounts without that balance type. */
  balanceCurrent: string | null;
  balanceAvailable: string | null;
  balanceLimit: string | null;
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
};
