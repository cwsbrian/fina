import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `cf-${counter++}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "ConfirmTestCat" } });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: cat.id, source: "ai", needsConfirmation: true } },
    },
  });
  return { cookie: u.cookie, wsId, catId: cat.id, txId: tx.id, accountId: acct.id };
}

describe("POST /workspaces/:id/transactions/:txId/confirm-category", () => {
  it("sets needsConfirmation=false and dismissedUntil=null", async () => {
    const { cookie, wsId, txId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/confirm-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(false);
    expect(alloc?.dismissedUntil).toBeNull();
  });

  it("returns 404 for missing tx", async () => {
    const { cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/confirm-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(404);
  });

  it("auto-promotes after 3rd confirm of same merchant+category", async () => {
    const { cookie, wsId, catId, accountId } = await setup();
    // First tx from setup() has needsConfirmation=true. Confirm it via the route.
    const firstTx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });

    // Create 2 more tx with needsConfirmation=true + source='ai' + same merchant/category.
    const extraIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = await prisma.transaction.create({
        data: {
          workspaceId: wsId, accountId,
          merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
          amount: "5.00", occurredAt: new Date(),
          source: "plaid", rawData: {},
          allocations: { create: { amount: "5.00", categoryId: catId, source: "ai", needsConfirmation: true } },
        },
      });
      extraIds.push(t.id);
    }
    for (const id of [firstTx.id, ...extraIds]) {
      const r = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/transactions/${id}/confirm-category`,
        headers: { cookie, "x-workspace-id": wsId },
      });
      expect(r.statusCode).toBe(200);
    }
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map?.source).toBe("auto");
  });
});

describe("PATCH auto-promote trigger", () => {
  it("auto-promotes after 3rd manual edit assigning same merchant+category", async () => {
    const { cookie, wsId, catId, accountId } = await setup();
    // Seed 2 prior allocs (same merchant/category) as confirmed manual edits.
    for (let i = 0; i < 2; i++) {
      await prisma.transaction.create({
        data: {
          workspaceId: wsId, accountId,
          merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
          amount: "5.00", occurredAt: new Date(),
          source: "plaid", rawData: {},
          allocations: {
            create: {
              amount: "5.00", categoryId: catId, source: "manual",
              needsConfirmation: false,
            },
          },
        },
      });
    }

    // Third tx: starts with null-category alloc; PATCH sets the category.
    const third = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId,
        merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
        amount: "5.00", occurredAt: new Date(),
        source: "manual", rawData: {},
        allocations: { create: { amount: "5.00", categoryId: null, source: null } },
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${third.id}`,
      headers: { cookie, "x-workspace-id": wsId },
      payload: { categoryId: catId },
    });
    expect(res.statusCode).toBe(200);

    const map = await prisma.merchantMapping.findFirst({
      where: { workspaceId: wsId, merchantNormalized: "starbucks" },
    });
    expect(map?.source).toBe("auto");
  });
});

describe("POST /workspaces/:id/transactions/:txId/snooze-category", () => {
  it("sets dismissedUntil ~7d from now, keeps needsConfirmation=true", async () => {
    const { cookie, wsId, txId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/snooze-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(true);
    expect(alloc?.dismissedUntil).not.toBeNull();
    const futureMs = alloc!.dismissedUntil!.getTime() - Date.now();
    expect(futureMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(futureMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it("returns 404 for missing tx", async () => {
    const { cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/snooze-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(404);
  });
});
