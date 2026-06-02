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

const providerMocks = vi.hoisted(() => {
  const stripe = {
    subscriptions: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      retrieve: vi.fn(),
    },
    subscriptionSchedules: {
      retrieve: vi.fn(),
    },
  };
  const appleClient = {
    getSubscriptionStatus: vi.fn(),
  };
  const googleClient = {
    fetchAndNormalize: vi.fn(),
    acknowledgeIfPending: vi.fn().mockResolvedValue(true),
  };
  return {
    stripe,
    appleClient,
    googleClient,
    AppleClient: vi.fn(() => appleClient),
    GoogleClient: vi.fn(() => googleClient),
  };
});

vi.mock("../src/stripe/client.js", () => ({
  stripeClient: () => providerMocks.stripe,
  _clearStripeClientCache: () => {},
}));
vi.mock("../src/iap/apple-client.js", () => ({
  AppleClient: providerMocks.AppleClient,
}));
vi.mock("../src/iap/google-client.js", () => ({
  GoogleClient: providerMocks.GoogleClient,
}));

vi.mock("../src/push/anomaly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/anomaly.js")>();
  return { ...actual, checkLargeChargeAndPush: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/transaction-added.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/transaction-added.js")>();
  return { ...actual, notifyTransactionAdded: vi.fn().mockResolvedValue(undefined) };
});

import * as anomalyMod from "../src/push/anomaly.js";
import * as addedMod from "../src/push/transaction-added.js";
import { Prisma } from "@prisma/client";

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { syncTransactions } from "../src/plaid/sync.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";
import { checkBackgroundSyncGate } from "../src/cron/tier-gate.js";
import { runDailyRefresh } from "../src/cron/jobs/daily-refresh.js";
import { resetPlaidMock } from "./helpers/plaid-mock.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
process.env.APPLE_BUNDLE_ID = "com.fina.app";
process.env.APPLE_ASC_ISSUER_ID = "00000000-0000-0000-0000-000000000000";
process.env.APPLE_ASC_KEY_ID = "K1";
process.env.APPLE_ASC_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";
process.env.APPLE_ENV = "sandbox";
process.env.GOOGLE_PACKAGE_NAME = "app.fina";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "iap@fina.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
});
process.env.GOOGLE_PUBSUB_VERIFY_AUDIENCE = "https://api.fina.app/webhooks/iap/google";
process.env.GOOGLE_PUBSUB_VERIFY_EMAIL = "iap-pubsub@fina.iam.gserviceaccount.com";
process.env.GOOGLE_PUBSUB_SUBSCRIPTION_NAME = "projects/fina/subscriptions/iap-rtdn";

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
  if (resolvedConnectedBy) {
    await prisma.membership.create({
      data: { workspaceId: ws.id, userId: resolvedConnectedBy, role: "owner" },
    });
  }
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
  return { wsId: ws.id, itemId: item.id, userId: resolvedConnectedBy };
}

async function seedUserWithActiveItems(opts: {
  userId: string;
  email: string;
  count: number;
  stripeCustomerId?: string;
}) {
  await prisma.user.create({
    data: {
      id: opts.userId,
      email: opts.email,
      emailVerified: true,
      name: opts.email,
      stripeCustomerId: opts.stripeCustomerId,
    },
  });
  const ws = await prisma.workspace.create({ data: { name: `WS ${opts.email}` } });
  await prisma.membership.create({ data: { workspaceId: ws.id, userId: opts.userId, role: "owner" } });
  const items = [];
  for (let i = 0; i < opts.count; i++) {
    items.push(await prisma.plaidItem.create({
      data: {
        workspaceId: ws.id,
        connectedBy: opts.userId,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from([2]),
        itemId: `pi_${opts.userId}_${i}`,
        institutionId: "ins_1",
        institutionName: "Bank",
        status: "active",
        createdAt: new Date(Date.UTC(2026, 0, i + 1)),
      },
    }));
  }
  return { wsId: ws.id, items };
}

