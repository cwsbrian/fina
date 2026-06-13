import { describe, expect, it } from "vitest";
import type { AdminUserDTO, AdminUsersResponse } from "@fina/shared";
import {
  adminErrorState,
  formatAdminDate,
  formatAdminSubscription,
  mergeAdminUsersPage,
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

  it("merges additional pages without dropping prior rows", () => {
    const first: AdminUsersResponse = { users: [row], nextCursor: "cursor-1" };
    const second: AdminUsersResponse = {
      users: [{ ...row, id: "user-2", email: "second@example.com" }],
      nextCursor: null,
    };

    expect(mergeAdminUsersPage(null, first, false)).toEqual(first);
    expect(mergeAdminUsersPage(first, second, true)).toEqual({
      users: [row, { ...row, id: "user-2", email: "second@example.com" }],
      nextCursor: null,
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
