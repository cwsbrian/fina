import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/db.js";
import { getAnalysis, getLatestAnalysis } from "../src/analysis/service.js";
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
}: {
  wsId: string;
  accountId: string;
  categoryId: string;
  amount: string;
  occurredAt: Date;
}) {
  const row = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId,
      amount: new Prisma.Decimal(amount),
      merchantRaw: "Merchant",
      occurredAt,
      source: "manual",
      pending: false,
      rawData: {},
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
});
