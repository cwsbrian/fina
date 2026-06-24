import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { geminiMock, resetGeminiMock, lastLlmCategorizeRequest } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

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
  // Seed a null-cat allocation to simulate Migration A backfill.
  await prisma.transactionAllocation.create({
    data: { transactionId: tx.id, categoryId: null, amount: "10", source: null },
  });
  return tx.id;
}

async function categoryId(wsId: string, name: string): Promise<string> {
  const c = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name } });
  return c.id;
}

async function makePlaidItemAndAccount(
  wsId: string,
  createdAt: Date,
): Promise<{ plaidItemId: string; accountId: string }> {
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: wsId,
      connectedBy: null,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from(new Array(12).fill(2)),
      itemId: `item_${Math.random().toString(36).slice(2, 8)}`,
      institutionId: "ins_test",
      institutionName: "Test Bank",
      createdAt,
    },
  });
  const account = await prisma.bankAccount.create({
    data: {
      workspaceId: wsId,
      plaidItemId: item.id,
      plaidAccountId: `acct_${Math.random().toString(36).slice(2, 8)}`,
      name: "Plaid Checking",
      type: "depository",
    },
  });
  return { plaidItemId: item.id, accountId: account.id };
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

    // No LLM mock response — would throw if called.
    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.merchantNormalized).toBe("starbucks");

    // Allocation state assertion.
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(diningId);
    expect(allocs[0]!.source).toBe("mapping");
  });

  it("no mappings → LLM returns valid categories → source='ai'", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "Groceries" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    // Allocation state assertion.
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.source).toBe("ai");
    expect(allocs[0]!.categoryId).toBe(await categoryId(wsId, "Groceries"));
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

    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: mappedId } }))?.source).toBe("mapping");
    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: llmA } }))?.source).toBe("ai");
    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: llmB } }))?.source).toBe("ai");
  });

  it("LLM returns category not in seed → that tx stays uncategorized", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "WeirdShop");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "InventedCategory" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.categoryId).toBeNull();
    expect(afterAlloc?.source).toBeNull();
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

    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } }))?.source).toBe("ai");
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

    geminiMock.generateContent.push(new Error("LLM API down"));

    await categorizeNewTransactions(env, wsId, [mappedId, llmId]);

    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: mappedId } }))?.source).toBe("mapping");
    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: llmId } }))?.categoryId).toBeNull();
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
      expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: id } }))?.source).toBe("ai");
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
    // This test verifies the allocation-level WHERE source IS NULL guard on the
    // LLM update path prevents overwriting a manual categorization that lands
    // AFTER the service's SELECT but BEFORE the service's UPDATE.
    //
    // Approach: pause the service at the LLM call using a pending promise.
    // While it's paused, apply a manual categorization to the allocation. Then resolve
    // LLM. The service's `updateMany(WHERE source IS NULL AND categoryId IS NULL)`
    // must skip the tx (allocation source is now 'manual').
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const groceriesId = await categoryId(wsId, "Groceries");
    const diningId = await categoryId(wsId, "Dining");

    const txId = await makeTx(wsId, accountId, "Loblaws");

    // Push a pending LLM promise so the service blocks at the LLM call.
    let geminiResolve!: (r: { results: Array<{ tx_id: string; category: string }> }) => void;
    geminiMock.generateContent.push(
      new Promise<{ results: Array<{ tx_id: string; category: string }> }>((r) => { geminiResolve = r; }),
    );

    // Start categorize (it will block at LLM call after loading the tx).
    const servicePromise = categorizeNewTransactions(env, wsId, [txId]);

    // Poll until the service has loaded and started its LLM request.
    // The mock queue being empty means the service already popped the pending
    // promise from the queue.
    for (let i = 0; i < 50; i++) {
      if (geminiMock.generateContent.length === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Now simulate the concurrent manual categorize firing while service is blocked.
    // Update the transaction's merchantNormalized and the allocation.
    await prisma.transaction.update({
      where: { id: txId },
      data: { merchantNormalized: "loblaws" },
    });
    await prisma.transactionAllocation.updateMany({
      where: { transactionId: txId },
      data: { categoryId: diningId, source: "manual" },
    });

    // Resolve the LLM with a Groceries result for the same tx.
    geminiResolve({ results: [{ tx_id: txId, category: "Groceries" }] });
    await servicePromise;

    // The service's updateMany WHERE categoryId IS NULL AND source IS NULL must have
    // skipped this tx (allocation is now 'manual'). Manual categorization is preserved.
    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.categoryId).toBe(diningId);              // manual survived
    expect(afterAlloc?.source).toBe("manual");                  // NOT overwritten to 'ai'
    expect(afterAlloc?.categoryId).not.toBe(groceriesId);
  });

  it("workspace-scoped category resolution: two workspaces with same category name", async () => {
    const { wsId: wsA, accountId: acctA } = await setupWorkspaceWithAccount();
    const { wsId: _wsB } = await setupWorkspaceWithAccount();
    // Both workspaces already have "Groceries" seeded by bootstrap — no createMany needed.
    const txId = await makeTx(wsA, acctA, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsA, [txId]);

    const wsAGroceries = await categoryId(wsA, "Groceries");
    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.categoryId).toBe(wsAGroceries); // workspace A's Groceries, NOT workspace B's
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

    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.categoryId).toBeNull(); // stays uncategorized
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

    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.source).toBe("ai"); // mapping skipped, LLM ran
    expect(afterAlloc?.categoryId).toBe(await categoryId(wsId, "Other"));
  });

  it("LLM case-insensitive category match: 'groceries' lower matches 'Groceries' stored", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "groceries" }] }); // lowercase

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } }))?.categoryId).toBe(
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

    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(afterAlloc?.source).toBe("ai");

    // No mapping must have been created.
    const mappings = await prisma.merchantMapping.count({ where: { workspaceId: wsId } });
    expect(mappings).toBe(0);
  });

  it("mapping application writes a single allocation with source=mapping", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "wendys", categoryId: diningId, source: "manual" },
    });
    const txId = await makeTx(wsId, accountId, "Wendys", "alloc-mapping");

    await categorizeNewTransactions(env, wsId, [txId]);

    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(diningId);
    expect(allocs[0]!.source).toBe("mapping");
  });

  it("LLM result writes a single allocation with source=ai", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const txId = await makeTx(wsId, accountId, "Loblaws", "alloc-ai");

    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });
    await categorizeNewTransactions(env, wsId, [txId]);

    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.source).toBe("ai");
    expect(allocs[0]!.categoryId).toBe(await categoryId(wsId, "Groceries"));
  });

  it("split tx (N≥2) is NOT clobbered by auto-categorize", async () => {
    // Set up a tx with 2 manual allocations — must not be touched by auto-categorize.
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-noclobber" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-noclobber" } });
    // Create a merchant mapping for the same merchant to ensure mapping path would fire if not guarded.
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "splitmerch", categoryId: c1.id, source: "manual" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        amount: "10",
        merchantRaw: "SplitMerch",
        merchantNormalized: "splitmerch",
        occurredAt: new Date("2026-05-10"),
        pending: false,
        rawData: {},
        plaidTransactionId: `p-noclobber-${Date.now()}`,
      },
    });
    // Remove any auto-seeded allocation then add 2 manual ones.
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: c1.id, amount: "4", source: "manual" },
        { transactionId: tx.id, categoryId: c2.id, amount: "6", source: "manual" },
      ],
    });

    // Even with a matching mapping + LLM result, the split tx must not be touched.
    geminiMock.generateContent.push({ results: [{ tx_id: tx.id, category: "C1-noclobber" }] });
    await categorizeNewTransactions(env, wsId, [tx.id]);

    const after = await prisma.transactionAllocation.findMany({ where: { transactionId: tx.id } });
    expect(after).toHaveLength(2);
    expect(after.every((a) => a.source === "manual")).toBe(true);
  });
});

