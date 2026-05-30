import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { recentDiscretionaryDailyByCategory } from "../src/budget-plans/service.js";

describe("recentDiscretionaryDailyByCategory", () => {
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `disc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function tx(amount: string, day: string, pending = false) {
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount, merchantRaw: "M", occurredAt: new Date(day), source: "manual", pending, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount } });
    return t;
  }

  it("nets refunds and excludes pending in the 90-day discretionary daily rate", async () => {
    await tx("90.00", "2026-04-20T12:00:00Z");      // counts
    await tx("-30.00", "2026-04-21T12:00:00Z");     // refund nets out
    await tx("60.00", "2026-05-01T12:00:00Z", true); // pending excluded
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining)).toBeCloseTo(60 / 90, 4);
  });

  it("subtracts the category's recurring monthly-equivalent (3 months) so fixed bills don't inflate the rate", async () => {
    await tx("100.00", "2026-03-01T12:00:00Z");
    await tx("100.00", "2026-04-01T12:00:00Z");
    await tx("100.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Rent", nameNormalized: "rent", amount: "100.00", categoryId: dining, cadence: "monthly", nextOccurrenceDate: new Date("2026-06-01T12:00:00Z") },
    });
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining) ?? 0).toBeCloseTo(0, 4);
  });

  it("winsorizes a single outlier to 3x the category mean so one big buy doesn't poison 90 days", async () => {
    await tx("10.00", "2026-04-10T12:00:00Z");
    await tx("10.00", "2026-04-12T12:00:00Z");
    await tx("1000.00", "2026-04-15T12:00:00Z");
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    const uncapped = (10 + 10 + 1000) / 90;
    expect(rates.get(dining)!).toBeLessThanOrEqual(uncapped + 1e-9);
  });
});
