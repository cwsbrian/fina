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
  const u = await signUpAndGetCookie(app, { email: `dc-${counter++}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "DismissTestCat" } });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: cat.id, source: "ai", needsConfirmation: true } },
    },
  });
  return { cookie: u.cookie, wsId, txId: tx.id };
}

describe("POST /workspaces/:id/transactions/:txId/dismiss-category", () => {
  it("sets needsConfirmation=false without changing dismissedUntil", async () => {
    const { cookie, wsId, txId } = await setup();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.transactionAllocation.updateMany({ where: { transactionId: txId }, data: { dismissedUntil: future } });

    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/dismiss-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(false);
    expect(alloc?.dismissedUntil?.getTime()).toBe(future.getTime());
  });

  it("returns 404 for missing tx", async () => {
    const { cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/dismiss-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(404);
  });
});