describe("categorize pipeline — history step + needsConfirmation + PFC", () => {
  /** Helper to create a tx + single allocation already categorized (history prior). */
  async function makePriorTx(
    wsId: string,
    accountId: string,
    merchantNormalized: string,
    categoryId: string,
    opts: {
      occurredAt?: Date;
      needsConfirmation?: boolean;
      dismissedUntil?: Date | null;
      source?: "manual" | "ai" | "history" | "mapping";
    } = {},
  ): Promise<string> {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidTransactionId: `prior_${merchantNormalized}_${Math.random().toString(36).slice(2, 8)}`,
        amount: "10",
        merchantRaw: merchantNormalized,
        merchantNormalized,
        occurredAt: opts.occurredAt ?? new Date("2026-05-01"),
        rawData: {},
      },
    });
    // Remove any auto-seeded allocation, then create a definite one with categoryId set.
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId,
        amount: "10",
        source: opts.source ?? "manual",
        needsConfirmation: opts.needsConfirmation ?? false,
        dismissedUntil: opts.dismissedUntil ?? null,
      },
    });
    return tx.id;
  }

  it("history step hits with prior_unconfirmed=true and mode='strict' → new alloc needsConfirmation=true, source='history'", async () => {
    const { wsId, accountId, userId } = await setupWorkspaceWithAccount();
    await prisma.user.update({ where: { id: userId }, data: { categorizationMode: "strict" } });
    const groceriesId = await categoryId(wsId, "Groceries");

    // Prior history hit with needsConfirmation=true.
    await makePriorTx(wsId, accountId, "loblaws", groceriesId, { needsConfirmation: true });

    const newTxId = await makeTx(wsId, accountId, "Loblaws", "new-1");
    // Force merchantNormalized to match (normalizeMerchant("Loblaws") → "loblaws").
    await prisma.transaction.update({ where: { id: newTxId }, data: { merchantNormalized: "loblaws" } });

    // No LLM mock response — history should resolve it.
    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("history");
    expect(alloc.categoryId).toBe(groceriesId);
    expect(alloc.needsConfirmation).toBe(true);
  });

  it("history step hits with prior dismissedUntil > now → new alloc inherits dismissedUntil", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const groceriesId = await categoryId(wsId, "Groceries");
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await makePriorTx(wsId, accountId, "loblaws", groceriesId, {
      needsConfirmation: true,
      dismissedUntil: future,
    });

    const newTxId = await makeTx(wsId, accountId, "Loblaws", "new-2");
    await prisma.transaction.update({ where: { id: newTxId }, data: { merchantNormalized: "loblaws" } });

    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("history");
    expect(alloc.dismissedUntil).not.toBeNull();
    expect(alloc.dismissedUntil!.getTime()).toBe(future.getTime());
  });

  it("history step prior categoryId IS NULL → no history match; falls through to LLM", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();

    // Prior tx with null-cat allocation (uncategorized) — not a valid history hint.
    const priorTx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidTransactionId: `prior_null_${Date.now()}`,
        amount: "10",
        merchantRaw: "Loblaws",
        merchantNormalized: "loblaws",
        occurredAt: new Date("2026-05-01"),
        rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: priorTx.id } });
    await prisma.transactionAllocation.create({
      data: { transactionId: priorTx.id, categoryId: null, amount: "10", source: null },
    });

    const newTxId = await makeTx(wsId, accountId, "Loblaws", "new-3");
    await prisma.transaction.update({ where: { id: newTxId }, data: { merchantNormalized: "loblaws" } });

    geminiMock.generateContent.push({ results: [{ tx_id: newTxId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("ai");
    expect(alloc.categoryId).toBe(await categoryId(wsId, "Groceries"));
  });

  it("history step prior category archived → falls through to LLM", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const groceriesId = await categoryId(wsId, "Groceries");
    const diningId = await categoryId(wsId, "Dining");

    await makePriorTx(wsId, accountId, "loblaws", diningId);

    // Archive Dining after the prior tx was assigned.
    await prisma.category.update({ where: { id: diningId }, data: { archivedAt: new Date() } });

    const newTxId = await makeTx(wsId, accountId, "Loblaws", "new-4");
    await prisma.transaction.update({ where: { id: newTxId }, data: { merchantNormalized: "loblaws" } });

    geminiMock.generateContent.push({ results: [{ tx_id: newTxId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("ai");
    expect(alloc.categoryId).toBe(groceriesId);
  });

  it("LLM result 'Other' + mode='auto' → needsConfirmation=true (Other override)", async () => {
    const { wsId, accountId, userId } = await setupWorkspaceWithAccount();
    await prisma.user.update({ where: { id: userId }, data: { categorizationMode: "auto" } });
    const otherId = await categoryId(wsId, "Other");

    const newTxId = await makeTx(wsId, accountId, "WeirdShop", "ai-other");
    geminiMock.generateContent.push({ results: [{ tx_id: newTxId, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("ai");
    expect(alloc.categoryId).toBe(otherId);
    expect(alloc.needsConfirmation).toBe(true);
  });

  it("historical Plaid import before item creation does not need review", async () => {
    const { wsId, userId } = await setupWorkspaceWithAccount();
    await prisma.user.update({ where: { id: userId }, data: { categorizationMode: "auto" } });
    const otherId = await categoryId(wsId, "Other");
    const { plaidItemId, accountId } = await makePlaidItemAndAccount(
      wsId,
      new Date("2026-06-15T00:00:00Z"),
    );
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidItemId,
        plaidTransactionId: `historical_${Date.now()}`,
        amount: "10",
        merchantRaw: "Mystery Historical",
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: null, amount: "10", source: null },
    });
    geminiMock.generateContent.push({ results: [{ tx_id: tx.id, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [tx.id]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: tx.id } });
    expect(alloc.source).toBe("ai");
    expect(alloc.categoryId).toBe(otherId);
    expect(alloc.needsConfirmation).toBe(false);
  });

  it("LLM result non-Other + mode='auto' → needsConfirmation=false", async () => {
    const { wsId, accountId, userId } = await setupWorkspaceWithAccount();
    await prisma.user.update({ where: { id: userId }, data: { categorizationMode: "auto" } });

    const newTxId = await makeTx(wsId, accountId, "Loblaws", "ai-nonother");
    geminiMock.generateContent.push({ results: [{ tx_id: newTxId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsId, [newTxId]);

    const alloc = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: newTxId } });
    expect(alloc.source).toBe("ai");
    expect(alloc.needsConfirmation).toBe(false);
  });

  it("split tx (allocations.length=2) → pipeline skips, needsConfirmation stays default false", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    const c1 = await categoryId(wsId, "Groceries");
    const c2 = await categoryId(wsId, "Dining");

    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidTransactionId: `split-needsconf-${Date.now()}`,
        amount: "10",
        merchantRaw: "SplitMerch",
        merchantNormalized: "splitmerch",
        occurredAt: new Date("2026-05-10"),
        rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: c1, amount: "4", source: "manual", needsConfirmation: false },
        { transactionId: tx.id, categoryId: c2, amount: "6", source: "manual", needsConfirmation: false },
      ],
    });

    await categorizeNewTransactions(env, wsId, [tx.id]);

    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: tx.id } });
    expect(allocs).toHaveLength(2);
    for (const a of allocs) {
      expect(a.source).toBe("manual");
      expect(a.needsConfirmation).toBe(false);
    }
  });

  it("PFC present in rawData → lastLlmCategorizeRequest() shows plaid_hint for that tx", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();

    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidTransactionId: `pfc-present-${Date.now()}`,
        amount: "10",
        merchantRaw: "SomeShop",
        occurredAt: new Date("2026-05-10"),
        rawData: {
          personal_finance_category: {
            primary: "FOOD_AND_DRINK",
            detailed: "FOOD_AND_DRINK_RESTAURANT",
            confidence_level: "HIGH",
          },
        },
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: null, amount: "10", source: null },
    });

    geminiMock.generateContent.push({ results: [{ tx_id: tx.id, category: "Dining" }] });

    await categorizeNewTransactions(env, wsId, [tx.id]);

    const req = lastLlmCategorizeRequest() as {
      transactions: Array<{ tx_id: string; plaid_hint?: { primary: string; detailed: string; confidence: string } }>;
    } | null;
    expect(req).not.toBeNull();
    const found = req!.transactions.find((t) => t.tx_id === tx.id);
    expect(found).toBeDefined();
    expect(found!.plaid_hint).toEqual({
      primary: "FOOD_AND_DRINK",
      detailed: "FOOD_AND_DRINK_RESTAURANT",
      confidence: "HIGH",
    });
  });

  it("PFC absent → lastLlmCategorizeRequest() does NOT show plaid_hint for that tx, no throw", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();

    const txId = await makeTx(wsId, accountId, "PlainShop", "pfc-absent");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const req = lastLlmCategorizeRequest() as {
      transactions: Array<{ tx_id: string; plaid_hint?: unknown }>;
    } | null;
    expect(req).not.toBeNull();
    const found = req!.transactions.find((t) => t.tx_id === txId);
    expect(found).toBeDefined();
    expect(found!.plaid_hint).toBeUndefined();
  });
});
