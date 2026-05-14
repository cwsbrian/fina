import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const { plaidMockFactory } = await vi.hoisted(async () => await import("./helpers/plaid-mock.js"));
vi.mock("plaid", plaidMockFactory);

vi.mock("../src/plaid/webhook-dispatch.js", () => ({
  dispatchWebhookSync: vi.fn(),
}));
vi.mock("../src/cron/tier-gate.js", () => ({
  checkBackgroundSyncGate: vi.fn(),
}));

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchWebhookSync } from "../src/plaid/webhook-dispatch.js";
import { checkBackgroundSyncGate } from "../src/cron/tier-gate.js";
import { runRetryUnprocessed } from "../src/cron/jobs/retry-unprocessed.js";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let seedCounter = 0;

async function seedItem(connectedBy: string | null = "user-a") {
  // connectedBy is a FK to the User table (onDelete: SetNull), so we must
  // create a real user row when it is non-null.
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
    },
  });
  return { wsId: ws.id, itemId: item.id };
}

async function seedEvent(itemId: string | null, opts: {
  processedAt?: Date;
  receivedAt?: Date;
  webhookCode?: string;
} = {}) {
  return prisma.plaidWebhookEvent.create({
    data: {
      plaidItemId: itemId,
      webhookType: "TRANSACTIONS",
      webhookCode: opts.webhookCode ?? "SYNC_UPDATES_AVAILABLE",
      body: {},
      receivedAt: opts.receivedAt ?? new Date(),
      ...(opts.processedAt ? { processedAt: opts.processedAt } : {}),
    },
  });
}

beforeEach(async () => {
  seedCounter = 0;
  await truncateAll();
  resetPlaidMock();
  vi.mocked(dispatchWebhookSync).mockReset();
  vi.mocked(checkBackgroundSyncGate).mockReset();
  vi.mocked(checkBackgroundSyncGate).mockResolvedValue({ ok: true });
});

afterAll(async () => { await disconnect(); });

describe("runRetryUnprocessed", () => {
  it("dispatches processedAt=null + SYNC_UPDATES_AVAILABLE + recent event", async () => {
    const { itemId } = await seedItem();
    await seedEvent(itemId);

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).toHaveBeenCalledTimes(1);
  });

  it("skips event with processedAt already set", async () => {
    const { itemId } = await seedItem();
    await seedEvent(itemId, { processedAt: new Date() });

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
  });

  it("skips event with plaidItemId = null (unknown item)", async () => {
    await seedEvent(null);

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
  });

  it("skips event received > 24h ago", async () => {
    const { itemId } = await seedItem();
    await seedEvent(itemId, { receivedAt: new Date(Date.now() - 25 * 3600_000) });

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
  });

  it("tier-gated: stamps processedAt + processError, does not dispatch", async () => {
    vi.mocked(checkBackgroundSyncGate).mockResolvedValue({ ok: false, reason: "trial_expired" });
    const { itemId } = await seedItem("user-expired");
    const ev = await seedEvent(itemId);

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    const updated = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(updated.processedAt).not.toBeNull();
    expect(updated.processError).toBe("tier_gated:trial_expired");
  });

  it("caps at 50 events per tick when 51 are queued", async () => {
    const { itemId } = await seedItem();
    for (let i = 0; i < 51; i++) {
      await seedEvent(itemId, { receivedAt: new Date(Date.now() - i * 1000) });
    }
    vi.mocked(dispatchWebhookSync).mockResolvedValue(undefined);

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).toHaveBeenCalledTimes(50);
  });

  it("lock_held: row stays NULL (reappears next tick)", async () => {
    const { itemId } = await seedItem();
    const ev = await seedEvent(itemId);
    // dispatchWebhookSync does nothing (simulates lock_held — processedAt stays NULL)
    vi.mocked(dispatchWebhookSync).mockResolvedValue(undefined);

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).toHaveBeenCalledTimes(1);
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.processedAt).toBeNull(); // still NULL — would reappear next tick
  });

  it("null connectedBy: allows dispatch (no gate)", async () => {
    const { itemId } = await seedItem(null);
    await seedEvent(itemId);
    vi.mocked(dispatchWebhookSync).mockResolvedValue(undefined);

    await runRetryUnprocessed(env);

    expect(checkBackgroundSyncGate).not.toHaveBeenCalled();
    expect(dispatchWebhookSync).toHaveBeenCalledTimes(1);
  });

  it("item deleted after event created (onDelete:SetNull) → event excluded, no dispatch", async () => {
    // The runtime guard `if (!ev.plaidItem) continue` defends against the race
    // where plaidItemId is non-null at findMany time but the relation is null
    // by loop time. The primary protection is the DB-level filter
    // (plaidItemId: { not: null }): once onDelete:SetNull fires, the event is
    // excluded from the next query. This test verifies the full safety path.
    //
    // Note: vi.spyOn on Prisma's delegate proxy corrupts the model's method
    // table across test files, so we use the real DB to trigger SetNull instead.
    // This verifies the primary (DB-level) safety path; the in-process runtime
    // guard `if (!ev.plaidItem) continue` at line 30 of retry-unprocessed.ts
    // covers the narrower race between findMany and the loop, which is not
    // reproducible via the real DB.
    const { itemId, wsId } = await seedItem();
    await seedEvent(itemId);

    // Delete the workspace → cascades to plaid_items → SetNull on event.plaidItemId.
    // The event now has plaidItemId=null and is excluded by the query filter.
    await prisma.workspace.delete({ where: { id: wsId } });

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
  });
});
