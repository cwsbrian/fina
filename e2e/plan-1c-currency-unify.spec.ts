/**
 * E2E — Plan 1C-currency-unify. No Gemini needed (HTTP only).
 * Covers:
 * 1. PATCH /workspaces/:id/currency happy: fresh workspace → 200 + currency updated
 * 2. PATCH 409 workspace_has_data after manual transaction posted
 * 3. addRecurring response.currency = workspace.currency (USD after PATCH)
 *
 * Plaid currency_mismatch is NOT covered here — it requires a US Plaid
 * sandbox bank, which the dev env doesn't reliably provide. The
 * integration tests in `apps/api/tests/plaid.routes.test.ts`
 * (mocked exchange) cover that path.
 *
 * Run:
 *   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-currency-unify"
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

test.describe("plan 1c-currency-unify — workspace currency boundary", () => {
  test.skip(!HAS_DB, "Requires DB");
  test.setTimeout(30_000);

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE id IN (SELECT "workspaceId" FROM memberships WHERE "userId" IN (SELECT id FROM users WHERE email LIKE '%@e2e-curr.test'))`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-curr.test'`);
    } catch {
      /* ignore */
    }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("PATCH currency on fresh workspace → 200; addRecurring then returns USD", async ({ page }) => {
    const email = `cu-${Date.now()}@e2e-curr.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Curr" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = (await sign.json()) as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Promote to Pro so addRecurring is allowed
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    // PATCH currency on fresh workspace → 200
    const patchRes = await page.request.patch(
      `${API}/workspaces/${wsId}/currency`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { currency: "USD" },
      },
    );
    expect(patchRes.status()).toBe(200);
    const patchBody = (await patchRes.json()) as { workspace: { currency: string } };
    expect(patchBody.workspace.currency).toBe("USD");
    // Verify in DB
    const wsCurrency = psql(`SELECT currency FROM workspaces WHERE id = '${wsId}'`);
    expect(wsCurrency).toBe("USD");

    // POST /recurring → response.currency should be USD (inherited from workspace)
    const recRes = await page.request.post(
      `${API}/workspaces/${wsId}/recurring`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: {
          name: "Netflix",
          amount: 19.99,
          cadence: "monthly",
          nextOccurrenceDate: "2026-08-01",
        },
      },
    );
    expect(recRes.status()).toBe(201);
    const recBody = (await recRes.json()) as {
      recurring: { currency: string; name: string };
    };
    expect(recBody.recurring.currency).toBe("USD");
  });

  test("PATCH currency → 409 workspace_has_data after a manual transaction exists", async ({ page }) => {
    const email = `cu2-${Date.now()}@e2e-curr.test`;
    await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Curr2" },
      headers: { "content-type": "application/json" },
    });
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    // Add a manual transaction → creates Cash bank_account + transaction
    const txRes = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/manual`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
      },
    );
    expect(txRes.status()).toBe(201);

    // PATCH currency → 409 workspace_has_data
    const patchRes = await page.request.patch(
      `${API}/workspaces/${wsId}/currency`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { currency: "USD" },
      },
    );
    expect(patchRes.status()).toBe(409);
    expect(await patchRes.json()).toEqual({ error: "workspace_has_data" });

    // workspace.currency unchanged
    const wsCurrency = psql(`SELECT currency FROM workspaces WHERE id = '${wsId}'`);
    expect(wsCurrency).toBe("CAD");
  });

  test("PATCH 400 invalid_body for non-3-letter currency", async ({ page }) => {
    const email = `cu3-${Date.now()}@e2e-curr.test`;
    await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Curr3" },
      headers: { "content-type": "application/json" },
    });
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

    for (const bad of ["us", "DOLLAR", "U$D"]) {
      const res = await page.request.patch(
        `${API}/workspaces/${wsId}/currency`,
        {
          headers: { "x-workspace-id": wsId, "content-type": "application/json" },
          data: { currency: bad },
        },
      );
      expect(res.status()).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_body" });
    }
  });
});
