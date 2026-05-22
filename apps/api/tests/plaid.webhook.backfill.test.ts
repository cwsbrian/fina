import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock, plaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

vi.mock("../src/plaid/items.js", async () => {
  return {
    readAccessToken: vi.fn().mockResolvedValue({
      accessToken: "decrypted-test-token",
      itemRow: { id: "stub", itemId: "stub" },
    }),
  };
});

import { backfillWebhookUrls } from "../src/plaid/webhook-backfill.js";
import { testEnv } from "./helpers/test-env.js";

// Note: NO PLAID_WEBHOOK_URL by default — tests that need it override via testEnv({ PLAID_WEBHOOK_URL: "..." })
const baseEnv = testEnv();

async function seedItem(opts: { webhookUrl?: string | null; status?: "active" | "error" } = {}) {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  return await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      status: opts.status ?? "active",
      webhookUrl: opts.webhookUrl === undefined ? null : opts.webhookUrl,
    },
  });
}

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});
afterAll(async () => { await disconnect(); });

describe("backfillWebhookUrls", () => {
  it("skips with log when PLAID_WEBHOOK_URL is absent", async () => {
    await seedItem({ webhookUrl: null });
    await backfillWebhookUrls(baseEnv);
    expect(plaidMock.itemWebhookUpdate.length).toBe(0); // no Plaid call attempted
  });

  it("updates items with NULL webhookUrl", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    const item = await seedItem({ webhookUrl: null });
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    expect(plaidMock.itemWebhookUpdate.length).toBe(0); // consumed
    const updated = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.webhookUrl).toBe("https://e.com/plaid/webhook");
  });

  it("updates items whose stored URL differs from current env URL", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://new.com/plaid/webhook" };
    const item = await seedItem({ webhookUrl: "https://old.com/plaid/webhook" });
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    const updated = await prisma.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(updated.webhookUrl).toBe("https://new.com/plaid/webhook");
  });

  it("skips items already at the current URL", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    await seedItem({ webhookUrl: "https://e.com/plaid/webhook" });
    await backfillWebhookUrls(env);
    expect(plaidMock.itemWebhookUpdate.length).toBe(0);
  });

  it("skips non-active items", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    await seedItem({ webhookUrl: null, status: "error" });
    await backfillWebhookUrls(env);
    expect(plaidMock.itemWebhookUpdate.length).toBe(0);
  });

  it("logs and continues when one item fails", async () => {
    const env = { ...baseEnv, PLAID_WEBHOOK_URL: "https://e.com/plaid/webhook" };
    const a = await seedItem({ webhookUrl: null });
    const b = await seedItem({ webhookUrl: null });
    plaidMock.itemWebhookUpdate.push(new Error("plaid 500"));
    plaidMock.itemWebhookUpdate.push({ data: {} });

    await backfillWebhookUrls(env);

    const aRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: a.id } });
    const bRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: b.id } });
    // One succeeded, one failed — exactly one should have webhookUrl set
    expect(aRow.webhookUrl === null || bRow.webhookUrl === null).toBe(true);
    expect(aRow.webhookUrl !== null || bRow.webhookUrl !== null).toBe(true);
  });
});
