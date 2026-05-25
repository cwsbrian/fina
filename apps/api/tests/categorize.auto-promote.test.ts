import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { maybeAutoPromote } from "../src/categorize/auto-promote.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const email = `ap-${counter++}@x.com`;
  const u = await signUpAndGetCookie(app, { email, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "AutoPromoteCat" } });
  return { wsId, accountId: acct.id, catId: cat.id };
}

async function makeAlloc(
  wsId: string,
  accountId: string,
  merchant: string,
  catId: string,
  source: "ai" | "history" | "manual" | "mapping",
  needsConfirmation: boolean,
) {
  await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: merchant.toUpperCase(), merchantNormalized: merchant,
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: catId, source, needsConfirmation } },
    },
  });
}

describe("maybeAutoPromote", () => {
  it("does not insert when count < 3", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
    expect(r.count).toBe(2);
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map).toBeNull();
  });

  it("inserts when count = 3 (mixed sources: ai/history/manual)", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "history", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "manual", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(true);
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map?.source).toBe("auto");
  });

  it("excludes needsConfirmation=true from count", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
  });

  it("excludes source='mapping' from count", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
    expect(r.count).toBe(0);
  });

  it("idempotent - already exists, no error", async () => {
    const { wsId, accountId, catId } = await setup();
    await prisma.merchantMapping.create({ data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: catId, confidence: 1.0, source: "manual" } });
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false); // INSERT attempt skipped by ON CONFLICT
  });

  it("different categories on same merchant do not auto-promote", async () => {
    const { wsId, accountId, catId } = await setup();
    const otherCat = await prisma.category.create({ data: { workspaceId: wsId, name: "OtherTestCat" } });
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", otherCat.id, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false); // only 2 with this category
  });
});
