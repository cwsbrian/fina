import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
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

async function seedItem(): Promise<{ wsId: string; itemId: string; eventId: string }> {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
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