function fakeStripeSub(opts: { id: string; customer: string; priceId?: string; status?: string }) {
  return {
    id: opts.id,
    customer: opts.customer,
    status: opts.status ?? "active",
    cancel_at_period_end: false,
    current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
    items: { data: [{ price: { id: opts.priceId ?? env.STRIPE_PRICE_PRO_MONTHLY } }] },
  } as any;
}

async function seedTxWithCategory(opts: {
  workspaceId: string;
  txId: string;
  amount: number;
  merchant: string;
  categoryName: string;
}): Promise<void> {
  const cat = await prisma.category.create({
    data: { workspaceId: opts.workspaceId, name: opts.categoryName },
  });
  let bankAccount = await prisma.bankAccount.findFirst({
    where: { workspaceId: opts.workspaceId },
  });
  if (!bankAccount) {
    bankAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: opts.workspaceId,
        name: "Test Acct",
        type: "depository",
        currency: "CAD",
        status: "active",
      },
    });
  }
  await prisma.transaction.create({
    data: {
      id: opts.txId,
      workspaceId: opts.workspaceId,
      accountId: bankAccount.id,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: opts.merchant,
      merchantNormalized: opts.merchant.toLowerCase(),
      occurredAt: new Date(),
      pending: false,
      source: "plaid",
      rawData: {},
    },
  });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: opts.txId,
      categoryId: cat.id,
      amount: new Prisma.Decimal(opts.amount),
      source: "manual",
    },
  });
}

beforeEach(async () => {
  seedCounter = 0;
  await truncateAll();
  resetPlaidMock();
  vi.mocked(syncTransactions).mockReset();
  vi.mocked(categorizeNewTransactions).mockReset();
  vi.mocked(categorizeNewTransactions).mockResolvedValue(undefined as never);
  vi.mocked(checkBackgroundSyncGate).mockReset();
  // Default: all users are Pro
  vi.mocked(checkBackgroundSyncGate).mockResolvedValue({ ok: true });
  vi.mocked(removeItemForBilling).mockReset();
  vi.mocked(removeItemForBilling).mockResolvedValue(undefined);
  providerMocks.stripe.subscriptions.list.mockReset();
  providerMocks.stripe.subscriptions.list.mockResolvedValue({ data: [] });
  providerMocks.stripe.subscriptions.retrieve.mockReset();
  providerMocks.stripe.subscriptionSchedules.retrieve.mockReset();
  providerMocks.appleClient.getSubscriptionStatus.mockReset();
  providerMocks.googleClient.fetchAndNormalize.mockReset();
  providerMocks.googleClient.acknowledgeIfPending.mockReset();
  providerMocks.googleClient.acknowledgeIfPending.mockResolvedValue(true);
  providerMocks.AppleClient.mockClear();
  providerMocks.GoogleClient.mockClear();
  vi.mocked(anomalyMod.checkLargeChargeAndPush).mockReset();
  vi.mocked(anomalyMod.checkLargeChargeAndPush).mockResolvedValue(undefined);
  vi.mocked(addedMod.notifyTransactionAdded).mockReset();
  vi.mocked(addedMod.notifyTransactionAdded).mockResolvedValue(undefined);
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

  it("null connectedBy: does not sync orphan items after orphan reconciliation path", async () => {
    await seedActiveItem(null); // connectedBy = null
    vi.mocked(syncTransactions).mockResolvedValue(syncOk);

    await runDailyRefresh(env);

    expect(checkBackgroundSyncGate).not.toHaveBeenCalled();
    expect(removeItemForBilling).toHaveBeenCalledTimes(1);
    expect(syncTransactions).not.toHaveBeenCalled();
  });

  it("lock_held result: increments lockHeld counter (no throw)", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue(syncLockHeld);

    // Should complete without error
    await expect(runDailyRefresh(env)).resolves.toBeUndefined();
    expect(syncTransactions).toHaveBeenCalledTimes(1);
  });
});

