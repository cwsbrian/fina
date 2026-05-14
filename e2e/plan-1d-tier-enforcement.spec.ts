/**
 * E2E tests — Plan 1D-tier-enforcement: Plaid connection limits + trial expiry
 *
 * Tests hit the API directly (no web proxy needed — same-origin cookies).
 * Skip guards per test group:
 *   - Limit checks: requires only a running API + DB (no Plaid creds)
 *   - Trial expiry Step 0: requires PLAID_CLIENT_ID + PLAID_SECRET for
 *     creating a real sandbox item with a properly-encrypted access token.
 *
 * Run:
 *   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1d-tier-enforcement"
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";

const API = process.env.API_URL ?? "http://localhost:4000";
const DB = process.env.DATABASE_URL ?? "postgresql://fina:fina@localhost:5433/fina";
const API_DIR = path.resolve(__dirname, "../apps/api");

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, {
      encoding: "utf8",
      timeout: 5_000,
    });
    return true;
  } catch { return false; }
})();

const HAS_PLAID = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

/** Sign up directly via API, returns the session cookie. */
async function apiSignUp(
  page: import("@playwright/test").Page,
  email: string,
): Promise<{ userId: string; wsId: string }> {
  const res = await page.request.post(`${API}/api/auth/sign-up/email`, {
    data: { email, password: "password-e2e-1234", name: "E2E Tier" },
    headers: { "content-type": "application/json" },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json() as { user: { id: string } };
  const userId = body.user.id;

  // Fetch workspace
  const wsRes = await page.request.get(`${API}/workspaces`);
  expect(wsRes.ok()).toBe(true);
  const wsBody = await wsRes.json() as { workspaces: { id: string }[] };
  const wsId = wsBody.workspaces[0].id;

  return { userId, wsId };
}

function runJob(jobModule: string, fn: string, extraEnv: Record<string, string> = {}): void {
  const script =
    `(async () => {\n` +
    `  const { ${fn} } = await import("./src/cron/jobs/${jobModule}.js");\n` +
    `  const { loadEnv } = await import("./src/env.js");\n` +
    `  await ${fn}(loadEnv());\n` +
    `})().catch(e => { console.error(e); process.exit(1); });\n`;
  const tmp = path.join(API_DIR, `_e2e_tier_${Date.now()}.ts`);
  writeFileSync(tmp, script, "utf8");
  try {
    execSync(`pnpm exec tsx ${path.basename(tmp)}`, {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: DB, ...extraEnv },
      timeout: 60_000,
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Group 1: Limit checks (no Plaid creds needed)
// ---------------------------------------------------------------------------

test.describe("plan 1d-tier-enforcement — limit checks", () => {
  test.skip(!HAS_DB, "Requires fina-postgres-dev");

  test.afterEach(async ({ page }) => {
    // Best-effort cleanup
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Tier%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-tier.test'`);
    } catch { /* ignore */ }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("expired trial → POST /link-token → 402 upgrade_required", async ({ page }) => {
    const email = `expired-${Date.now()}@e2e-tier.test`;
    const { userId, wsId } = await apiSignUp(page, email);

    // Expire trial
    psql(`UPDATE users SET "trialEndsAt" = NOW() - INTERVAL '1 day', "trialConsumed" = true WHERE id = '${userId}'`);

    const res = await page.request.post(`${API}/workspaces/${wsId}/plaid/link-token`, {
      headers: { "x-workspace-id": wsId },
    });

    expect(res.status()).toBe(402);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("upgrade_required");
  });

  test("expired trial → POST /exchange → 402 upgrade_required", async ({ page }) => {
    const email = `expired2-${Date.now()}@e2e-tier.test`;
    const { userId, wsId } = await apiSignUp(page, email);

    psql(`UPDATE users SET "trialEndsAt" = NOW() - INTERVAL '1 day', "trialConsumed" = true WHERE id = '${userId}'`);

    const res = await page.request.post(`${API}/workspaces/${wsId}/plaid/exchange`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { publicToken: "p", institutionId: "ins_1", institutionName: "Bank" },
    });

    expect(res.status()).toBe(402);
    expect((await res.json() as { error: string }).error).toBe("upgrade_required");
  });

  test("Pro at limit (5 items) → POST /link-token → 402 plaid_item_limit_reached", async ({ page }) => {
    const email = `atlimit-${Date.now()}@e2e-tier.test`;
    const { wsId } = await apiSignUp(page, email);

    // Seed 5 active items directly
    for (let i = 0; i < 5; i++) {
      psql(
        `INSERT INTO plaid_items (id, "workspaceId", "accessTokenCiphertext", "accessTokenIv", "itemId", "institutionId", "institutionName", "createdAt", "updatedAt")` +
        ` VALUES (gen_random_uuid(), '${wsId}', decode('01', 'hex'), decode('02020202020202020202020202020202', 'hex'),` +
        ` 'e2e_limit_${i}_${Date.now()}', 'ins_1', 'Bank', NOW(), NOW())`,
      );
    }

    const res = await page.request.post(`${API}/workspaces/${wsId}/plaid/link-token`, {
      headers: { "x-workspace-id": wsId },
    });

    expect(res.status()).toBe(402);
    expect((await res.json() as { error: string }).error).toBe("plaid_item_limit_reached");
  });

  test("Pro below limit (4 active + 2 disconnected) → POST /link-token → Plaid called (not 402)", async ({ page }) => {
    const email = `belowlimit-${Date.now()}@e2e-tier.test`;
    const { wsId } = await apiSignUp(page, email);

    // 4 active + 2 disconnected = 4 effective (limit 5)
    for (let i = 0; i < 4; i++) {
      psql(
        `INSERT INTO plaid_items (id, "workspaceId", "accessTokenCiphertext", "accessTokenIv", "itemId", "institutionId", "institutionName", "createdAt", "updatedAt")` +
        ` VALUES (gen_random_uuid(), '${wsId}', decode('01', 'hex'), decode('02020202020202020202020202020202', 'hex'),` +
        ` 'e2e_active_${i}_${Date.now()}', 'ins_1', 'Bank', NOW(), NOW())`,
      );
    }
    for (let i = 0; i < 2; i++) {
      psql(
        `INSERT INTO plaid_items (id, "workspaceId", "accessTokenCiphertext", "accessTokenIv", "itemId", "institutionId", "institutionName", status, "createdAt", "updatedAt")` +
        ` VALUES (gen_random_uuid(), '${wsId}', decode('01', 'hex'), decode('02020202020202020202020202020202', 'hex'),` +
        ` 'e2e_disc_${i}_${Date.now()}', 'ins_1', 'Bank', 'disconnected', NOW(), NOW())`,
      );
    }

    // Not 402 — it will fail with Plaid error (mock not set up) but NOT a limit error
    const res = await page.request.post(`${API}/workspaces/${wsId}/plaid/link-token`, {
      headers: { "x-workspace-id": wsId },
    });

    // 402 would be a limit error; any other status (200, 502, etc.) means the limit check passed
    const body = await res.json() as { error?: string };
    expect(body.error).not.toBe("upgrade_required");
    expect(body.error).not.toBe("plaid_item_limit_reached");
  });
});

// ---------------------------------------------------------------------------
// Group 2: Trial expiry Step 0 via daily-refresh (needs Plaid creds)
// ---------------------------------------------------------------------------

test.describe("plan 1d-tier-enforcement — trial expiry Step 0", () => {
  test.skip(!HAS_DB || !HAS_PLAID, "Requires DB + PLAID_CLIENT_ID + PLAID_SECRET");

  test.afterEach(() => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Tier%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-tier.test'`);
    } catch { /* ignore */ }
  });

  test("expired-trial active item → daily-refresh Step 0 → status='disconnected'", async ({ page }) => {
    const email = `expiry-step0-${Date.now()}@e2e-tier.test`;
    const { userId, wsId } = await apiSignUp(page, email);

    // Create a real sandbox item and exchange via the app (token gets encrypted)
    const ptResp = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        institution_id: "ins_109508",
        initial_products: ["transactions"],
      }),
    });
    expect(ptResp.ok).toBe(true);
    const { public_token } = await ptResp.json() as { public_token: string };

    // Exchange via app endpoint (stores encrypted token in DB)
    const exRes = await page.request.post(`${API}/workspaces/${wsId}/plaid/exchange`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { publicToken: public_token, institutionId: "ins_109508", institutionName: "First Platypus Bank" },
    });
    expect(exRes.status()).toBe(200);
    const { plaidItemId } = await exRes.json() as { plaidItemId: string };

    // Verify item is active
    const statusBefore = psql(`SELECT status FROM plaid_items WHERE id = '${plaidItemId}'`);
    expect(statusBefore).toBe("active");

    // Expire the trial (triggers Step 0 next time daily-refresh runs)
    psql(`UPDATE users SET "trialEndsAt" = NOW() - INTERVAL '1 day', "trialConsumed" = true WHERE id = '${userId}'`);

    // Run daily-refresh — Step 0 finds and removes the item
    runJob("daily-refresh", "runDailyRefresh");

    // Item should now be disconnected (Plaid removed, billing stopped, data preserved)
    const statusAfter = psql(`SELECT status FROM plaid_items WHERE id = '${plaidItemId}'`);
    expect(statusAfter).toBe("disconnected");

    // Workspace + item row still exists (data preserved)
    const itemRow = psql(`SELECT id FROM plaid_items WHERE id = '${plaidItemId}'`);
    expect(itemRow).toBe(plaidItemId);
  });
});
