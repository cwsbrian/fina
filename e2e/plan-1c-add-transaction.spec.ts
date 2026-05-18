/**
 * E2E — Plan 1C-add-transaction. No Gemini needed (HTTP-only feature).
 * Covers:
 * 1. Free-tier user: POST 201 happy path, auto-creates Cash account
 * 2. Fractional-cent input: POST 400 invalid_amount
 * 3. Reuse Cash account on second POST
 *
 * Run:
 *   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-add-transaction"
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

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

test.describe.configure({ mode: "serial" });

test.describe("plan 1c-add-transaction — manual HTTP route", () => {
  test.skip(!HAS_DB, "Requires DB");
  test.setTimeout(30_000);

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E AddTx%' OR id IN (SELECT "workspaceId" FROM memberships WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@e2e-addtx.test'))`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-addtx.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("Free-tier user adds manual transaction → 201 + auto Cash account", async ({ page }) => {
    const email = `at-${Date.now()}@e2e-addtx.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E AddTx" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Force Free tier
    psql(`UPDATE users SET "trialEndsAt" = NOW() - INTERVAL '1 day', "trialConsumed" = true WHERE id = '${userId}'`);

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/manual`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { merchantRaw: "Starbucks Yonge", amount: 6.75, occurredAt: "2026-05-17" },
      },
    );
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      transaction: { source: string; merchantNormalized: string; currency: string; accountId: string };
    };
    expect(body.transaction.source).toBe("manual");
    expect(body.transaction.merchantNormalized).toBe("starbucks yonge");
    expect(body.transaction.currency).toBe("CAD");

    // Verify Cash account was auto-created
    const acctRow = psql(
      `SELECT name || '|' || type || '|' || COALESCE("plaidItemId", 'null') || '|' || COALESCE("plaidAccountId", 'null')
       FROM bank_accounts WHERE "workspaceId" = '${wsId}'`,
    );
    expect(acctRow).toBe("Cash|depository|null|null");
  });

  test("Fractional-cent amount → 400 invalid_amount", async ({ page }) => {
    const email = `frac-${Date.now()}@e2e-addtx.test`;
    await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Frac" },
      headers: { "content-type": "application/json" },
    });
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    const res = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/manual`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { merchantRaw: "X", amount: 0.004 },
      },
    );
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_amount" });
  });

  test("Two manual transactions reuse the same Cash account", async ({ page }) => {
    const email = `reuse-${Date.now()}@e2e-addtx.test`;
    await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Reuse" },
      headers: { "content-type": "application/json" },
    });
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    const r1 = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/manual`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" },
      },
    );
    const r2 = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/manual`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" },
      },
    );
    expect(r1.status()).toBe(201);
    expect(r2.status()).toBe(201);
    const a1 = ((await r1.json()) as { transaction: { accountId: string } }).transaction.accountId;
    const a2 = ((await r2.json()) as { transaction: { accountId: string } }).transaction.accountId;
    expect(a1).toBe(a2);
    const cashCount = psql(
      `SELECT count(*)::text FROM bank_accounts WHERE "workspaceId" = '${wsId}' AND "plaidItemId" IS NULL AND "plaidAccountId" IS NULL AND "archivedAt" IS NULL`,
    );
    expect(cashCount).toBe("1");
  });
});