describe("runDailyRefresh — provider refresh and reconciliation", () => {
  it("lists Stripe subscriptions before Plaid reconciliation", async () => {
    const order: string[] = [];
    const { items } = await seedUserWithActiveItems({
      userId: "u-stripe-refresh",
      email: "stripe-refresh@test.fina",
      count: 2,
      stripeCustomerId: "cus_refresh",
    });
    providerMocks.stripe.subscriptions.list.mockImplementation(async () => {
      order.push("stripe-list");
      return { data: [{ id: "sub_refresh" }] };
    });
    providerMocks.stripe.subscriptions.retrieve.mockResolvedValue(
      fakeStripeSub({
        id: "sub_refresh",
        customer: "cus_refresh",
        priceId: env.STRIPE_PRICE_LITE_MONTHLY,
      }),
    );
    vi.mocked(removeItemForBilling).mockImplementation(async () => {
      order.push("plaid-reconcile");
    });
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(providerMocks.stripe.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_refresh",
      status: "all",
      limit: 10,
    });
    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), items[1]!.id);
    expect(order.indexOf("stripe-list")).toBeLessThan(order.indexOf("plaid-reconcile"));
  });

  it("provider refresh failure does not reconcile, disconnect, or sync that user's active item", async () => {
    await seedUserWithActiveItems({
      userId: "u-provider-fail",
      email: "provider-fail@test.fina",
      count: 1,
      stripeCustomerId: "cus_fail",
    });
    await prisma.subscription.create({
      data: {
        userId: "u-provider-fail",
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_local_pro",
        sourceCustomerId: "cus_fail",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    providerMocks.stripe.subscriptions.list.mockRejectedValueOnce(new Error("stripe unavailable"));
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(removeItemForBilling).not.toHaveBeenCalled();
    expect(syncTransactions).not.toHaveBeenCalled();
  });

  it("reconciliation cleanup failure prevents that user's active items from syncing in the same run", async () => {
    const { items } = await seedUserWithActiveItems({
      userId: "u-cleanup-fail",
      email: "cleanup-fail@test.fina",
      count: 2,
    });
    await prisma.subscription.create({
      data: {
        userId: "u-cleanup-fail",
        tier: "lite",
        source: "stripe",
        sourceSubscriptionId: "sub_cleanup_fail",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    vi.mocked(removeItemForBilling).mockRejectedValueOnce(new Error("plaid cleanup failed"));
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), items[1]!.id);
    expect(syncTransactions).not.toHaveBeenCalled();
  });

  it("refreshes Apple IAP status before Plaid reconciliation", async () => {
    const order: string[] = [];
    const { items } = await seedUserWithActiveItems({
      userId: "u-apple-refresh",
      email: "apple-refresh@test.fina",
      count: 2,
    });
    await prisma.subscription.create({
      data: {
        userId: "u-apple-refresh",
        tier: "pro",
        source: "iap_apple",
        sourceSubscriptionId: "OT-apple-refresh",
        sourceCustomerId: "apple-account",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Sandbox",
      },
    });
    providerMocks.appleClient.getSubscriptionStatus.mockImplementation(async () => {
      order.push("apple-refresh");
      return {
        expiresDate: new Date(Date.now() + 30 * 86400_000),
        productId: "lite_monthly",
        mapped: { status: "active", cancelAtPeriodEnd: false },
      };
    });
    vi.mocked(removeItemForBilling).mockImplementation(async () => {
      order.push("plaid-reconcile");
    });
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(providerMocks.appleClient.getSubscriptionStatus).toHaveBeenCalledWith("OT-apple-refresh");
    const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: "u-apple-refresh" } });
    expect(sub.tier).toBe("lite");
    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), items[1]!.id);
    expect(order.indexOf("apple-refresh")).toBeLessThan(order.indexOf("plaid-reconcile"));
  });

  it("refreshes Google IAP status before Plaid reconciliation", async () => {
    const order: string[] = [];
    const { items } = await seedUserWithActiveItems({
      userId: "u-google-refresh",
      email: "google-refresh@test.fina",
      count: 2,
    });
    await prisma.subscription.create({
      data: {
        userId: "u-google-refresh",
        tier: "pro",
        source: "iap_google",
        sourceSubscriptionId: "pt-google-refresh",
        sourceCustomerId: "google-account",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        environment: "Production",
      },
    });
    providerMocks.googleClient.fetchAndNormalize.mockImplementation(async () => {
      order.push("google-refresh");
      return {
        obfuscatedExternalAccountId: "google-account",
        acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
        subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
        productId: "lite_monthly",
        expiryTime: new Date(Date.now() + 30 * 86400_000),
        linkedPurchaseToken: null,
        environment: "Production",
        mapped: { status: "active", cancelAtPeriodEnd: false },
        raw: {},
      };
    });
    vi.mocked(removeItemForBilling).mockImplementation(async () => {
      order.push("plaid-reconcile");
    });
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    expect(providerMocks.googleClient.fetchAndNormalize).toHaveBeenCalledWith("pt-google-refresh");
    expect(providerMocks.googleClient.acknowledgeIfPending).toHaveBeenCalledWith({
      purchaseToken: "pt-google-refresh",
      productId: "lite_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: "u-google-refresh" } });
    expect(sub.tier).toBe("lite");
    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), items[1]!.id);
    expect(order.indexOf("google-refresh")).toBeLessThan(order.indexOf("plaid-reconcile"));
  });
});

