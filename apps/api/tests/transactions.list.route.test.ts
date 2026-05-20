import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
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

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedTxWithAllocations(
  wsId: string,
  amount: string,
  allocs: Array<{ categoryId: string | null; amount: string; source: "manual" | null }>,
): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Test", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: null,
      amount, merchantRaw: "Test", merchantNormalized: "test",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false, source: "manual", rawData: {},
    },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: allocs.map((a) => ({
      transactionId: tx.id,
      categoryId: a.categoryId,
      amount: a.amount,
      source: a.source,
    })),
  });
  return tx.id;
}

describe("GET /workspaces/:id/transactions", () => {
  it("response includes allocations array and needsReclassification per tx", async () => {
    const { cookie, wsId } = await setup("tl1@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-tl1" } });
    await seedTxWithAllocations(wsId, "20", [{ categoryId: cat.id, amount: "20", source: "manual" }]);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].allocations).toHaveLength(1);
    expect(body.transactions[0].allocations[0].categoryId).toBe(cat.id);
    expect(body.transactions[0].needsReclassification).toBe(false);
  });

  it("split tx returns multiple allocations", async () => {
    const { cookie, wsId } = await setup("tl2@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-tl2" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-tl2" } });
    await seedTxWithAllocations(wsId, "100", [
      { categoryId: c1.id, amount: "60", source: "manual" },
      { categoryId: c2.id, amount: "40", source: "manual" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions[0].allocations).toHaveLength(2);
  });

  it("filter ?categoryId=X matches via allocation predicate (incl. split tx)", async () => {
    const { cookie, wsId } = await setup("tl3@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-tl3" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-tl3" } });
    // Single-category tx
    await seedTxWithAllocations(wsId, "10", [{ categoryId: c1.id, amount: "10", source: "manual" }]);
    // Split tx (c1+c2)
    await seedTxWithAllocations(wsId, "20", [
      { categoryId: c1.id, amount: "5", source: "manual" },
      { categoryId: c2.id, amount: "15", source: "manual" },
    ]);
    // Unrelated tx
    await seedTxWithAllocations(wsId, "5", [{ categoryId: c2.id, amount: "5", source: "manual" }]);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?categoryId=${c1.id}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions).toHaveLength(2); // single c1 + split c1+c2
  });

  it("filter ?uncategorizedOnly=true matches tx with ≥1 null-cat allocation", async () => {
    const { cookie, wsId } = await setup("tl4@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-tl4" } });
    await seedTxWithAllocations(wsId, "10", [{ categoryId: null, amount: "10", source: null }]);
    await seedTxWithAllocations(wsId, "20", [{ categoryId: cat.id, amount: "20", source: "manual" }]);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].allocations[0].categoryId).toBeNull();
  });

  it("filter ?uncategorizedOnly=true & ?categoryId=X combines via OR (both filters applied)", async () => {
    const { cookie, wsId } = await setup("tl5@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-tl5" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-tl5" } });
    // Tx matching c1
    await seedTxWithAllocations(wsId, "10", [{ categoryId: c1.id, amount: "10", source: "manual" }]);
    // Tx with one uncategorized alloc
    await seedTxWithAllocations(wsId, "20", [{ categoryId: null, amount: "20", source: null }]);
    // Tx matching c2 (should NOT match)
    await seedTxWithAllocations(wsId, "30", [{ categoryId: c2.id, amount: "30", source: "manual" }]);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?uncategorizedOnly=true&categoryId=${c1.id}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(2); // c1 tx + uncategorized tx
  });
});
