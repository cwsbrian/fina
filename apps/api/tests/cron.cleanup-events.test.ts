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

describe("cleanup-events ScheduledSpend pass", () => {
  it("deletes resolved ScheduledSpends older than the TTL (default 90 days)", async () => {
    const ws = await prisma.workspace.create({ data: { name: "ss-cleanup-ws" } });
    const cat = await prisma.category.create({ data: { workspaceId: ws.id, name: "Bills" } });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: ws.id, name: "Chequing", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: acct.id,
        plaidTransactionId: "ss-tx-1",
        amount: "30.00",
        merchantRaw: "Rent",
        occurredAt: new Date("2026-04-01T12:00:00Z"),
        rawData: {},
      },
    });

    // Resolved + old (dismissedAt set, updatedAt 91 days ago) → should DELETE
    const oldDismissed = await prisma.scheduledSpend.create({
      data: {
        workspaceId: ws.id,
        categoryId: cat.id,
        amount: "20.00",
        scheduledDate: new Date("2025-12-01"),
        dismissedAt: new Date("2026-01-01"),
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE scheduled_spends SET "updatedAt" = NOW() - INTERVAL '91 days' WHERE id = '${oldDismissed.id}'`,
    );

    // Resolved + recent (matchedTxId set, updatedAt 30 days ago) → should NOT delete
    const recentMatched = await prisma.scheduledSpend.create({
      data: {
        workspaceId: ws.id,
        categoryId: cat.id,
        amount: "30.00",
        scheduledDate: new Date("2026-04-01"),
        matchedTxId: tx.id,
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE scheduled_spends SET "updatedAt" = NOW() - INTERVAL '30 days' WHERE id = '${recentMatched.id}'`,
    );

    // Unresolved + old (neither set, updatedAt 120 days ago) → should NOT delete
    const oldUnresolved = await prisma.scheduledSpend.create({
      data: {
        workspaceId: ws.id,
        categoryId: cat.id,
        amount: "40.00",
        scheduledDate: new Date("2025-12-15"),
      },
    });
    await prisma.$executeRawUnsafe(
      `UPDATE scheduled_spends SET "updatedAt" = NOW() - INTERVAL '120 days' WHERE id = '${oldUnresolved.id}'`,
    );

    await runCleanupEvents(env);

    expect(await prisma.scheduledSpend.findUnique({ where: { id: oldDismissed.id } })).toBeNull();
    expect(await prisma.scheduledSpend.findUnique({ where: { id: recentMatched.id } })).not.toBeNull();
    expect(await prisma.scheduledSpend.findUnique({ where: { id: oldUnresolved.id } })).not.toBeNull();
  });
});
