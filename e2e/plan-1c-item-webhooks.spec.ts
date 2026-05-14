/**
 * E2E tests — Plan 1C-item-webhooks: ITEM webhook status handling
 *
 * Strategy: create a real Plaid sandbox item → seed it in our DB → fire
 * ITEM webhooks via Plaid sandbox endpoints → poll plaid_items.status.
 *
 * The item is seeded directly via Prisma (fake ciphertext is fine because
 * dispatchItemEvent only updates status; it never decrypts the token).
 *
 * Skip guard: PLAID_CLIENT_ID + PLAID_SECRET + PLAID_WEBHOOK_URL must all
 * be set. The API must be running at API_URL with the Funnel forwarding
 * to it so Plaid can deliver webhooks.
 *
 * Run:
 *   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1c-item-webhooks"
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";
const DB = process.env.DATABASE_URL ?? "postgresql://fina:fina@localhost:5433/fina";
const PLAID_BASE = "https://sandbox.plaid.com";

const HAS_ENV = !!(
  process.env.PLAID_CLIENT_ID &&
  process.env.PLAID_SECRET &&
  process.env.PLAID_WEBHOOK_URL
);

/** Run a psql query against the smoke DB; returns trimmed stdout. */
function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

/**
 * Create a Plaid sandbox item, register our webhook URL, and return the
 * Plaid item_id and access_token (raw, not encrypted).
 */
