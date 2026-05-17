/**
 * E2E — Plan 1E-title. Real Gemini call. Verifies that POSTing the first
 * user message to a thread (created with title=null) triggers the async
 * `generateAndPersistThreadTitle` orchestrator, and that the title appears
 * in the DB within a bounded poll window after the chat response returns.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-title"
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

async function pollTitle(threadId: string, timeoutMs = 12_000, intervalMs = 500): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = psql(`SELECT COALESCE(title, '__NULL__') FROM chat_threads WHERE id = '${threadId}'`);
    if (t && t !== "__NULL__") return t;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test.describe.configure({ mode: "serial" });

test.describe("plan 1e-title — real Gemini, async title generation", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM calls
  // and auto-title adds a 3rd. Pace tests to stay under the per-minute cap.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(90_000);
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Title%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-title.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("first user message → auto-generated title persists within a few seconds", async ({ page }) => {
    const email = `at-${Date.now()}@e2e-title.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Title" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Pro trial — auto-title only fires for Pro users (route gate).
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Create thread with NO title.
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: {},
    });
    expect(threadRes.status()).toBe(201);
    const threadId = (await threadRes.json()).thread.id as string;

    // Sanity: title is NULL before the first message.
    const before = psql(`SELECT COALESCE(title, '__NULL__') FROM chat_threads WHERE id = '${threadId}'`);
    expect(before).toBe("__NULL__");

    // Send the first user message. The chat response returns immediately;
    // the title is generated async and lands in the DB seconds later.
    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Coffee 카테고리 만들어줘" },
      },
    );
    expect(res.ok()).toBe(true);

    // Poll the DB for the title to land.
    const title = await pollTitle(threadId, 12_000, 500);
    expect(title).not.toBeNull();
    expect(title!.length).toBeGreaterThan(0);
    expect(title!.length).toBeLessThanOrEqual(200);
  });
});
