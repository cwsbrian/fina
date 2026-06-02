import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { logInfo, logWarn, logError } from "../../logger.js";
import { syncTransactions } from "../../plaid/sync.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";
import {
  reconcileOrphanPlaidItems,
  reconcilePlaidItemsForUser,
  refreshBillingStateForUser,
  retryPendingPlaidBillingCleanups,
} from "../../plaid/reconcile.js";
import { checkLargeChargeAndPush } from "../../push/anomaly.js";
import { notifyTransactionAdded } from "../../push/transaction-added.js";

const CRON_NAME = "daily-refresh";

export async function runDailyRefresh(env: Env): Promise<void> {
  // ── Step 0: refresh provider billing state, then reconcile by user ──────
  const owners = await prisma.plaidItem.findMany({
    where: {
      status: { not: "disconnected" },
      connectedBy: { not: null },
    },
    distinct: ["connectedBy"],
    select: { connectedBy: true },
  });

  for (const owner of owners) {
    const userId = owner.connectedBy;
    if (!userId) continue;
    await refreshBillingStateForUser(env, userId).catch((e) => {
      logError(
        { cron: CRON_NAME, userId, err: e },
        "daily-refresh: provider billing refresh failed",
      );
    });
    try {
      await reconcilePlaidItemsForUser(env, userId);
    } catch (e) {
      logError(
        { cron: CRON_NAME, userId, err: sanitizePlaidError(e) },
        "daily-refresh: plaid reconciliation failed",
      );
    }
  }

  await retryPendingPlaidBillingCleanups(env);
  await reconcileOrphanPlaidItems(env);

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
        // Run anomaly + transaction-added pushes serially after
        // categorize, so each push has the category name ready.
        for (const txId of r.newTxIds) {
          const tx = await prisma.transaction.findUnique({
            where: { id: txId },
            select: {
              amount: true,
              merchantNormalized: true,
              merchantRaw: true,
              allocations: {
                select: { category: { select: { name: true } } },
                take: 1,
              },
            },
          });
          if (!tx) continue;
          const amount = Math.abs(Number(tx.amount));
          const merchant = tx.merchantNormalized ?? tx.merchantRaw ?? "New charge";
          const categoryName = tx.allocations[0]?.category?.name ?? null;
          await checkLargeChargeAndPush(env, {
            transactionId: txId,
            workspaceId: item.workspaceId,
            amount,
            merchant,
          });
          // No actor exclusion — Plaid-synced txs come from the bank,
          // so every workspace member who opted in gets a push.
          await notifyTransactionAdded(env, {
            workspaceId: item.workspaceId,
            merchant,
            amount,
            categoryName,
          });
        }
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
