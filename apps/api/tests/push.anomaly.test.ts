import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

const env = testEnv();

// Partial mock: replace sendLargeChargePush with vi.fn(), keep other
// exports as-is. afterEach uses vi.clearAllMocks (NOT restoreAllMocks —
// would restore the real Expo SDK call path and break subsequent tests).
vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendLargeChargePush: vi.fn().mockResolvedValue(undefined),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

// ---------- helpers ----------

let userCounter = 0;
let workspaceCounter = 0;

async function createUserMinimal(): Promise<string> {
  userCounter++;
  const id = `u-anom-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: { id, email: `${id}@t.co`, name: `Anom User ${userCounter}` },
  });
  return id;
}

async function setupWorkspaceWithMembers(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{
  wsId: string;
  members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }>;
}> {
  workspaceCounter++;
  const ws = await prisma.workspace.create({
    data: {
      id: `w-anom-${Date.now()}-${workspaceCounter}`,
      name: `Anom WS ${workspaceCounter}`,
      currency: "CAD",
    },
  });
  const members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }> = [];
  for (const role of roles) {
    const userId = await createUserMinimal();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    members.push({ userId, role });
  }
  return { wsId: ws.id, members };
}

async function seedCategory(wsId: string, name: string): Promise<string> {
  const cat = await prisma.category.create({
    data: { workspaceId: wsId, name },
  });
  return cat.id;
}

async function seedAccount(wsId: string): Promise<string> {
  const a = await prisma.bankAccount.create({
    data: {
      workspaceId: wsId,
      plaidItemId: null,
      plaidAccountId: null,
      name: "Test",
      type: "depository",
      currency: "CAD",
      status: "active",
    },
  });
  return a.id;
}

/** Seeds a Transaction (+ optional TransactionAllocation when categoryId
 *  is non-null). Transaction has no currency field (workspace+account
 *  carry it). rawData is required Json with no default — pass empty. */
async function seedTransactionWithCategory(opts: {
  wsId: string;
  accountId: string;
  categoryId: string | null;
  amount: number;
  merchant?: string | null;
  occurredAt?: Date;
}): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: opts.wsId,
      accountId: opts.accountId,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: opts.merchant ?? "Test Merchant",
      merchantNormalized: (opts.merchant ?? "test merchant").toLowerCase(),
      occurredAt: opts.occurredAt ?? new Date(),
      pending: false,
      source: "manual",
      rawData: {},
    },
  });
  if (opts.categoryId !== null) {
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId: opts.categoryId,
        amount: new Prisma.Decimal(opts.amount),
        source: "manual",
      },
    });
  }
  return tx.id;
}

describe("checkLargeChargeAndPush", () => {
  it("amount < MIN_AMOUNT ($30) → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 25, merchant: "Coffee",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 25, merchant: "Coffee",
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });

  it("uncategorized transaction (no allocation row) → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId: null, amount: 200, merchant: "Anything",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Anything",
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });

  it("cold-start (no 90d history) + amount < $150 → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 100,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 100, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });

  it("cold-start + amount ≥ $150 → 1 push to owner", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Best Buy",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toBe(members[0]!.userId);
  });

  it("with history, amount < avg × 2.5 → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    // 5 prior transactions at $50 each, 30 days ago (well within 90d window).
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 50,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    // avg = $50. new tx $80. 80 < 50 × 2.5 = 125 → not unusual.
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 80,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 80, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });

  it("with history, amount ≥ avg × 2.5 BUT < MIN_AMOUNT × 2 → no push (extra guard)", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Coffee");
    // 5 prior transactions at $5 each (avg $5). new tx $40.
    // 40 ≥ 5 × 2.5 = 12.5 BUT 40 < 30 × 2 = 60 → not unusual.
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 5,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 40,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 40, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });

  it("with history, both conditions met → 1 push + verify all 5 args forwarded", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    // avg = $40, new tx $200. 200 ≥ 40 × 2.5 = 100 AND 200 ≥ 60 → unusual.
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 40,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200, merchant: "Starbucks",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Starbucks",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      env,                    // 1st arg: env carrier
      members[0]!.userId,     // 2nd: owner userId
      "Starbucks",            // 3rd: merchant (passed-through)
      "200.00",               // 4th: amount.toFixed(2)
      "Food",                 // 5th: categoryName
    ]);
  });

  it("fan-out: workspace with owner+editor+viewer, unusual tx → 2 pushes (viewer excluded)", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner", "editor", "viewer"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200,  // cold-start unusual
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Best Buy",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(2);
    const calledUserIds = calls.map((c) => c[1]).sort();
    const expectedUserIds = members
      .filter((m) => m.role === "owner" || m.role === "editor")
      .map((m) => m.userId)
      .sort();
    expect(calledUserIds).toEqual(expectedUserIds);
  });
});
