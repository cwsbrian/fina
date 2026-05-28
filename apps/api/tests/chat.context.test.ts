import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildFinancialContext } from "../src/chat/context.js";

describe("buildFinancialContext", () => {
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    userId = `fc-${Date.now()}`;
    const u = await prisma.user.create({ data: { id: userId, email: `${userId}@t.co`, name: "FC" } });
    const ws = await prisma.workspace.create({ data: { name: "fc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("renders empty state when workspace has no transactions or categories", async () => {
    const ctx = await buildFinancialContext(wsId, userId);
    expect(ctx).toContain("Total transactions: 0");
    expect(ctx).toContain("No transactions yet");
    expect(ctx).toContain("Categories defined: 0");
  });

  it("renders counts + latest tx date when populated", async () => {
    await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: "t", amount: "5.00", merchantRaw: "M", occurredAt: new Date("2026-04-30T00:00:00Z"), rawData: {} },
    });
    const ctx = await buildFinancialContext(wsId, userId);
    expect(ctx).toContain("Total transactions: 1");
    expect(ctx).toContain("Latest transaction date: 2026-04-30");
    expect(ctx).toContain("Categories defined: 1");
  });

  it("includes today's date + timezone for the LLM date anchor", async () => {
    const ctx = await buildFinancialContext(wsId, userId);
    // Format is "- Today: YYYY-MM-DD (timezone <tz>)". Asserting on the
    // shape rather than the literal date keeps the test deterministic.
    expect(ctx).toMatch(/- Today: \d{4}-\d{2}-\d{2} \(timezone [^)]+\)/);
  });
});
