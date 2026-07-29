import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/db.js";
import { getAnalysis, getLatestAnalysis } from "../src/analysis/service.js";
import { syncTransactionImpact } from "../src/transactions/refunds.js";
import { disconnect, truncateAll } from "./helpers/db.js";

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await disconnect();
});

beforeEach(async () => {
  await truncateAll();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-02T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

async function seedWorkspace(): Promise<{ wsId: string; accountId: string; categoryId: string }> {
  const ws = await prisma.workspace.create({
    data: { name: `analysis-${Date.now()}`, currency: "CAD" },
  });
  const account = await prisma.bankAccount.create({
    data: {
      workspaceId: ws.id,
      name: "Checking",
      type: "depository",
      currency: "CAD",
      status: "active",
    },
  });
  const category = await prisma.category.create({
    data: { workspaceId: ws.id, name: "Dining" },
  });
  return { wsId: ws.id, accountId: account.id, categoryId: category.id };
}

async function tx({
  wsId,
  accountId,
  categoryId,
  amount,
  occurredAt,
  merchant = "Merchant",
  budgetImpact,
  pending = false,
}: {
  wsId: string;
  accountId: string;
  categoryId: string;
  amount: string;
  occurredAt: Date;
  merchant?: string;
  budgetImpact?: "expense" | "income" | "refund" | "excluded";
  pending?: boolean;
}) {
  const row = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId,
      amount: new Prisma.Decimal(amount),
      merchantRaw: merchant,
      occurredAt,
      source: "manual",
      pending,
      rawData: {},
      budgetImpact: budgetImpact ?? (Number(amount) < 0 ? "income" : "expense"),
    },
  });
  if (Number(amount) > 0) {
    await prisma.transactionAllocation.create({
      data: {
        transactionId: row.id,
        categoryId,
        amount: new Prisma.Decimal(amount),
      },
    });
  }
  return row;
}