async function createSandboxItem(): Promise<{ accessToken: string; plaidItemId: string }> {
  const ptResp = await fetch(`${PLAID_BASE}/sandbox/public_token/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      institution_id: "ins_109508",
      initial_products: ["transactions"],
    }),
  });
  if (!ptResp.ok) throw new Error(`public_token/create: ${ptResp.status} ${await ptResp.text()}`);
  const { public_token } = await ptResp.json() as { public_token: string };

  const exResp = await fetch(`${PLAID_BASE}/item/public_token/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      public_token,
    }),
  });
  if (!exResp.ok) throw new Error(`public_token/exchange: ${exResp.status} ${await exResp.text()}`);
  const { access_token, item_id } = await exResp.json() as { access_token: string; item_id: string };

  // Register our webhook URL so Plaid delivers to the Funnel.
  const whResp = await fetch(`${PLAID_BASE}/item/webhook/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.PLAID_CLIENT_ID,
      secret: process.env.PLAID_SECRET,
      access_token,
      webhook: process.env.PLAID_WEBHOOK_URL,
    }),
  });
  if (!whResp.ok) throw new Error(`item/webhook/update: ${whResp.status} ${await whResp.text()}`);

  return { accessToken: access_token, plaidItemId: item_id };
}

/**
 * Seed a plaid_items row in our DB using the real Plaid item_id.
 * Uses fake ciphertext — dispatchItemEvent only updates status.
 * Returns our internal DB id.
 */
function seedPlaidItemInDb(plaidItemId: string): string {
  const dbItemId = psql(
    `INSERT INTO workspaces (id, name, "createdAt", "updatedAt")` +
    ` VALUES (gen_random_uuid(), 'e2e-item-wh', NOW(), NOW()) RETURNING id`,
  );
  const itemRowId = psql(
    `INSERT INTO plaid_items` +
    ` (id, "workspaceId", "accessTokenCiphertext", "accessTokenIv",` +
    `  "itemId", "institutionId", "institutionName", "webhookUrl", "createdAt", "updatedAt")` +
    ` VALUES (gen_random_uuid(), '${dbItemId}', decode('01', 'hex'),` +
    `  decode('02020202020202020202020202020202', 'hex'),` +
    `  '${plaidItemId}', 'ins_109508', 'E2E Bank', '${process.env.PLAID_WEBHOOK_URL}', NOW(), NOW())` +
    ` RETURNING id`,
  );
  return itemRowId;
}

/** Poll plaid_items.status until it matches expected (up to 15s). */
async function pollStatus(dbItemId: string, expected: string, page: import("@playwright/test").Page): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const status = psql(`SELECT status FROM plaid_items WHERE id = '${dbItemId}'`);
    if (status === expected) return status;
    await page.waitForTimeout(500);
  }
  return psql(`SELECT status FROM plaid_items WHERE id = '${dbItemId}'`);
}

/** Clean up E2E rows. */
function cleanup(): void {
  try {
    psql(`DELETE FROM workspaces WHERE name = 'e2e-item-wh'`);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------

test.describe("plan 1c-item-webhooks", () => {
  test.skip(!HAS_ENV, "Set PLAID_CLIENT_ID, PLAID_SECRET, PLAID_WEBHOOK_URL to run ITEM webhook E2E");

  test.afterEach(() => cleanup());

  test("ITEM/ERROR via reset_login → plaid_items.status = 'error'", async ({ page }) => {
    // 1. Create a sandbox item and seed it in our DB.
    const { accessToken, plaidItemId } = await createSandboxItem();
    const dbItemId = seedPlaidItemInDb(plaidItemId);

    // 2. Force ITEM/ERROR ITEM_LOGIN_REQUIRED via Plaid sandbox.
    const resetResp = await fetch(`${PLAID_BASE}/sandbox/item/reset_login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
      }),
    });
    expect(resetResp.ok).toBe(true);
    const resetBody = await resetResp.json() as { reset_login: boolean };
    expect(resetBody.reset_login).toBe(true);

    // 3. Poll until status flips to 'error' (Plaid delivers async via Funnel).
    const finalStatus = await pollStatus(dbItemId, "error", page);
    expect(finalStatus).toBe("error");

    // 4. Verify errorCode is populated.
    const errorCode = psql(`SELECT "errorCode" FROM plaid_items WHERE id = '${dbItemId}'`);
    expect(errorCode).toBe("ITEM_LOGIN_REQUIRED");

    // 5. Verify the webhook event row was stored.
    const evCount = psql(
      `SELECT count(*) FROM plaid_webhook_events WHERE "plaidItemId" = '${dbItemId}' AND "webhookType" = 'ITEM'`,
    );
    expect(parseInt(evCount)).toBeGreaterThan(0);
  });

  test("ITEM/USER_PERMISSION_REVOKED via fire_webhook → status = 'disconnected'", async ({ page }) => {
    // 1. Create a sandbox item and seed it in our DB.
    const { accessToken, plaidItemId } = await createSandboxItem();
    const dbItemId = seedPlaidItemInDb(plaidItemId);

    // 2. Fire USER_PERMISSION_REVOKED via Plaid sandbox fire_webhook.
    const fireResp = await fetch(`${PLAID_BASE}/sandbox/item/fire_webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
        webhook_type: "ITEM",
        webhook_code: "USER_PERMISSION_REVOKED",
      }),
    });
    if (!fireResp.ok) {
      // Plaid sandbox may not support ITEM type via fire_webhook — skip gracefully.
      test.skip(true, `fire_webhook ITEM not supported: ${fireResp.status} ${await fireResp.text()}`);
      return;
    }
    const fireBody = await fireResp.json() as { webhook_fired: boolean };
    expect(fireBody.webhook_fired).toBe(true);

    // 3. Poll until status flips to 'disconnected'.
    const finalStatus = await pollStatus(dbItemId, "disconnected", page);
    expect(finalStatus).toBe("disconnected");

    // 4. Verify errorCode is cleared.
    const errorCode = psql(`SELECT "errorCode" FROM plaid_items WHERE id = '${dbItemId}'`);
    expect(errorCode).toBe(""); // NULL → empty in psql -tA
  });

  test("Disconnected item is excluded from retry-unprocessed (negative check)", async ({ page }) => {
    // This test verifies that after an item goes disconnected, any existing
    // NULL-processedAt webhook events for it are NOT retried by the cron job.
    const { accessToken, plaidItemId } = await createSandboxItem();
    const dbItemId = seedPlaidItemInDb(plaidItemId);

    // Seed a NULL-processedAt event for this item.
    psql(
      `INSERT INTO plaid_webhook_events (id, "plaidItemId", "webhookType", "webhookCode", body, "receivedAt")` +
      ` VALUES (gen_random_uuid(), '${dbItemId}', 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE', '{}', NOW() - INTERVAL '5 minutes')`,
    );

    // Fire USER_PERMISSION_REVOKED to disconnect the item.
    const fireResp = await fetch(`${PLAID_BASE}/sandbox/item/fire_webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.PLAID_CLIENT_ID,
        secret: process.env.PLAID_SECRET,
        access_token: accessToken,
        webhook_type: "ITEM",
        webhook_code: "USER_PERMISSION_REVOKED",
      }),
    });
    if (!fireResp.ok) {
      test.skip(true, `fire_webhook ITEM not supported: ${fireResp.status}`);
      return;
    }

    // Wait for item to go disconnected.
    await pollStatus(dbItemId, "disconnected", page);

    // Run retry-unprocessed via tsx — the event should NOT be processed (excluded by query filter).
    const API_DIR = `${__dirname}/../apps/api`;
    const { writeFileSync, unlinkSync } = await import("fs");
    const { join } = await import("path");
    const tmp = join(API_DIR, `_e2e_item_retry_${Date.now()}.ts`);
    writeFileSync(tmp,
      `(async () => {\n` +
      `  const { runRetryUnprocessed } = await import("./src/cron/jobs/retry-unprocessed.js");\n` +
      `  const { loadEnv } = await import("./src/env.js");\n` +
      `  await runRetryUnprocessed(loadEnv());\n` +
      `})().catch(e => { console.error(e); process.exit(1); });\n`,
    );
    try {
      execSync(`pnpm exec tsx ${tmp.split("/").pop()}`, {
        cwd: API_DIR,
        env: { ...process.env, DATABASE_URL: DB },
        encoding: "utf8",
        timeout: 30_000,
      });
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }

    // The event should still have processedAt = NULL (not retried for disconnected item).
    const processedAt = psql(
      `SELECT "processedAt" FROM plaid_webhook_events WHERE "plaidItemId" = '${dbItemId}' AND "webhookCode" = 'SYNC_UPDATES_AVAILABLE'`,
    );
    expect(processedAt).toBe(""); // NULL → empty in psql -tA
  });
});
