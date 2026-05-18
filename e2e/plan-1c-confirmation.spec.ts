/**
 * E2E — Plan 1C-confirmation. Real Gemini API call. Verifies the full
 * 2-phase commit flow end-to-end:
 *
 *   1. LLM calls `presentConfirmCard` for a destructive operation (removeRecurring)
 *      instead of executing directly.
 *   2. The response's `assistantMessage.blocks` contains a `confirm_card` block
 *      with a valid `acceptIntent` id.
 *   3. Consuming the intent via `POST /intents/:id/consume` executes the action
 *      and returns the tool result.
 *   4. The DB reflects the executed action (recurring expense removed).
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-confirmation"
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

type Block = { type: string; [key: string]: unknown };
type ChatResponse = {
  threadId: string;
  assistantMessage: { blocks: Block[] };
  toolCalls: Array<{ toolName: string; args: Record<string, unknown>; result: unknown }>;
};

test.describe.configure({ mode: "serial" });

test.describe("plan 1c-confirmation — real Gemini, confirm-card + consume flow", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(120_000);
  test.use({ actionTimeout: 60_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Confirmation%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-confirmation.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("'Netflix 정기지출 삭제' triggers presentConfirmCard → consume → removeRecurring executes", async ({ page }) => {
    const email = `cf-${Date.now()}@e2e-confirmation.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Confirmation" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Pro trial.
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // Seed a Netflix recurring expense (unambiguous target for removeRecurring).
    const addRes = await page.request.post(`${API}/workspaces/${wsId}/recurring`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
    });
    expect(addRes.status()).toBe(201);
    const { recurring: { id: recurringId } } = (await addRes.json()) as { recurring: { id: string } };

    // Create thread + ask to delete Netflix (destructive → system prompt says use presentConfirmCard).
    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Confirmation test" },
    });
    const threadId = (await threadRes.json()).thread.id as string;

    const chatRes = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "Netflix 정기지출 삭제해줘" },
      },
    );
    expect(chatRes.ok()).toBe(true);
    const body = (await chatRes.json()) as ChatResponse;

    // LLM should call presentConfirmCard (not removeRecurring directly).
    const toolNames = body.toolCalls.map((t) => t.toolName);
    expect(toolNames).toContain("presentConfirmCard");
    expect(toolNames).not.toContain("removeRecurring");

    // assistantMessage.blocks should contain a confirm_card with acceptIntent.
    const confirmBlock = body.assistantMessage.blocks.find(
      (b) => b.type === "confirm_card",
    ) as (Block & { acceptIntent?: string }) | undefined;
    expect(confirmBlock).toBeDefined();
    const intentId = confirmBlock!.acceptIntent;
    expect(intentId).toBeTruthy();

    // The recurring expense still exists (action not yet executed).
    const beforeConsume = psql(
      `SELECT count(*)::int FROM recurring_expenses WHERE id = '${recurringId}'`,
    );
    expect(beforeConsume).toBe("1");

    // CONSUME the intent — this should execute removeRecurring.
    const consumeRes = await page.request.post(
      `${API}/workspaces/${wsId}/intents/${intentId}/consume`,
      { headers: { "x-workspace-id": wsId, "content-type": "application/json" } },
    );
    expect(consumeRes.ok()).toBe(true);
    const consumeBody = (await consumeRes.json()) as { result: { removed: boolean } };
    expect(consumeBody.result.removed).toBe(true);

    // The recurring expense is now removed from the DB.
    const afterConsume = psql(
      `SELECT count(*)::int FROM recurring_expenses WHERE id = '${recurringId}'`,
    );
    expect(afterConsume).toBe("0");
  });
});
