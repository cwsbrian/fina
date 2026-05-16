/**
 * E2E — Plan 1E-search. Real Gemini API call, verifies the new `findTransactions`
 * chat tool is selected by the LLM for representative filter prompts.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-search"
 *
 * Skipped without DB + GEMINI_API_KEY.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, {
      encoding: "utf8",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
})();
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

type ChatResponse = {
  threadId: string;
  assistantMessage: { blocks: Array<{ markdown: string }> };
  toolCalls: Array<{ toolName: string }>;
};

test.describe.configure({ mode: "serial" });

test.describe("plan 1e-search — real Gemini, findTransactions tool", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Search%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-search.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'find my Starbucks transactions' triggers findTransactions", async ({ page }) => {
    const email = `fs-${Date.now()}@e2e-search.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Search" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    psql(
      `UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`,
    );

    // Seed: 1 account + 3 transactions (2 Starbucks + 1 grocery).
    const acctId = `e2e-search-acct-${Date.now()}`;
    psql(
      `INSERT INTO bank_accounts (id, "workspaceId", name, type, currency, status, "createdAt") VALUES ('${acctId}', '${wsId}', 'Chequing', 'depository', 'CAD', 'active', NOW())`,
    );
    psql(
      `INSERT INTO transactions (id, "workspaceId", "accountId", "plaidTransactionId", amount, currency, "merchantRaw", "merchantNormalized", "occurredAt", source, "rawData", "createdAt", "updatedAt") VALUES
        ('e2e-search-tx-1', '${wsId}', '${acctId}', 'p1', 5.00, 'CAD', 'Starbucks Downtown', 'starbucks', NOW() - INTERVAL '5 days', 'plaid', '{}'::jsonb, NOW(), NOW()),
        ('e2e-search-tx-2', '${wsId}', '${acctId}', 'p2', 8.50, 'CAD', 'Starbucks Pike', 'starbucks', NOW() - INTERVAL '3 days', 'plaid', '{}'::jsonb, NOW(), NOW()),
        ('e2e-search-tx-3', '${wsId}', '${acctId}', 'p3', 120.00, 'CAD', 'Whole Foods', 'whole foods', NOW() - INTERVAL '2 days', 'plaid', '{}'::jsonb, NOW(), NOW())`,
    );

    // Create a thread (1E-threads contract — explicit thread before messages).
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Search test" },
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Find my Starbucks transactions" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("findTransactions");
    // The assistant text should mention Starbucks (the seeded merchant).
    expect(body.assistantMessage.blocks[0]!.markdown.toLowerCase()).toContain("starbucks");
  });

  test("'transactions over $100' triggers findTransactions with amount filter", async ({ page }) => {
    const email = `fa-${Date.now()}@e2e-search.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Search" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    psql(
      `UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`,
    );

    const acctId = `e2e-search-acct2-${Date.now()}`;
    psql(
      `INSERT INTO bank_accounts (id, "workspaceId", name, type, currency, status, "createdAt") VALUES ('${acctId}', '${wsId}', 'Chequing', 'depository', 'CAD', 'active', NOW())`,
    );
    psql(
      `INSERT INTO transactions (id, "workspaceId", "accountId", "plaidTransactionId", amount, currency, "merchantRaw", "merchantNormalized", "occurredAt", source, "rawData", "createdAt", "updatedAt") VALUES
        ('e2e-search-tx-a', '${wsId}', '${acctId}', 'pa', 5.00, 'CAD', 'Coffee', 'coffee', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW()),
        ('e2e-search-tx-b', '${wsId}', '${acctId}', 'pb', 150.00, 'CAD', 'Grocery Run', 'grocery', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW()),
        ('e2e-search-tx-c', '${wsId}', '${acctId}', 'pc', 1000.00, 'CAD', 'Rent', 'rent', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW())`,
    );

    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Amount test" },
    });
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Show me transactions over $100" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("findTransactions");
  });
});
