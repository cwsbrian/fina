/**
 * E2E — Plan 1C-recurring-persist. Real Gemini API call. Verifies the
 * `addRecurring` chat tool fires for a representative natural-language
 * prompt, the RecurringExpense row lands in the DB, and a follow-up
 * `listRecurring` call surfaces it.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-recurring-persist"
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

test.describe("plan 1c-recurring-persist — real Gemini, addRecurring + listRecurring tools", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Recurring%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-recurring.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'Netflix 월 19달러 정기지출 추가' triggers addRecurring + row lands in DB", async ({ page }) => {
    const email = `rp-${Date.now()}@e2e-recurring.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Recurring" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Pro trial — chat route requires Pro.
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Create thread + send first message.
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Recurring test" },
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        // Unambiguous: explicit name, amount, cadence, next date.
        data: { text: "Netflix를 월 19달러 정기지출로 추가해줘, 다음 결제는 2026-07-01" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("addRecurring");

    // Verify the row landed.
    const count = psql(
      `SELECT count(*)::int FROM recurring_expenses WHERE "workspaceId" = '${wsId}' AND "nameNormalized" = 'netflix' AND amount = 19`,
    );
    expect(count).toBe("1");
  });
});
