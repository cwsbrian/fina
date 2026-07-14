import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { getCashflowSummary } from "../src/chat/tools/get-cashflow-summary.js";
import type { ToolContext } from "../src/chat/tools/types.js";

// All fixtures and query ranges below assume May 2026 — pin the system
// clock so the test is independent of the real calendar date.
const FIXED_NOW = new Date("2026-05-15T12:00:00Z");

describe("getCashflowSummary tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acct1Id: string;
  let acct2Id: string;

  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cf-${Math.floor(Math.random() * 1e12)}`, email: `cf-${Math.floor(Math.random() * 1e12)}@t.co`, name: "CF" } });
    const ws = await prisma.workspace.create({ data: { name: "cf-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
    const a1 = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    const a2 = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Savings", type: "depository" } });
    acct1Id = a1.id;
    acct2Id = a2.id;

    const d1 = new Date("2026-05-03T12:00:00Z");
    const d2 = new Date("2026-05-07T12:00:00Z");
    await prisma.transaction.createMany({
      data: [
        { workspaceId: wsId, accountId: a1.id, plaidTransactionId: "in-1", amount: "-1000.00", merchantRaw: "Payroll", occurredAt: d1, rawData: {}, budgetImpact: "income" },
        { workspaceId: wsId, accountId: a1.id, plaidTransactionId: "ex-1", amount: "150.00", merchantRaw: "Rent", occurredAt: d1, rawData: {} },
        { workspaceId: wsId, accountId: a1.id, plaidTransactionId: "refund-1", amount: "-30.00", merchantRaw: "Rent refund", occurredAt: d2, rawData: {}, budgetImpact: "refund" },
        { workspaceId: wsId, accountId: a2.id, plaidTransactionId: "ex-2", amount: "50.00", merchantRaw: "Subway", occurredAt: d2, rawData: {} },
        { workspaceId: wsId, accountId: a1.id, plaidTransactionId: "ex-3", amount: "20.00", merchantRaw: "X", occurredAt: d2, rawData: {} },
        { workspaceId: wsId, accountId: a1.id, plaidTransactionId: "transfer-1", amount: "-500.00", merchantRaw: "Transfer from savings", occurredAt: d2, rawData: {}, budgetImpact: "excluded" },
      ],
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("computes income, expense, and net totals", async () => {
    const res = await getCashflowSummary.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    expect(res.incomeTotal).toBe("1000.00");
    expect(res.expenseTotal).toBe("190.00");
    expect(res.netTotal).toBe("810.00");
  });

  it("groups by day with YYYY-MM-DD keys when group_by=day (default)", async () => {
    const res = await getCashflowSummary.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    expect(res.groupBy).toBe("day");
    expect(res.groups.length).toBeGreaterThan(0);
    expect(res.groups[0].key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("groups by account", async () => {
    const res = await getCashflowSummary.run(ctx, { since: "2026-05-01", until: "2026-06-01", group_by: "account" });
    const chequing = res.groups.find((g) => g.key === acct1Id);
    const savings = res.groups.find((g) => g.key === acct2Id);
    expect(chequing?.label).toBe("Chequing");
    expect(chequing?.incomeTotal).toBe("1000.00");
    expect(chequing?.expenseTotal).toBe("140.00");
    expect(savings?.expenseTotal).toBe("50.00");
  });

  it("day labels use the user's timezone, not UTC", async () => {
    const { dateKeyInTz } = await import("../src/chat/tools/periods.js");
    // Mid-current-month 03:00 UTC = previous day late evening in Toronto.
    const now = new Date();
    const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 3, 0, 0));
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct1Id,
        plaidTransactionId: `tz-${Date.now()}`,
        amount: "1.00",
        merchantRaw: "Tz",
        occurredAt: utc,
        rawData: {},
      },
    });
    const expectedKey = dateKeyInTz(utc, "America/Toronto");
    const utcKey = utc.toISOString().slice(0, 10);
    expect(expectedKey).not.toBe(utcKey); // sanity: the bug would have produced utcKey
    const res = await getCashflowSummary.run(ctx, { since: "2026-05-01", until: "2026-06-01" });
    expect(res.groups.some((g) => g.key === expectedKey)).toBe(true);
  });

  it("returns zero totals when workspace has no CAD activity", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const u2 = await prisma.user.create({ data: { id: `cf2-${Date.now()}`, email: `cf2-${Date.now()}@t.co`, name: "CF2" } });
    await prisma.membership.create({ data: { userId: u2.id, workspaceId: other.id, role: "owner" } });
    const ctx2: ToolContext = { env: {} as never, workspaceId: other.id, userId: u2.id };
    const res = await getCashflowSummary.run(ctx2, { since: "2026-05-01", until: "2026-06-01" });
    expect(res.incomeTotal).toBe("0.00");
    expect(res.expenseTotal).toBe("0.00");
    expect(res.netTotal).toBe("0.00");
    await prisma.workspace.delete({ where: { id: other.id } });
    await prisma.user.delete({ where: { id: u2.id } });
  });
});
