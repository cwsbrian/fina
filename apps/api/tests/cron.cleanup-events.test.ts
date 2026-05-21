import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { runCleanupEvents } from "../src/cron/jobs/cleanup-events.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

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
