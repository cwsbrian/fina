import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { spentByCategoryForPeriod } from "../src/budgets/service.js";

describe("spentByCategoryForPeriod", () => {
  let wsId: string;
  let userId: string;
  let catId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `sbc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "S", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "sbc-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    acctId = (await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
    })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("sums positive allocations for the category in this_month", async () => {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acctId, amount: "30.00",
        merchantRaw: "Bean", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false, rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: catId, amount: "30.00" },
    });
    const map = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "this_month", [catId]);
    expect(map.get(catId)?.toFixed(2)).toBe("30.00");
  });

  it("returns empty map for empty category list", async () => {
    const map = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "this_month", []);
    expect(map.size).toBe(0);
  });

  it("sums last_month allocations and excludes them from this_month", async () => {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acctId, amount: "42.00",
        merchantRaw: "Bean", occurredAt: new Date("2026-04-10T12:00:00Z"),
        source: "manual", pending: false, rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: catId, amount: "42.00" },
    });
    const lastMonth = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "last_month", [catId]);
    expect(lastMonth.get(catId)?.toFixed(2)).toBe("42.00");
    const thisMonth = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "this_month", [catId]);
    expect(thisMonth.get(catId)).toBeUndefined();
  });

  it("returns empty map for next_month even with current-month spend", async () => {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acctId, amount: "30.00",
        merchantRaw: "Bean", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false, rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: catId, amount: "30.00" },
    });
    const map = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "next_month", [catId]);
    expect(map.size).toBe(0);
  });
});
