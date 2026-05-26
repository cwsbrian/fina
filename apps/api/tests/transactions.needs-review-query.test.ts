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
  const u = await signUpAndGetCookie(app, { email: `nr-${counter++}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "NRTestCat" } });
  return { cookie: u.cookie, wsId, accountId: acct.id, catId: cat.id };
}

async function makeTx(
  wsId: string,
  accountId: string,
  catId: string | null,
  opts: { needsConfirmation: boolean; dismissedUntil?: Date | null },
) {
  return prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: "M", merchantNormalized: "m",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: {
        create: {
          amount: "5.00",
          categoryId: catId,
          source: catId ? "ai" : null,
          needsConfirmation: opts.needsConfirmation,
          dismissedUntil: opts.dismissedUntil ?? null,
        },
      },
    },
  });
}

describe("GET /workspaces/:id/transactions?needsReview=true", () => {
  it("includes only allocations with needsConfirmation=true + categoryId + not snoozed", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    const expected = await makeTx(wsId, accountId, catId, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, { needsConfirmation: false });
    await makeTx(wsId, accountId, null, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, {
      needsConfirmation: true,
      dismissedUntil: new Date(Date.now() + 60_000),
    });

    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?needsReview=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(1);
    expect(body.transactions[0].id).toBe(expected.id);
  });

  it("includes allocations whose dismissedUntil is in the past", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    await makeTx(wsId, accountId, catId, {
      needsConfirmation: true,
      dismissedUntil: new Date(Date.now() - 60_000),
    });
    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?needsReview=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(1);
  });

  it("?needsReview omitted → returns all transactions in workspace", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    await makeTx(wsId, accountId, catId, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, { needsConfirmation: false });
    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(2);
  });
});
