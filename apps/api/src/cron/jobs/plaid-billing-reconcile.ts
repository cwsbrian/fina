import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { logError, logInfo } from "../../logger.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import {
  reconcileOrphanPlaidItems,
  reconcilePlaidItemsForUser,
  refreshBillingStateForUser,
  retryPendingPlaidBillingCleanups,
} from "../../plaid/reconcile.js";

const CRON_NAME = "plaid-billing-reconcile";

/**
 * Refresh subscription state and reconcile Plaid connections independently
 * from transaction sync. This owns Free-plan grace start/expiry and paid-plan
 * restoration, plus retry/orphan cleanup.
 */
export async function runPlaidBillingReconcile(env: Env): Promise<void> {
  const owners = await prisma.plaidItem.findMany({
    where: {
      status: { not: "disconnected" },
      connectedBy: { not: null },
    },
    distinct: ["connectedBy"],
    select: { connectedBy: true },
  });

  let reconciled = 0;
  let failed = 0;
  let disconnected = 0;

  for (const owner of owners) {
    const userId = owner.connectedBy;
    if (!userId) continue;

    try {
      await refreshBillingStateForUser(env, userId);
    } catch (error) {
      failed++;
      logError(
        { cron: CRON_NAME, userId, err: error },
        "plaid-billing-reconcile: provider billing refresh failed",
      );
      continue;
    }

    try {
      const result = await reconcilePlaidItemsForUser(env, userId);
      reconciled++;
      disconnected += result.disconnected.length;
      if (result.failed.length > 0) failed += result.failed.length;
    } catch (error) {
      failed++;
      logError(
        { cron: CRON_NAME, userId, err: sanitizePlaidError(error) },
        "plaid-billing-reconcile: Plaid reconciliation failed",
      );
    }
  }

  await retryPendingPlaidBillingCleanups(env);
  const orphanResult = await reconcileOrphanPlaidItems(env);
  disconnected += orphanResult.disconnected.length;
  failed += orphanResult.failed.length;

  logInfo(
    { cron: CRON_NAME, owners: owners.length, reconciled, disconnected, failed },
    "plaid-billing-reconcile complete",
  );
}
