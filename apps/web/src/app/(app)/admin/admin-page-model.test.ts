import { describe, expect, it } from "vitest";
import type { AdminUserDTO, AdminUsersResponse } from "@fina/shared";
import {
  adminErrorState,
  formatAdminDevices,
  formatAdminDate,
  formatAdminSubscription,
  formatCad,
  mergeAdminUsersPage,
  usageSignal,
} from "./admin-page-model";

const row: AdminUserDTO = {
  id: "user-1",
  email: "paid@example.com",
  name: "Paid User",
  createdAt: "2026-06-12T00:00:00.000Z",
  role: "user",
  tier: "pro",
  trial: { active: false, endsAt: null },
  subscription: {
    tier: "pro",
    status: "active",
    currentPeriodEnd: "2026-07-12T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    source: "stripe",
    pendingTier: "max",
    pendingTierAt: "2026-07-12T00:00:00.000Z",
    environment: "Production",
  },
  deviceSummary: [],
  activeSubscriptionCount: 1,
  isPlanMismatch: false,
};

describe("admin page model", () => {
  it("formats subscription state without provider identifiers", () => {
    expect(formatAdminSubscription(row)).toContain("Web pro active");
    expect(formatAdminSubscription(row)).toContain("pending max");
    expect(formatAdminSubscription({ ...row, subscription: null })).toBe("No active subscription");
  });

  it("formats null dates as None", () => {
    expect(formatAdminDate(null)).toBe("None");
  });

  it("formats device and usage summaries", () => {
    expect(formatAdminDevices({ ...row, deviceSummary: [{ platform: "ios", lastSeenAt: null }] })).toBe("ios");
    expect(formatCad("0.123456")).toBe("$0.1235 CAD");
    expect(usageSignal({
      user: row,
      devices: [],
      sessions: [],
      plaidItems: [{ id: "p1", institutionName: "Bank", status: "active", errorCode: null, lastSyncAt: null, createdAt: row.createdAt, accounts: [] }],
      activity: {
        lastSeenAt: row.createdAt,
        transactionCount: 2,
        lastTransactionAt: row.createdAt,
        chatThreadCount: 1,
        chatMessageCount: 3,
        lastChatAt: row.createdAt,
      },
      aiUsage: { total: { callCount: 1, inputTokens: 10, outputTokens: 5, costCad: "0.010000" }, monthly: [] },
    })).toBe("1/1 Plaid active, 2 tx, 3 chat msgs");
  });

  it("merges additional pages without dropping prior rows", () => {
    const first: AdminUsersResponse = {
      users: [row],
      nextCursor: "cursor-1",
      summary: { userCount: 1, proUserCount: 1, maxUserCount: 0, activeTrialCount: 0 },
    };
    const second: AdminUsersResponse = {
      users: [{ ...row, id: "user-2", email: "second@example.com" }],
      nextCursor: null,
      summary: { userCount: 2, proUserCount: 2, maxUserCount: 0, activeTrialCount: 0 },
    };

    expect(mergeAdminUsersPage(null, first, false)).toEqual(first);
    expect(mergeAdminUsersPage(first, second, true)).toEqual({
      users: [row, { ...row, id: "user-2", email: "second@example.com" }],
      nextCursor: null,
      summary: second.summary,
    });
  });

  it("clears cached admin data on forbidden errors", () => {
    expect(adminErrorState({ status: 403, code: "admin_required" })).toEqual({
      data: null,
      cursor: null,
      err: "forbidden",
    });
  });
});
