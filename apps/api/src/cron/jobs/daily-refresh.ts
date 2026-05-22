import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { logInfo, logWarn, logError } from "../../logger.js";
import { syncTransactions } from "../../plaid/sync.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";
import { removeItemForBilling } from "../../plaid/items.js";

const CRON_NAME = "daily-refresh";

export async function runDailyRefresh(env: Env): Promise<void> {
  // ── Step 0: remove active items for expired-trial workspace owners ──────
  // Plaid charges ~$0.25/item/month even with no API calls. Removing on expiry
  // stops billing immediately. Data (transactions, accounts) is preserved.
  const expiredItems = await prisma.plaidItem.findMany({
    where: {
      status: "active",
      workspace: {
        memberships: {
          some: {
            role: "owner",
            user: { trialEndsAt: { lt: new Date() } },
          },
        },
      },
    },
    select: { id: true, workspaceId: true },
  });

  let billingRemoved = 0;
  for (const item of expiredItems) {
    try {
      await removeItemForBilling(env, item.workspaceId, item.id);
      billingRemoved++;
    } catch (e) {
      logError(
        { cron: CRON_NAME, plaidItemId: item.id, err: sanitizePlaidError(e) },
        "daily-refresh: billing-remove failed",
      );
      // Non-fatal: cron retries tomorrow. Plaid will return ITEM_NOT_FOUND
      // if the token was already removed, and removeItemForBilling handles that.
    }
  }
  if (expiredItems.length > 0) {
    logInfo(
      { cron: CRON_NAME },
      `daily-refresh: trial expiry cleanup — found=${expiredItems.length} removed=${billingRemoved}`,
    );
  }
  // ── existing active-items sync loop (fresh query — Step 0's disconnected
  //    items are excluded by status:'active' filter below) ─────────────────

  const items = await prisma.plaidItem.findMany({
    where: { status: "active" },
    select: { id: true, workspaceId: true, connectedBy: true },
  });

  const t0 = Date.now();
  let synced = 0, gated = 0, failed = 0, lockHeld = 0;

  for (const item of items) {
    if (item.connectedBy) {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) { gated++; continue; }
    } else {
      logWarn(
        { cron: CRON_NAME, plaidItemId: item.id },
        "daily-refresh: connectedBy null, skipping tier gate",
      );
    }

    try {
      const r = await syncTransactions(env, item.workspaceId, item.id);
      if ("skipped" in r && r.skipped === "lock_held") {
        lockHeld++;
      } else {
        synced++;
      }
      if ("newTxIds" in r && r.newTxIds.length > 0) {
        await categorizeNewTransactions(env, item.workspaceId, r.newTxIds).catch((e) =>
          logError(
            { cron: CRON_NAME, plaidItemId: item.id, err: e },
            "categorize after daily-refresh failed",
          ),
        );
      }
    } catch (e) {
      failed++;
      logError(
        { cron: CRON_NAME, plaidItemId: item.id, err: sanitizePlaidError(e) },
        "daily-refresh sync failed",
      );
    }
  }

  logInfo(
    { cron: CRON_NAME, durationMs: Date.now() - t0 },
    `daily-refresh complete — itemsTotal=${items.length} synced=${synced} gated=${gated} lockHeld=${lockHeld} failed=${failed}`,
  );
}
