import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { findHistoryHints } from "../src/categorize/history-lookup.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function makeWs(): Promise<{ wsId: string; accountId: string }> {
  const app = await buildApp(testEnv());
  const u = await signUpAndGetCookie(app, { email: `hist-${Date.now()}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Acc", type: "depository" } });
  await app.close();
  return { wsId, accountId: acct.id };
}

async function makeCat(wsId: string, name: string, archived = false) {
  return prisma.category.create({
    data: { workspaceId: wsId, name, archivedAt: archived ? new Date() : null },
  });
}

async function makeTx(
  wsId: string,
  accountId: string,
  merchantNorm: string,
  occurredAt: Date,
  categoryId: string | null,
  opts?: { needsConfirmation?: boolean; dismissedUntil?: Date | null; removedAt?: Date | null }
): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: merchantNorm.toUpperCase(),
      merchantNormalized: merchantNorm,
      amount: "10.00",
      occurredAt,
      source: "plaid",
      rawData: {},
      removedAt: opts?.removedAt ?? null,
      allocations: {
        create: {
          amount: "10.00",
          categoryId,
          source: categoryId ? "ai" : null,
          needsConfirmation: opts?.needsConfirmation ?? false,
          dismissedUntil: opts?.dismissedUntil ?? null,
        },
      },
    },
  });
  return tx.id;
}

describe("findHistoryHints", () => {
  it("returns most recent categorized tx per merchant", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "HistDining");
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    await makeTx(wsId, accountId, "starbucks", older, cat.id);
    await makeTx(wsId, accountId, "starbucks", newer, cat.id, { needsConfirmation: true });
    const result = await findHistoryHints(wsId, ["starbucks"], "expense");
    const hint = result.get("starbucks");
    expect(hint?.categoryId).toBe(cat.id);
    expect(hint?.needsConfirmation).toBe(true);
  });

  it("skips removed transactions", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "HistDining");
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), cat.id, { removedAt: new Date() });
    const result = await findHistoryHints(wsId, ["starbucks"], "expense");
    expect(result.has("starbucks")).toBe(false);
  });

  it("skips uncategorized prior allocations", async () => {
    const { wsId, accountId } = await makeWs();
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), null);
    const result = await findHistoryHints(wsId, ["starbucks"], "expense");
    expect(result.has("starbucks")).toBe(false);
  });

  it("skips archived categories", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "HistDining", true);
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), cat.id);
    const result = await findHistoryHints(wsId, ["starbucks"], "expense");
    expect(result.has("starbucks")).toBe(false);
  });

  it("batch lookup for multiple merchants in one call", async () => {
    const { wsId, accountId } = await makeWs();
    const dining = await makeCat(wsId, "HistDining");
    const transit = await makeCat(wsId, "HistTransit");
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), dining.id);
    await makeTx(wsId, accountId, "uber", new Date("2026-02-01"), transit.id);
    const result = await findHistoryHints(wsId, ["starbucks", "uber", "newmerchant"], "expense");
    expect(result.size).toBe(2);
    expect(result.get("starbucks")?.categoryId).toBe(dining.id);
    expect(result.get("uber")?.categoryId).toBe(transit.id);
  });

  it("returns empty map for empty input", async () => {
    const result = await findHistoryHints("any-ws-id", [], "expense");
    expect(result.size).toBe(0);
  });
});
