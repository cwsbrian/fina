/**
 * E2E — Plan 1C-audit. Real Gemini API call. Verifies that write-tool
 * executions (both direct chat path and intent-consume path) produce
 * `audit_events` rows in the DB with the correct actorType, action, and
 * target metadata.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-audit"
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

async function pollAuditRow(wsId: string, action: string, maxMs = 5000): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const row = psql(
      `SELECT "actorType" || '|' || "action" || '|' || COALESCE("targetType", 'null')
       FROM audit_events WHERE "workspaceId" = '${wsId}' AND action = '${action}'
       ORDER BY "createdAt" DESC LIMIT 1`,
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Audit row for action='${action}' never appeared in ${maxMs}ms`);
}

test.describe.configure({ mode: "serial" });

test.describe("plan 1c-audit — real Gemini, audit event creation", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => {
    await new Promise((r) => setTimeout(r, GEMINI_PACE_MS));
  });
  test.setTimeout(120_000);
  test.use({ actionTimeout: 60_000 });

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Audit%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-audit.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("direct chat write → audit row actorType=agent", async ({ page }) => {
    const email = `au-${Date.now()}@e2e-audit.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Audit" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const threadRes = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Audit test" },
    });
    const threadId = (await threadRes.json()).thread.id as string;

    // Unambiguous createCategory prompt (direct execution, no confirm card).
    const res = await page.request.post(
      `${API}/workspaces/${wsId}/chat/threads/${threadId}/messages`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { text: "카테고리 만들어줘 — AuditCoffee 라는 이름으로" },
      },
    );
    expect(res.ok()).toBe(true);
    const body = await res.json() as { toolCalls: Array<{ toolName: string }> };
    expect(body.toolCalls.map((t) => t.toolName)).toContain("createCategory");

    // Poll for the audit row (fire-and-forget — may arrive slightly after response).
    const row = await pollAuditRow(wsId, "createCategory");
    const [actorType, action, targetType] = row.split("|");
    expect(actorType).toBe("agent");
    expect(action).toBe("createCategory");
    expect(targetType).toBe("category");
  });
});
