import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildBriefContext } from "../src/chat/brief-context.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnect();
});

// Mirror chat.brief-context.test.ts clock handling: real clock, firstOfMonth at noon UTC.
function thisMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return { y, m, firstOfMonth: new Date(Date.UTC(y, m - 1, 1, 12, 0, 0)) };
}

describe("buildBriefContext forecast", () => {
  it("at_risk portfolio + topRisks via the spent path (day-independent)", async () => {
    const { firstOfMonth } = thisMonth();
    const u = await prisma.user.create({
      data: { id: `fc-${Date.now()}`, email: `fc-${Date.now()}@t.co`, name: "FC", tz: "UTC" },
    });
    const ws = await prisma.workspace.create({ data: { name: "W", currency: "CAD" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    const dining = await prisma.category.create({ data: { workspaceId: ws.id, name: "Dining" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: ws.id, name: "Chq", type: "depository", currency: "CAD" } });
    // total cap 1000, Dining cap 500; 1300 spent on Dining → 1300 > 1.1*1000 → portfolio at_risk
    await prisma.budgetPlan.create({
      data: { workspaceId: ws.id, periodStart: firstOfMonth, totalAmount: "1000.00", categoryAllocations: [{ categoryId: dining.id, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: ws.id, accountId: acct.id, amount: "1300.00", merchantRaw: "Resto", occurredAt: firstOfMonth, source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining.id, amount: "1300.00" } });

    const ctx = await buildBriefContext(u.id, "daily");
    const w = ctx.workspaces[0]!;
    expect(w.forecast.portfolio).not.toBeNull();
    expect(w.forecast.portfolio!.severity).toBe("at_risk");
    expect(w.forecast.topRisks.map((r) => r.category)).toContain("Dining");
    // Invariant: portfolio===null iff budgetTotal===null (positive-cap case → both non-null)
    expect(w.forecast.portfolio === null).toBe(w.budgetTotal === null);
  });

  it("zero total cap → forecast.portfolio null AND budgetTotal null (invariant)", async () => {
    const { firstOfMonth } = thisMonth();
    const u = await prisma.user.create({
      data: { id: `fc0-${Date.now()}`, email: `fc0-${Date.now()}@t.co`, name: "FC0", tz: "UTC" },
    });
    const ws = await prisma.workspace.create({ data: { name: "W0", currency: "CAD" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await prisma.budgetPlan.create({
      data: { workspaceId: ws.id, periodStart: firstOfMonth, totalAmount: "0.00", categoryAllocations: [] },
    });

    const ctx = await buildBriefContext(u.id, "daily");
    const w = ctx.workspaces[0]!;
    expect(w.forecast.portfolio).toBeNull();
    expect(w.budgetTotal).toBeNull();
  });
});
