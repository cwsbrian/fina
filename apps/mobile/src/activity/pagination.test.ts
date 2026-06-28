import { describe, expect, it } from "vitest";
import type { TransactionDTO } from "@fina/shared";

import {
  buildActivityTransactionsPath,
  mergeActivityTransactionPages,
} from "./pagination";

function tx(id: string, amount: string): TransactionDTO {
  return {
    id,
    accountId: `acct-${id}`,
    plaidTransactionId: null,
    amount,
    currency: "CAD",
    merchantRaw: `Merchant ${id}`,
    merchantNormalized: null,
    occurredAt: "2026-06-01T12:00:00.000Z",
    postedAt: null,
    pending: false,
    source: "manual",
    note: null,
    removedAt: null,
    needsReclassification: false,
    budgetImpact: "expense",
    budgetImpactSource: "auto",
    allocations: [],
  };
}

describe("activity pagination", () => {
  it("builds the next-page transactions path with the current filters", () => {
    expect(
      buildActivityTransactionsPath({
        workspaceId: "ws_123",
        limit: 100,
        cursor: "cursor+value",
        query: "coffee",
        range: {
          from: "2026-06-01T00:00:00.000Z",
          to: "2026-06-30T23:59:59.999Z",
        },
      }),
    ).toBe(
      "/workspaces/ws_123/transactions?limit=100&q=coffee&from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T23%3A59%3A59.999Z&cursor=cursor%2Bvalue",
    );
  });

  it("appends expense transactions from later pages without duplicating rows", () => {
    expect(
      mergeActivityTransactionPages(
        [tx("a", "12.00"), tx("b", "3.50")],
        [tx("b", "3.50"), tx("c", "-25.00"), tx("d", "8.25")],
      ).map((row) => row.id),
    ).toEqual(["a", "b", "d"]);
  });
});
