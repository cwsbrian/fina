import { describe, expect, it } from "vitest";

import {
  formatPlaidItemRows,
  loadPlaidItemListConfig,
} from "../src/scripts/list-production-plaid-items.js";

describe("list-production-plaid-items guards", () => {
  const validEnv = {
    NODE_ENV: "production",
    PLAID_ENV: "production",
  };

  it("requires production runtime and Plaid production", () => {
    expect(() => loadPlaidItemListConfig({ ...validEnv, NODE_ENV: "development" })).toThrow(/NODE_ENV/);
    expect(() => loadPlaidItemListConfig({ ...validEnv, PLAID_ENV: "sandbox" })).toThrow(/PLAID_ENV/);
  });

  it("defaults to table output and accepts json output", () => {
    expect(loadPlaidItemListConfig(validEnv)).toEqual({ format: "table" });
    expect(loadPlaidItemListConfig({ ...validEnv, PLAID_LIST_FORMAT: "json" })).toEqual({ format: "json" });
  });
});

describe("formatPlaidItemRows", () => {
  it("formats Plaid item rows for operational output", () => {
    const rows = formatPlaidItemRows([
      {
        id: "item-row-1",
        itemId: "item_prod_123",
        institutionId: "ins_56",
        institutionName: "Test Bank",
        status: "active",
        errorCode: null,
        webhookUrl: "https://api.withfina.com/plaid/webhook",
        connectedBy: "user-1",
        createdAt: new Date("2026-06-01T10:00:00.000Z"),
        updatedAt: new Date("2026-06-02T10:00:00.000Z"),
        lastSyncAt: new Date("2026-06-03T10:00:00.000Z"),
        workspace: { id: "workspace-1", name: "Tester Workspace" },
        user: { email: "tester@test.com" },
        _count: { bankAccounts: 2, transactions: 42, webhookEvents: 3 },
      },
    ]);

    expect(rows).toEqual([
      {
        id: "item-row-1",
        itemId: "item_prod_123",
        institution: "Test Bank",
        institutionId: "ins_56",
        status: "active",
        errorCode: "",
        webhookUrl: "https://api.withfina.com/plaid/webhook",
        workspaceId: "workspace-1",
        workspace: "Tester Workspace",
        connectedBy: "tester@test.com",
        connectedByUserId: "user-1",
        bankAccounts: 2,
        transactions: 42,
        webhookEvents: 3,
        lastSyncAt: "2026-06-03T10:00:00.000Z",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
    ]);
  });
});