describe("analysis service", () => {
  it("getLatestAnalysis uses the most recent transaction month when the current month is empty", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "42.00",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
    });

    const result = await getLatestAnalysis(wsId, 2026, 6);

    expect(result.current.year).toBe(2026);
    expect(result.current.month).toBe(5);
    expect(result.current.spend).toBe(42);
  });

  it("getLatestAnalysis falls back to the requested month when there are no transactions", async () => {
    const { wsId } = await seedWorkspace();

    const result = await getLatestAnalysis(wsId, 2026, 6);

    expect(result.current.year).toBe(2026);
    expect(result.current.month).toBe(6);
    expect(result.current.spend).toBe(0);
  });

  it("getAnalysis uses full UTC calendar-month boundaries", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "10.00",
      occurredAt: new Date("2026-05-01T00:30:00.000Z"),
    });
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "20.00",
      occurredAt: new Date("2026-05-31T23:30:00.000Z"),
    });
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "99.00",
      occurredAt: new Date("2026-06-01T00:30:00.000Z"),
    });

    const result = await getAnalysis(wsId, 2026, 5);

    expect(result.current.spend).toBe(30);
    expect(result.current.spendByCategory).toHaveLength(1);
    expect(result.current.spendByCategory[0]?.amount).toBe(30);
  });

  it("shows real income while excluding transfer income", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-2500.00",
      occurredAt: new Date("2026-05-15T12:00:00.000Z"),
      merchant: "ACME Payroll",
      budgetImpact: "income",
    });
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-500.00",
      occurredAt: new Date("2026-05-16T12:00:00.000Z"),
      merchant: "Transfer from savings",
      budgetImpact: "excluded",
    });

    const result = await getAnalysis(wsId, 2026, 5);

    expect(result.current.income).toBe(2500);
    expect(result.current.spend).toBe(0);
    expect(result.current.net).toBe(2500);
  });

  it("restates a refund against the purchase month instead of income", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    const purchase = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "100.00",
      occurredAt: new Date("2026-05-20T12:00:00.000Z"),
      merchant: "Store",
    });
    const refund = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-40.00",
      occurredAt: new Date("2026-06-01T12:00:00.000Z"),
      merchant: "Store refund",
      budgetImpact: "refund",
    });

    const may = await getAnalysis(wsId, 2026, 5);
    const june = await getAnalysis(wsId, 2026, 6);
    const linked = await prisma.transaction.findUniqueOrThrow({ where: { id: refund.id } });

    expect(linked.refundOfTransactionId).toBe(purchase.id);
    expect(may.current.spend).toBe(60);
    expect(may.current.spendByCategory[0]?.amount).toBe(60);
    expect(june.current.income).toBe(0);
    expect(june.current.spend).toBe(0);
  });

  it("supports multiple refunds without reducing an expense below zero", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "100.00",
      occurredAt: new Date("2026-05-10T12:00:00.000Z"),
      merchant: "Shop",
    });
    for (const [amount, day] of [["-30.00", 12], ["-70.00", 13]] as const) {
      await tx({
        wsId,
        accountId,
        categoryId,
        amount,
        occurredAt: new Date(`2026-05-${day}T12:00:00.000Z`),
        merchant: "Shop refund",
        budgetImpact: "refund",
      });
    }

    const result = await getAnalysis(wsId, 2026, 5);

    expect(result.current.spend).toBe(0);
    expect(result.current.income).toBe(0);
    expect(result.current.spendByCategory).toEqual([]);
  });

  it("does not count an unmatched refund as income", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    const refund = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-25.00",
      occurredAt: new Date("2026-05-15T12:00:00.000Z"),
      merchant: "Unknown refund",
      budgetImpact: "refund",
    });

    const result = await getAnalysis(wsId, 2026, 5);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: refund.id } });

    expect(row.refundOfTransactionId).toBeNull();
    expect(result.current.income).toBe(0);
    expect(result.current.spend).toBe(0);
    expect(result.current.net).toBe(0);
  });

  it("leaves a refund unlinked when two exact purchase candidates are ambiguous", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    for (const day of [10, 11]) {
      await tx({
        wsId,
        accountId,
        categoryId,
        amount: "40.00",
        occurredAt: new Date(`2026-05-${day}T12:00:00.000Z`),
        merchant: "Same Shop",
      });
    }
    const refund = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-40.00",
      occurredAt: new Date("2026-05-15T12:00:00.000Z"),
      merchant: "Same Shop refund",
      budgetImpact: "refund",
    });

    const first = await getAnalysis(wsId, 2026, 5);
    const second = await getAnalysis(wsId, 2026, 5);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: refund.id } });

    expect(row.refundOfTransactionId).toBeNull();
    expect(first.current.spend).toBe(80);
    expect(second.current.spend).toBe(80);
  });

  it("does not link or apply a pending refund", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    await tx({
      wsId,
      accountId,
      categoryId,
      amount: "100.00",
      occurredAt: new Date("2026-05-10T12:00:00.000Z"),
      merchant: "Pending Shop",
    });
    const refund = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-100.00",
      occurredAt: new Date("2026-05-12T12:00:00.000Z"),
      merchant: "Pending Shop refund",
      budgetImpact: "refund",
      pending: true,
    });

    const result = await getAnalysis(wsId, 2026, 5);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: refund.id } });

    expect(row.refundOfTransactionId).toBeNull();
    expect(result.current.spend).toBe(100);
  });

  it("clears a stale refund link when a user override changes its direction", async () => {
    const { wsId, accountId, categoryId } = await seedWorkspace();
    const purchase = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "100.00",
      occurredAt: new Date("2026-05-10T12:00:00.000Z"),
      merchant: "Override Shop",
    });
    const refund = await tx({
      wsId,
      accountId,
      categoryId,
      amount: "-100.00",
      occurredAt: new Date("2026-05-12T12:00:00.000Z"),
      merchant: "Override Shop refund",
      budgetImpact: "refund",
    });
    await prisma.transaction.update({
      where: { id: refund.id },
      data: {
        budgetImpact: "income",
        budgetImpactSource: "user",
        refundOfTransactionId: purchase.id,
      },
    });

    await prisma.$transaction((db) => syncTransactionImpact(db, refund.id));
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: refund.id } });

    expect(row.budgetImpact).toBe("income");
    expect(row.refundOfTransactionId).toBeNull();
  });
});