describe("runDailyRefresh — push integration", () => {
  it("syncTransactions returns newTxIds → checkLargeChargeAndPush + notifyTransactionAdded called once each", async () => {
    const { wsId } = await seedActiveItem();
    const txId = `tx-${Date.now()}-1`;
    await seedTxWithCategory({
      workspaceId: wsId,
      txId,
      amount: 50.5,
      merchant: "Coffee",
      categoryName: "Food",
    });
    vi.mocked(syncTransactions).mockResolvedValue({
      added: 1,
      modified: 0,
      removed: 0,
      newTxIds: [txId],
    });

    await runDailyRefresh(env);

    const anomalyCalls = vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls;
    expect(anomalyCalls).toHaveLength(1);
    expect(anomalyCalls[0]).toEqual([
      env,
      expect.objectContaining({
        transactionId: txId,
        workspaceId: wsId,
        amount: 50.5,
        merchant: "coffee",
      }),
    ]);

    const notifyCalls = vi.mocked(addedMod.notifyTransactionAdded).mock.calls;
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toEqual([
      env,
      expect.objectContaining({
        workspaceId: wsId,
        merchant: "coffee",
        amount: 50.5,
        categoryName: "Food",
      }),
    ]);
    // No excludeUserId — Plaid-synced txs have no actor.
    expect(notifyCalls[0]?.[1]).not.toHaveProperty("excludeUserId");
  });

  it("syncTransactions returns no newTxIds → neither push helper called", async () => {
    await seedActiveItem();
    vi.mocked(syncTransactions).mockResolvedValue({
      added: 0,
      modified: 0,
      removed: 0,
      newTxIds: [],
    });

    await runDailyRefresh(env);

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);
  });

  it("checkLargeChargeAndPush throws → notifyTransactionAdded NOT called (fail-stop within tx; pinned for future fix)", async () => {
    const { wsId } = await seedActiveItem();
    const txId = `tx-${Date.now()}-fail`;
    await seedTxWithCategory({
      workspaceId: wsId,
      txId,
      amount: 50,
      merchant: "Z",
      categoryName: "X",
    });
    vi.mocked(syncTransactions).mockResolvedValue({
      added: 1,
      modified: 0,
      removed: 0,
      newTxIds: [txId],
    });
    vi.mocked(anomalyMod.checkLargeChargeAndPush).mockRejectedValueOnce(new Error("boom"));

    // Outer per-item try/catch swallows.
    await expect(runDailyRefresh(env)).resolves.toBeUndefined();

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(1);
    // Pinned: notify NOT called because anomaly throw aborted the for-loop iteration.
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);
  });
});
