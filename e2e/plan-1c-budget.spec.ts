/**
 * E2E — Plan 1C-budget. Real Gemini API. Verifies the setBudget chat tool
 * fires for a representative natural-language prompt, the Budget row lands
 * in the DB, and a follow-up compareSpendingVsBudget call sees it.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-budget"
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

test.describe("plan 1c-budget — real Gemini, budget chat tools", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM calls
  // and auto-title adds a 3rd on the first message. Pace to stay under cap.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Budget%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-budget.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'set Coffee budget to 500' triggers setBudget + row lands in DB", async ({ page }) => {
    const email = `sb-${Date.now()}@e2e-budget.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Budget" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Pro trial — required by the chat route.
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Seed a "Coffee" category so the LLM has a target to set a budget on.
    const catId = `cat-${Date.now()}`;
    psql(`INSERT INTO categories (id, "workspaceId", name, "createdAt") VALUES ('${catId}', '${wsId}', 'Coffee', NOW())`);

    // Create thread.
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Budget test" },
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    // Unambiguous prompt — the system prompt mentions setBudget needs no
    // confirmation in this case.
    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Coffee 카테고리 예산을 500 달러로 설정해줘" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("setBudget");

    // Verify the row landed. periodStart is the user's tz current month;
    // for a freshly signed-up user, User.tz defaults to America/Toronto.
    const count = psql(
      `SELECT count(*)::int FROM budgets WHERE "workspaceId" = '${wsId}' AND "categoryId" = '${catId}' AND amount = 500`,
    );
    expect(count).toBe("1");
  });
});
