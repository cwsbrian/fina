import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { runCleanupEvents } from "../src/cron/jobs/cleanup-events.js";

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

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function seedEvent(receivedAt: Date, processedAt?: Date) {
  return prisma.plaidWebhookEvent.create({
    data: {
      webhookType: "TRANSACTIONS",
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      body: {},
      receivedAt,
      ...(processedAt ? { processedAt } : {}),
    },
  });
}

describe("runCleanupEvents", () => {
  it("deletes rows older than CRON_EVENT_TTL_DAYS", async () => {
    const old = await seedEvent(new Date(Date.now() - 31 * 86_400_000));
    const recent = await seedEvent(new Date(Date.now() - 1 * 86_400_000));

    await runCleanupEvents({ ...env, CRON_EVENT_TTL_DAYS: 30 });

    const remaining = await prisma.plaidWebhookEvent.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
    // old row deleted
    void old;
  });

  it("keeps rows within the TTL window", async () => {
    const row = await seedEvent(new Date(Date.now() - 5 * 86_400_000));

    await runCleanupEvents({ ...env, CRON_EVENT_TTL_DAYS: 30 });

    const remaining = await prisma.plaidWebhookEvent.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(row.id);
  });

  it("respects env.CRON_EVENT_TTL_DAYS override (1 day)", async () => {
    const old = await seedEvent(new Date(Date.now() - 2 * 86_400_000));
    const recent = await seedEvent(new Date());

    await runCleanupEvents({ ...env, CRON_EVENT_TTL_DAYS: 1 });

    const remaining = await prisma.plaidWebhookEvent.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
    void old;
  });

  it("deletes NULL-processedAt rows that are beyond the TTL (intentional)", async () => {
    await seedEvent(new Date(Date.now() - 31 * 86_400_000)); // NULL processedAt (stuck)

    await runCleanupEvents({ ...env, CRON_EVENT_TTL_DAYS: 30 });

    expect(await prisma.plaidWebhookEvent.findMany()).toHaveLength(0);
  });
});
