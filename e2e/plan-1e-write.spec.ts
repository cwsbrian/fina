/**
 * E2E — Plan 1E-write. Real Gemini API call, verifies the two new write tools
 * (`createCategory`, `addTransactionNote`) are selected by the LLM for
 * representative prompts and that the resulting DB writes land.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-write"
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

test.describe("plan 1e-write — real Gemini, write tools", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Gemini free tier: 10 req/min, 20 req/day. Each chat turn ~2 LLM calls.
  // Pace tests to stay under the per-minute cap.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Write%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-write.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'create a Coffee category' triggers createCategory + persists the row", async ({ page }) => {
    const email = `cc-${Date.now()}@e2e-write.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Write" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Write test" },
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        // Unambiguous wording so the system-prompt-driven confirmation isn't triggered.
        data: { text: "카테고리 만들어줘 — Coffee 라는 이름으로" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("createCategory");

    // Confirm the row landed in the workspace.
    const created = psql(
      `SELECT count(*)::int FROM categories WHERE "workspaceId" = '${wsId}' AND lower(name) = 'coffee' AND "archivedAt" IS NULL`,
    );
    expect(created).toBe("1");
  });

  test("'add note to transaction X' triggers addTransactionNote + persists the note", async ({ page }) => {
    const email = `an-${Date.now()}@e2e-write.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Write" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Seed: 1 account + 1 transaction the LLM can refer to by id.
    const acctId = `e2e-write-acct-${Date.now()}`;
    const txId = `e2e-write-tx-${Date.now()}`;
    psql(
      `INSERT INTO bank_accounts (id, "workspaceId", name, type, currency, status, "createdAt") VALUES ('${acctId}', '${wsId}', 'Chequing', 'depository', 'CAD', 'active', NOW())`,
    );
    psql(
      `INSERT INTO transactions (id, "workspaceId", "accountId", "plaidTransactionId", amount, currency, "merchantRaw", "merchantNormalized", "occurredAt", source, "rawData", "createdAt", "updatedAt") VALUES ('${txId}', '${wsId}', '${acctId}', 'p1', 50.00, 'CAD', 'Dinner', 'dinner', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW())`,
    );

    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Note test" },
    });
    const threadId = (await threadRes.json()).thread.id as string;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        // Unambiguous: identifies the tx by id, gives explicit note text.
        data: { text: `Add a note to transaction ${txId}: paid by John` },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;
    expect(body.toolCalls.map((t) => t.toolName)).toContain("addTransactionNote");

    // Confirm the note landed.
    const note = psql(
      `SELECT note FROM transactions WHERE id = '${txId}'`,
    );
    expect(note.toLowerCase()).toContain("paid by john");
  });
});
