/**
 * E2E — Plan 1E-threads. Real Gemini API call.
 *
 * Verifies multi-thread isolation: two threads in the same workspace each get
 * their own conversation, archive blocks message-send but preserves read access.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-threads"
 *
 * Skipped without DB + GEMINI_API_KEY.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, { encoding: "utf8", timeout: 5_000 });
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

test.describe.configure({ mode: "serial" });

test.describe("plan 1e-threads — real Gemini, multi-thread isolation", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Gemini free tier: 10 req/min, 20 req/day. Each turn ≈ 2 LLM calls.
  // Pace tests to stay under the per-minute cap when chaining cases.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => { await new Promise((r) => setTimeout(r, GEMINI_PACE_MS)); });
  test.setTimeout(90_000);

  // Chat turns can easily exceed playwright.config's 8s actionTimeout default
  // because each turn waits on Gemini. Bump per-request timeout for this spec.
  test.use({ actionTimeout: 45_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Threads%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-threads.test'`);
    } catch { /* ignore */ }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("two threads in one workspace stay isolated", async ({ page }) => {
    const email = `mt-${Date.now()}@e2e-threads.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Threads" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0].id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const createA = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Thread A" },
    });
    expect(createA.status()).toBe(201);
    const threadAId = (await createA.json()).thread.id as string;

    const createB = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Thread B" },
    });
    expect(createB.status()).toBe(201);
    const threadBId = (await createB.json()).thread.id as string;

    const msgA = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${threadAId}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "Remember the codeword PINEAPPLE" },
    });
    expect(msgA.ok()).toBe(true);

    const msgB = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${threadBId}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "What's the codeword I gave you?" },
    });
    expect(msgB.ok()).toBe(true);
    const bBody = await msgB.json();
    const bText = (bBody.assistantMessage.blocks[0].markdown as string).toLowerCase();
    // Thread B has no PINEAPPLE in its history; the assistant should not echo it.
    expect(bText.includes("pineapple")).toBe(false);

    const list = await page.request.get(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId },
    });
    const titles = (await list.json()).threads.map((t: { title: string }) => t.title);
    expect(titles.sort()).toEqual(["Thread A", "Thread B"]);
  });

  test("archived thread blocks message-send but stays readable", async ({ page }) => {
    const email = `ar-${Date.now()}@e2e-threads.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Threads" },
      headers: { "content-type": "application/json" },
    });
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0].id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const create = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Doomed" },
    });
    const tid = (await create.json()).thread.id as string;

    const firstMsg = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${tid}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "say hi" },
    });
    expect(firstMsg.ok()).toBe(true);

    const del = await page.request.delete(`${API}/workspaces/${wsId}/chat/threads/${tid}`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(del.status()).toBe(204);

    const blockedMsg = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${tid}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "after archive" },
    });
    expect(blockedMsg.status()).toBe(404);

    const detail = await page.request.get(`${API}/workspaces/${wsId}/chat/threads/${tid}`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.thread.archivedAt).not.toBeNull();
    expect(body.messages.length).toBeGreaterThan(0);
  });
});
