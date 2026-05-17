/**
 * E2E — Plan 1C-merchant-map. Real Gemini API call. Verifies the
 * `mapMerchantToCategory` chat tool fires for a representative natural-
 * language prompt, the MerchantMapping row is created, and a null-
 * categoryId transaction with `merchantNormalized = NULL` is backfilled
 * end-to-end (covering the two-stage normalize + assign path).
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-merchant-map"
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
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>;
};

test.describe.configure({ mode: "serial" });

test.describe("plan 1c-merchant-map — real Gemini, mapMerchantToCategory tool", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Merchant Map%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-mmap.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'Starbucks를 Coffee로 자동분류' triggers mapMerchantToCategory + backfills NULL-merchantNormalized tx", async ({ page }) => {
    const email = `mm-${Date.now()}@e2e-mmap.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Merchant Map" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Pro trial — required by the chat route.
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Seed "Coffee" category + a Plaid-style transaction with NULL
    // merchantNormalized + null categoryId. The service should:
    //   1. Normalize the row (Plaid raw "STARBUCKS #1234 TORONTO ON" → "starbucks")
    //   2. Assign categoryId + categorizationSource = "mapping".
    const catId = `cat-${Date.now()}`;
    psql(`INSERT INTO categories (id, "workspaceId", name, "createdAt") VALUES ('${catId}', '${wsId}', 'Coffee', NOW())`);
    const acctId = `acct-${Date.now()}`;
    psql(`INSERT INTO bank_accounts (id, "workspaceId", name, type, currency, status, "createdAt") VALUES ('${acctId}', '${wsId}', 'Chequing', 'depository', 'CAD', 'active', NOW())`);
    const txId = `tx-${Date.now()}`;
    psql(`INSERT INTO transactions (id, "workspaceId", "accountId", "plaidTransactionId", amount, currency, "merchantRaw", "merchantNormalized", "categoryId", "occurredAt", source, "rawData", "createdAt", "updatedAt") VALUES ('${txId}', '${wsId}', '${acctId}', 'pl-1', 5.50, 'CAD', 'STARBUCKS #1234 TORONTO ON', NULL, NULL, NOW(), 'plaid', '{}'::jsonb, NOW(), NOW())`);

    // Chat thread + unambiguous prompt.
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Merchant map test" },
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Starbucks를 Coffee 카테고리로 자동분류해줘" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("mapMerchantToCategory");

    // Mapping row exists.
    const mappingCount = psql(
      `SELECT count(*)::int FROM merchant_mappings WHERE "workspaceId" = '${wsId}' AND "merchantNormalized" = 'starbucks' AND source = 'manual'`,
    );
    expect(mappingCount).toBe("1");

    // The seeded tx was backfilled: merchantNormalized + categoryId set.
    const txRow = psql(
      `SELECT COALESCE("merchantNormalized", '__NULL__') || '|' || COALESCE("categoryId", '__NULL__') || '|' || COALESCE("categorizationSource"::text, '__NULL__') FROM transactions WHERE id = '${txId}'`,
    );
    expect(txRow).toBe(`starbucks|${catId}|mapping`);
  });
});
