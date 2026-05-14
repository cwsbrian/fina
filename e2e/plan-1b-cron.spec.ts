/**
 * E2E tests — Plan 1B-cron: Scheduled background jobs
 *
 * Invoke cron job functions directly via tsx (no cron timing needed) and
 * verify results via the database. No Plaid credentials required.
 *
 * Skip guard: requires fina-postgres-dev docker container.
 *
 * Run:
 *   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1b-cron"
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import path from "path";

const API_DIR = path.resolve(__dirname, "../apps/api");
const DB = process.env.DATABASE_URL ?? "postgresql://fina:fina@localhost:5433/fina";

// Check whether the test database is reachable.
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

/** Run a psql query; returns trimmed stdout. -q suppresses command tags. */
function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

/**
 * Seed data via tsx + Prisma (handles @default / @updatedAt automatically).
 * Writes temp file into apps/api/ so relative imports resolve correctly.
 * Same dynamic-import pattern as runJob (no top-level await in CJS mode).
 */
function seed(script: string): string {
  // Wrap the caller's body (which may use prisma via dynamic import) in an IIFE.
  const wrapped =
    `(async () => {\n` +
    `  const { prisma } = await import("./src/db.js");\n` +
    script +
    `\n})().catch(e => { console.error(e); process.exit(1); });\n`;
  const tmp = path.join(API_DIR, `_e2e_seed_${Date.now()}.ts`);
  writeFileSync(tmp, wrapped, "utf8");
  try {
    return execSync(`pnpm exec tsx ${path.basename(tmp)}`, {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: DB },
      timeout: 30_000,
    }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Invoke a cron job function once via tsx.
 * Uses async IIFE + dynamic import because apps/api has no "type":"module",
 * so top-level await is not supported in CJS tsx mode. Dynamic import wraps
 * the CJS named exports under `.default`, so we destructure from there.
 * Optionally pass extra env vars (e.g. CRON_EVENT_TTL_DAYS).
 */
function runJob(jobModule: string, fn: string, extraEnv: Record<string, string> = {}): void {
  const script =
    `(async () => {\n` +
    `  const { loadEnv } = await import("./src/env.js");\n` +
    `  const env = loadEnv();\n` +
    `  const { ${fn} } = await import("./src/cron/jobs/${jobModule}.js");\n` +
    `  await ${fn}(env);\n` +
    `})().catch(e => { console.error(e); process.exit(1); });\n`;
  const tmp = path.join(API_DIR, `_e2e_job_${Date.now()}.ts`);
  writeFileSync(tmp, script, "utf8");
  try {
    execSync(`pnpm exec tsx ${path.basename(tmp)}`, {
      cwd: API_DIR,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: DB, ...extraEnv },
      timeout: 30_000,
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Cron E2E — require fina-postgres-dev
// ---------------------------------------------------------------------------

test.describe("plan 1b-cron", () => {
  test.skip(!HAS_DB, "Requires fina-postgres-dev docker container (pnpm smoke:db:start)");

  // Best-effort cleanup of E2E rows between tests.
  test.afterEach(() => {
    try {
      psql(`DELETE FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`);
      psql(`DELETE FROM plaid_items WHERE "institutionId" = 'e2e_cron_ins'`);
      psql(`DELETE FROM workspaces WHERE name LIKE 'e2e-cron-%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-cron.test'`);
    } catch { /* best-effort */ }
  });

  // ─── cleanup-events ───────────────────────────────────────────────────────

  test("cleanup-events: deletes rows older than TTL, keeps recent", async () => {
    // Seed an event from 31 days ago (beyond the 30-day default TTL).
    psql(
      `INSERT INTO plaid_webhook_events (id, "webhookType", "webhookCode", body, "receivedAt")` +
      ` VALUES (gen_random_uuid(), 'TRANSACTIONS', 'E2E_OLD', '{}', NOW() - INTERVAL '31 days')`,
    );
    // Seed a recent event (within TTL).
    psql(
      `INSERT INTO plaid_webhook_events (id, "webhookType", "webhookCode", body)` +
      ` VALUES (gen_random_uuid(), 'TRANSACTIONS', 'E2E_RECENT', '{}')`,
    );

    const before = parseInt(psql(
      `SELECT count(*) FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`,
    ));
    expect(before).toBe(2);

    runJob("cleanup-events", "runCleanupEvents");

    const after = parseInt(psql(
      `SELECT count(*) FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`,
    ));
    expect(after).toBe(1);

    const remaining = psql(
      `SELECT "webhookCode" FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`,
    );
    expect(remaining).toBe("E2E_RECENT");
  });

  test("cleanup-events: CRON_EVENT_TTL_DAYS=1 removes 2-day-old row", async () => {
    psql(
      `INSERT INTO plaid_webhook_events (id, "webhookType", "webhookCode", body, "receivedAt")` +
      ` VALUES (gen_random_uuid(), 'TRANSACTIONS', 'E2E_OLD', '{}', NOW() - INTERVAL '2 days')`,
    );
    psql(
      `INSERT INTO plaid_webhook_events (id, "webhookType", "webhookCode", body)` +
      ` VALUES (gen_random_uuid(), 'TRANSACTIONS', 'E2E_RECENT', '{}')`,
    );

    // TTL=1 → 2-day-old row is beyond TTL.
    runJob("cleanup-events", "runCleanupEvents", { CRON_EVENT_TTL_DAYS: "1" });

    const after = parseInt(psql(
      `SELECT count(*) FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`,
    ));
    expect(after).toBe(1);
    expect(psql(
      `SELECT "webhookCode" FROM plaid_webhook_events WHERE "webhookCode" IN ('E2E_OLD','E2E_RECENT')`,
    )).toBe("E2E_RECENT");
  });

  // ─── retry-unprocessed ────────────────────────────────────────────────────

  test("retry-unprocessed: tier-gated event gets processedAt stamped", async () => {
    // Seed: user with expired trial + workspace + item + null-processedAt event via Prisma.
    const evId = seed(`
// User.id has no @default — must be provided explicitly (better-auth generates it).
const { randomUUID } = await import("crypto");
const user = await prisma.user.create({
  data: {
    id: randomUUID(),
    name: "E2E Cron Expired",
    email: "expired@e2e-cron.test",
    emailVerified: true,
    trialEndsAt: new Date(Date.now() - 86_400_000),
    trialConsumed: true,
  },
});
const ws = await prisma.workspace.create({ data: { name: "e2e-cron-ws" } });
const item = await prisma.plaidItem.create({
  data: {
    workspaceId: ws.id,
    connectedBy: user.id,
    accessTokenCiphertext: Buffer.from([1]),
    accessTokenIv: Buffer.from(new Array(12).fill(2)),
    itemId: "e2e_cron_item_" + Date.now(),
    institutionId: "e2e_cron_ins",
    institutionName: "E2E Bank",
  },
});
const ev = await prisma.plaidWebhookEvent.create({
  data: {
    plaidItemId: item.id,
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    body: {},
    receivedAt: new Date(Date.now() - 5 * 60_000),
  },
});
console.log(ev.id);
await prisma.$disconnect().catch(() => {});
`);

    expect(evId).toBeTruthy();

    // Run retry-unprocessed. Tier gate fires (expired trial) → stamp + skip dispatch.
    runJob("retry-unprocessed", "runRetryUnprocessed");

    const row = psql(
      `SELECT "processedAt", "processError" FROM plaid_webhook_events WHERE id = '${evId}'`,
    );
    const parts = row.split("|");
    expect(parts[0]).toBeTruthy();            // processedAt was set
    expect(parts[1]).toMatch(/^tier_gated:/); // tier gate reason
  });

  test("retry-unprocessed: event older than 24h is not retried", async () => {
    const evId = seed(`
const ws = await prisma.workspace.create({ data: { name: "e2e-cron-old" } });
const item = await prisma.plaidItem.create({
  data: {
    workspaceId: ws.id,
    accessTokenCiphertext: Buffer.from([1]),
    accessTokenIv: Buffer.from(new Array(12).fill(2)),
    itemId: "e2e_old_item_" + Date.now(),
    institutionId: "e2e_cron_ins",
    institutionName: "E2E Bank",
  },
});
const ev = await prisma.plaidWebhookEvent.create({
  data: {
    plaidItemId: item.id,
    webhookType: "TRANSACTIONS",
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    body: {},
    receivedAt: new Date(Date.now() - 25 * 3600_000), // 25h ago
  },
});
console.log(ev.id);
await prisma.$disconnect().catch(() => {});
`);

    runJob("retry-unprocessed", "runRetryUnprocessed");

    // 25h-old event is outside the 24h window — processedAt must remain NULL.
    const processedAt = psql(
      `SELECT "processedAt" FROM plaid_webhook_events WHERE id = '${evId}'`,
    );
    expect(processedAt).toBe(""); // NULL → empty in psql -tA
  });
});
