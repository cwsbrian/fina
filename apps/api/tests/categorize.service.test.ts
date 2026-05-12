import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";

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
  CATEGORIZE_BATCH_MAX: 50,
};

beforeEach(async () => {
  await truncateAll();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

async function setupWorkspaceWithAccount(): Promise<{ wsId: string; accountId: string; userId: string }> {
  const app = await buildApp(env);
  const u = await signUpAndGetCookie(app, { email: `svc-${Date.now()}@x.com`, name: "SVC" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Checking", type: "depository" },
  });
  await app.close();
  return { wsId, accountId: acct.id, userId: u.userId };
}

async function makeTx(wsId: string, accountId: string, merchant: string, idSuffix = ""): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId,
      plaidTransactionId: `pt_${idSuffix || merchant.replace(/\W/g, "")}${Date.now()}`,
      amount: 10,
      merchantRaw: merchant,
      occurredAt: new Date("2026-05-10"),
      rawData: {},
    },
  });
  return tx.id;
}

async function categoryId(wsId: string, name: string): Promise<string> {
  const c = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name } });
  return c.id;
}

// NOTE: `setupWorkspaceWithAccount()` signs up a user, which triggers bootstrap
// and seeds all 11 default categories. Do NOT call prisma.category.createMany()
// for seeded category names (Dining, Groceries, Transit, etc.) — those calls
// will violate the active-name partial unique index and fail.
// Use `await categoryId(wsId, "Dining")` to look up already-seeded categories.
describe("categorizeNewTransactions", () => {
  it("all mapped → no LLM call, source='mapping'", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Categories already seeded by bootstrap.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const txId = await makeTx(wsId, accountId, "Starbucks");

    // No Gemini push — would throw if called.
    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(diningId);
    expect(after.categorizationSource).toBe("mapping");
    expect(after.merchantNormalized).toBe("starbucks");
  });

  it("no mappings → LLM returns valid categories → source='ai'", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "Groceries" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(await categoryId(wsId, "Groceries"));
    expect(after.categorizationSource).toBe("ai");
  });

  it("mixed: 1 mapped, 2 unmapped → LLM called for 2 only", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const mappedId = await makeTx(wsId, accountId, "Starbucks", "a");
    const llmA = await makeTx(wsId, accountId, "Loblaws", "b");
    const llmB = await makeTx(wsId, accountId, "TTC", "c");

    geminiMock.generateContent.push({
      results: [
        { tx_id: llmA, category: "Groceries" },
        { tx_id: llmB, category: "Transit" },
      ],
    });

    await categorizeNewTransactions(env, wsId, [mappedId, llmA, llmB]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: mappedId } })).categorizationSource).toBe("mapping");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmA } })).categorizationSource).toBe("ai");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmB } })).categorizationSource).toBe("ai");
  });

  it("LLM returns category not in seed → that tx stays uncategorized", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "WeirdShop");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "InventedCategory" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBeNull();
    expect(after.categorizationSource).toBeNull();
  });

  it("LLM returns unknown tx_id → skip silently, valid ones still applied", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({
      results: [
        { tx_id: "unknown_tx_id", category: "Groceries" },
        { tx_id: txId, category: "Groceries" },
      ],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).categorizationSource).toBe("ai");
  });

  it("LLM throws → unmapped tx stay uncategorized; mapped ones still applied", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const mappedId = await makeTx(wsId, accountId, "Starbucks", "a");
    const llmId = await makeTx(wsId, accountId, "Loblaws", "b");

    geminiMock.generateContent.push(new Error("Gemini API down"));

    await categorizeNewTransactions(env, wsId, [mappedId, llmId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: mappedId } })).categorizationSource).toBe("mapping");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmId } })).categoryId).toBeNull();
  });

  it("batch > CATEGORIZE_BATCH_MAX → multiple LLM calls", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const smallEnv = { ...env, CATEGORIZE_BATCH_MAX: 2 };
    const ids = await Promise.all([
      makeTx(wsId, accountId, "M1", "1"),
      makeTx(wsId, accountId, "M2", "2"),
      makeTx(wsId, accountId, "M3", "3"),
    ]);
    geminiMock.generateContent.push({
      results: [
        { tx_id: ids[0]!, category: "Other" },
        { tx_id: ids[1]!, category: "Other" },
      ],
    });
    geminiMock.generateContent.push({
      results: [{ tx_id: ids[2]!, category: "Other" }],
    });

    await categorizeNewTransactions(smallEnv, wsId, ids);

    expect(geminiMock.generateContent.length).toBe(0);
    for (const id of ids) {
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).categorizationSource).toBe("ai");
    }
  });

  it("merchantNormalized is populated on tx rows", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "STARBUCKS #1234 TORONTO ON");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).merchantNormalized).toBe("starbucks");
  });

  it("manual-vs-LLM race: concurrent manual categorize is NOT overwritten by LLM update guard", async () => {
    // This test verifies the `WHERE categorizationSource IS NULL` guard on the
    // LLM update path prevents overwriting a manual categorization that lands
    // AFTER the service's SELECT but BEFORE the service's UPDATE.
    //
    // Approach: pause the service at the Gemini call using a pending promise.
    // While it's paused, apply a manual categorization to the tx. Then resolve
    // Gemini. The service's `updateMany(WHERE categorizationSource IS NULL)`
    // must skip the tx (categorizationSource is now 'manual').
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const groceriesId = await categoryId(wsId, "Groceries");
    const diningId = await categoryId(wsId, "Dining");

    const txId = await makeTx(wsId, accountId, "Loblaws");

    // Push a pending Gemini promise so the service blocks at the LLM call.
    let geminiResolve!: (r: { results: Array<{ tx_id: string; category: string }> }) => void;
    geminiMock.generateContent.push(
      new Promise<{ results: Array<{ tx_id: string; category: string }> }>((r) => { geminiResolve = r; }),
    );

    // Start categorize (it will block at Gemini call after loading the tx).
    const servicePromise = categorizeNewTransactions(env, wsId, [txId]);

    // Poll until the service has loaded and started its Gemini request.
    // The mock queue being empty means the service already popped the pending
    // promise from the queue.
    for (let i = 0; i < 50; i++) {
      if (geminiMock.generateContent.length === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Now simulate the concurrent manual categorize firing while service is blocked.
    await prisma.transaction.update({
      where: { id: txId },
      data: { categoryId: diningId, categorizationSource: "manual", merchantNormalized: "loblaws" },
    });

    // Resolve Gemini with a Groceries result for the same tx.
    geminiResolve({ results: [{ tx_id: txId, category: "Groceries" }] });
    await servicePromise;

    // The service's updateMany WHERE categorizationSource IS NULL must have
    // skipped this tx (it's now 'manual'). Manual categorization is preserved.
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(diningId);              // manual survived
    expect(after.categorizationSource).toBe("manual");    // NOT overwritten to 'ai'
    expect(after.categoryId).not.toBe(groceriesId);
  });

  it("workspace-scoped category resolution: two workspaces with same category name", async () => {
    const { wsId: wsA, accountId: acctA } = await setupWorkspaceWithAccount();
    const { wsId: _wsB } = await setupWorkspaceWithAccount();
    // Both workspaces already have "Groceries" seeded by bootstrap — no createMany needed.
    const txId = await makeTx(wsA, acctA, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsA, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const wsAGroceries = await categoryId(wsA, "Groceries");
    expect(after.categoryId).toBe(wsAGroceries); // workspace A's Groceries, NOT workspace B's
  });

  it("archived category ignored by LLM (not in passed list)", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    // Archive Dining.
    await prisma.category.update({
      where: { id: await categoryId(wsId, "Dining") },
      data: { archivedAt: new Date() },
    });
    const txId = await makeTx(wsId, accountId, "Restaurant");

    // Even if the mocked LLM returns "Dining", the service must reject it.
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Dining" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBeNull(); // stays uncategorized
  });

  it("mapping points to archived category → skipped (tx stays uncategorized OR goes to LLM)", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    // Archive Dining after the mapping was created.
    await prisma.category.update({ where: { id: diningId }, data: { archivedAt: new Date() } });

    const txId = await makeTx(wsId, accountId, "Starbucks");
    // Mapping is no longer applicable. LLM falls back. Push "Other".
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categorizationSource).toBe("ai"); // mapping skipped, LLM ran
    expect(after.categoryId).toBe(await categoryId(wsId, "Other"));
  });

  it("LLM case-insensitive category match: 'groceries' lower matches 'Groceries' stored", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "groceries" }] }); // lowercase

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).categoryId).toBe(
      await categoryId(wsId, "Groceries"),
    );
  });

  it("empty newTxIds → no LLM call, no error", async () => {
    const { wsId } = await setupWorkspaceWithAccount();
    await categorizeNewTransactions(env, wsId, []);
    // geminiMock was never pushed; if it had been called, pop() would throw.
  });

  it("LLM categorization does NOT create merchant_mapping rows", async () => {
    // merchant_mappings are only created on manual confirm (spec §4.2).
    // The LLM path must ONLY update tx.categoryId; it must not auto-learn.
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });
    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categorizationSource).toBe("ai");

    // No mapping must have been created.
    const mappings = await prisma.merchantMapping.count({ where: { workspaceId: wsId } });
    expect(mappings).toBe(0);
  });
});
