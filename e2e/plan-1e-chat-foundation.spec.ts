/**
 * E2E — Plan 1E-chat-foundation. Real Gemini API call.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-chat-foundation"
 *
 * Skipped without GEMINI_API_KEY (CI without secrets).
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, {
      encoding: "utf8", timeout: 5_000,
    });
    return true;
  } catch { return false; }
})();
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

test.describe("plan 1e-chat-foundation — real Gemini", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Chat%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-chat.test'`);
    } catch { /* ignore */ }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("Pro user: 'list my transactions' triggers listTransactions tool call", async ({ page }) => {
    const email = `tx-${Date.now()}@e2e-chat.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Chat" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const { workspaces } = await wsRes.json() as { workspaces: { id: string }[] };
    const wsId = workspaces[0].id;

    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const res = await page.request.post(`${API}/workspaces/${wsId}/chat/message`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "List my recent transactions" },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json() as {
      assistantMessage: { blocks: Array<{ markdown: string }> };
      toolCalls: Array<{ toolName: string }>;
    };
    expect(body.assistantMessage.blocks[0].markdown.length).toBeGreaterThan(0);
    expect(body.toolCalls.map((t) => t.toolName)).toContain("listTransactions");
  });

  test("'spending summary this month' triggers getSpendingSummary", async ({ page }) => {
    const email = `sum-${Date.now()}@e2e-chat.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Chat" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const { workspaces } = await wsRes.json() as { workspaces: { id: string }[] };
    const wsId = workspaces[0].id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const res = await page.request.post(`${API}/workspaces/${wsId}/chat/message`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "What's my total spending this month?" },
    });
    expect(res.ok()).toBe(true);
    const body = await res.json() as { toolCalls: Array<{ toolName: string }> };
    expect(body.toolCalls.map((t) => t.toolName)).toContain("getSpendingSummary");
  });
});
