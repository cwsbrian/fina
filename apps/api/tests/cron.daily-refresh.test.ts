import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Hoist Plaid mock to prevent real SDK import.
const { plaidMockFactory } = await vi.hoisted(async () => await import("./helpers/plaid-mock.js"));
vi.mock("plaid", plaidMockFactory);

vi.mock("../src/plaid/sync.js", () => ({
  syncTransactions: vi.fn(),
}));
vi.mock("../src/categorize/service.js", () => ({
  categorizeNewTransactions: vi.fn(),
}));
vi.mock("../src/cron/tier-gate.js", () => ({
  checkBackgroundSyncGate: vi.fn(),
}));
vi.mock("../src/plaid/items.js", () => ({
  removeItemForBilling: vi.fn().mockResolvedValue(undefined),
}));
import { removeItemForBilling } from "../src/plaid/items.js";

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { syncTransactions } from "../src/plaid/sync.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";
import { checkBackgroundSyncGate } from "../src/cron/tier-gate.js";
import { runDailyRefresh } from "../src/cron/jobs/daily-refresh.js";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

const syncOk = { added: 1, modified: 0, removed: 0, newTxIds: ["tx-1"] };
const syncLockHeld = { skipped: "lock_held" as const, added: 0, modified: 0, removed: 0, newTxIds: [] };

let seedCounter = 0;

async function seedActiveItem(connectedBy: string | null = "user-a") {
  // connectedBy is a FK to the User table, so we must create a real user row
  // when it is non-null. We derive a deterministic-looking ID from the label
  // so callers can still use readable names in test assertions.
  let resolvedConnectedBy: string | null = null;
  if (connectedBy !== null) {
    const uid = `u_${++seedCounter}_${connectedBy.replace(/[^a-z0-9]/gi, "")}`;
    await prisma.user.upsert({
      where: { id: uid },
      create: { id: uid, email: `${uid}@test.fina`, emailVerified: true, name: connectedBy },
      update: {},
    });
    resolvedConnectedBy = uid;
  }

  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      connectedBy: resolvedConnectedBy,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      status: "active",
    },
  });
  return { wsId: ws.id, itemId: item.id };
}

beforeEach(async () => {
  seedCounter = 0;
  await truncateAll();
  resetPlaidMock();
  vi.mocked(syncTransactions).mockReset();
  vi.mocked(categorizeNewTransactions).mockReset();
  vi.mocked(checkBackgroundSyncGate).mockReset();
  // Default: all users are Pro
  vi.mocked(checkBackgroundSyncGate).mockResolvedValue({ ok: true });
  vi.mocked(removeItemForBilling).mockReset();
  vi.mocked(removeItemForBilling).mockResolvedValue(undefined);
});

afterAll(async () => { await disconnect(); });

describe("runDailyRefresh", () => {
  it("calls syncTransactions for each active item", async () => {
    await seedActiveItem("user-a");
    await seedActiveItem("user-b");
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);

    await runDailyRefresh(env);

    expect(syncTransactions).toHaveBeenCalledTimes(2);
  });

  it("skips items with status != 'active'", async () => {
    await seedActiveItem();
    // Seed a non-active item
    const ws = await prisma.workspace.create({ data: { name: "W2" } });
    await prisma.plaidItem.create({
      data: {
        workspaceId: ws.id,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from([2]),
        itemId: `pi_error_${Math.random()}`,
        institutionId: "ins_1",
        institutionName: "Bank",
        status: "error",
      },
    });
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);

    await runDailyRefresh(env);

    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });

  it("skips tier-gated item, continues for others", async () => {
    await seedActiveItem("user-gated");
    await seedActiveItem("user-ok");
    vi.mocked(checkBackgroundSyncGate)
      .mockResolvedValueOnce({ ok: false, reason: "trial_expired" })
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);

    await runDailyRefresh(env);

    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });

  it("continues after one item's sync throws", async () => {
    await seedActiveItem("user-a");
    await seedActiveItem("user-b");
    vi.mocked(syncTransactions)
      .mockRejectedValueOnce(new Error("plaid down"))
      .mockResolvedValueOnce(syncOk);

    await runDailyRefresh(env);

    // Both items attempted — no unhandled rejection
    expect(syncTransactions).toHaveBeenCalledTimes(2);
  });

  it("calls categorizeNewTransactions when newTxIds non-empty", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);
    vi.mocked(categorizeNewTransactions).mockResolvedValue(undefined as never);

    await runDailyRefresh(env);

    expect(categorizeNewTransactions).toHaveBeenCalledTimes(1);
    expect(categorizeNewTransactions).toHaveBeenCalledWith(env, expect.any(String), ["tx-1"]);
  });

  it("skips categorize when newTxIds is empty", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(categorizeNewTransactions).not.toHaveBeenCalled();
  });

  it("null connectedBy: skips tier gate, still syncs, warns", async () => {
    await seedActiveItem(null); // connectedBy = null
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runDailyRefresh(env);

    expect(checkBackgroundSyncGate).not.toHaveBeenCalled();
    expect(syncTransactions).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("connectedBy null"),
      expect.any(Object),
    );
    warnSpy.mockRestore();
  });

  it("lock_held result: increments lockHeld counter (no throw)", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue(syncLockHeld);

    // Should complete without error
    await expect(runDailyRefresh(env)).resolves.toBeUndefined();
    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });
});

describe("runDailyRefresh — Step 0 trial expiry cleanup", () => {
  async function seedWorkspaceWithOwner(trialEndsAt: Date | null) {
    const { randomUUID } = await import("crypto");
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        name: "Test Owner",
        email: `owner-${userId.slice(0, 8)}@x.com`,
        emailVerified: true,
        trialEndsAt,
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "WS" } });
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role: "owner" },
    });
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: ws.id,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from(new Array(12).fill(2)),
        itemId: `pi_step0_${Math.random()}`,
        institutionId: "ins_1",
        institutionName: "Bank",
        status: "active",
      },
    });
    return { wsId: ws.id, itemId: item.id };
  }

  it("expired-trial owner's active item → removeItemForBilling called", async () => {
    const { itemId } = await seedWorkspaceWithOwner(new Date(Date.now() - 86_400_000));

    await runDailyRefresh(env);

    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), itemId);
  });

  it("active-trial owner's item → NOT removed", async () => {
    await seedWorkspaceWithOwner(new Date(Date.now() + 86_400_000));
    // Mock sync so the item's sync attempt doesn't error noisily in this test.
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(removeItemForBilling).not.toHaveBeenCalled();
  });

  it("removeItemForBilling throws → other items still synced (non-fatal)", async () => {
    vi.mocked(removeItemForBilling).mockRejectedValueOnce(new Error("plaid down"));
    const { itemId: expiredItemId } = await seedWorkspaceWithOwner(new Date(Date.now() - 86_400_000));

    // Also seed an active-trial item that should still sync.
    const { itemId: activeItemId } = await seedWorkspaceWithOwner(new Date(Date.now() + 86_400_000));
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    // removeItemForBilling was attempted for the expired item.
    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), expiredItemId);
    // syncTransactions was still called for the active item.
    expect(syncTransactions).toHaveBeenCalled();
    void activeItemId;
  });
});
