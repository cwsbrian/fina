import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { logInfo, logError } from "../../logger.js";
import { syncTransactions } from "../../plaid/sync.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";
import { checkLargeChargeAndPush } from "../../push/anomaly.js";
import { notifyTransactionAdded } from "../../push/transaction-added.js";

const CRON_NAME = "daily-refresh";

export async function runDailyRefresh(env: Env): Promise<void> {
  // Billing/grace reconciliation runs in its own cron. This job only syncs
  // active items, with the gate enforcing current entitlement and ownership.
  const items = await prisma.plaidItem.findMany({
    where: {
      status: "active",
      connectedBy: { not: null },
    },
    select: { id: true, workspaceId: true, connectedBy: true },
  });

  const t0 = Date.now();
  let synced = 0, gated = 0, failed = 0, lockHeld = 0;

  for (const item of items) {
    if (!item.connectedBy) continue;
    const gate = await checkBackgroundSyncGate(item.connectedBy, item.id);
    if (!gate.ok) { gated++; continue; }

    try {
      const r = await syncTransactions(env, item.workspaceId, item.id);
      if ("skipped" in r && r.skipped === "lock_held") {
        lockHeld++;
      } else {
        synced++;
      }
      if (!gate.billingGrace && "newTxIds" in r && r.newTxIds.length > 0) {
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
