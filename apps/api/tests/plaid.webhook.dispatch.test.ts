import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchWebhookSync } from "../src/plaid/webhook-dispatch.js";

vi.mock("../src/plaid/sync.js", async () => {
  return {
    syncTransactions: vi.fn(),
    SyncLockHeld: class SyncLockHeld extends Error {},
  };
});
vi.mock("../src/categorize/service.js", async () => {
  return { categorizeNewTransactions: vi.fn() };
});

import { syncTransactions } from "../src/plaid/sync.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

async function seedUser(opts: { email: string; trialEndsAt: Date | null }): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      email: opts.email,
      name: opts.email,
      trialEndsAt: opts.trialEndsAt,
      trialConsumed: opts.trialEndsAt === null,
    },
  });
  return user.id;
}

async function seedItem(opts: { connectedBy?: string | null } = {}): Promise<{ wsId: string; itemId: string; eventId: string }> {
  const connectedBy =
    opts.connectedBy === undefined
      ? await seedUser({ email: `webhook-${randomUUID()}@example.com`, trialEndsAt: new Date("2099-01-01T00:00:00Z") })
      : opts.connectedBy;
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  if (connectedBy) {
    await prisma.membership.create({
      data: { workspaceId: ws.id, userId: connectedBy, role: "owner" },
    });
  }
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      connectedBy,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
    },
  });
  const event = await prisma.plaidWebhookEvent.create({
    data: {
      plaidItemId: item.id,
      webhookType: "TRANSACTIONS",
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      body: {},
    },
  });
  return { wsId: ws.id, itemId: item.id, eventId: event.id };
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
  vi.mocked(syncTransactions).mockReset();
  vi.mocked(categorizeNewTransactions).mockReset();
});

afterAll(async () => { await disconnect(); });

describe("dispatchWebhookSync", () => {
  it("sets processedAt after successful sync + categorize", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 2, modified: 0, removed: 0, newTxIds: ["t1", "t2"] });
    vi.mocked(categorizeNewTransactions).mockResolvedValue(undefined);

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toBeNull();
    expect(categorizeNewTransactions).toHaveBeenCalledWith(env, wsId, ["t1", "t2"]);
  });

  it("does not call categorize when newTxIds is empty", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 5, removed: 0, newTxIds: [] });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
  });

  it("leaves processedAt NULL when syncTransactions returns lock_held (retryable)", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({
      skipped: "lock_held", added: 0, modified: 0, removed: 0, newTxIds: [],
    });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).toBeNull();
    expect(row.processError).toBeNull();
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
  });

  it("records processError + processedAt when sync throws", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockRejectedValue(new Error("plaid 500"));

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toContain("plaid 500");
  });

  it("marks no-owner webhook processed without syncing", async () => {
    const { wsId, itemId, eventId } = await seedItem({ connectedBy: null });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(syncTransactions).not.toHaveBeenCalled();
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toBe("no_owner");
  });

  it("marks no-membership webhook processed without syncing", async () => {
    const userId = await seedUser({
      email: "webhook-stale-member@example.com",
      trialEndsAt: new Date("2026-07-01T00:00:00Z"),
    });
    const { wsId, itemId, eventId } = await seedItem({ connectedBy: userId });
    await prisma.membership.deleteMany({ where: { workspaceId: wsId, userId } });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(syncTransactions).not.toHaveBeenCalled();
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toBe("no_membership");
  });

  it("marks tier-gated webhook processed without syncing", async () => {
    const userId = await seedUser({ email: "webhook-free@example.com", trialEndsAt: null });
    const { wsId, itemId, eventId } = await seedItem({ connectedBy: userId });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(syncTransactions).not.toHaveBeenCalled();
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).not.toBeNull();
    expect(row.processError).toBe("tier_gated:no_plaid_entitlement");
  });

  it("syncs but does not categorize or notify product flows during billing grace", async () => {
    const userId = await seedUser({ email: "webhook-grace@example.com", trialEndsAt: null });
    const { wsId, itemId, eventId } = await seedItem({ connectedBy: userId });
    await prisma.plaidItem.update({
      where: { id: itemId },
      data: { billingGraceEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    vi.mocked(syncTransactions).mockResolvedValue({
      added: 1,
      modified: 0,
      removed: 0,
      newTxIds: ["hidden-grace-tx"],
    });

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(syncTransactions).toHaveBeenCalledWith(env, wsId, itemId);
    expect(categorizeNewTransactions).not.toHaveBeenCalled();
    await expect(
      prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } }),
    ).resolves.toMatchObject({ processedAt: expect.any(Date), processError: null });
  });

  it("still categorizes newTxIds from a lock_held result if any were committed", async () => {
    const { wsId, itemId, eventId } = await seedItem();
    vi.mocked(syncTransactions).mockResolvedValue({
      skipped: "lock_held", added: 1, modified: 0, removed: 0, newTxIds: ["t1"],
    });
    vi.mocked(categorizeNewTransactions).mockResolvedValue(undefined);

    await dispatchWebhookSync(env, wsId, itemId, eventId);

    expect(categorizeNewTransactions).toHaveBeenCalledWith(env, wsId, ["t1"]);
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(row.processedAt).toBeNull(); // still retryable
  });
});
