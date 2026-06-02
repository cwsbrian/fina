import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { syncTransactions } from "./sync.js";
import { categorizeNewTransactions } from "../categorize/service.js";
import { logError } from "../logger.js";
import { checkBackgroundSyncGate } from "../cron/tier-gate.js";

/**
 * Detached worker called by the webhook handler. The handler has already
 * returned 200 — this runs in the background.
 *
 * Result handling:
 *  - normal sync → processedAt set, processError null
 *  - sync threw   → processedAt set, processError = err.message
 *  - lock_held    → processedAt LEFT NULL (1B-cron retries; competing sync
 *                   may have started before this Plaid delta existed)
 *
 * In all "data committed" cases (normal + lock_held) we still call
 * categorizeNewTransactions on the newTxIds returned, so categories land
 * before any retry.
 */
export async function dispatchWebhookSync(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
  webhookEventId: string,
): Promise<void> {
  try {
    const item = await prisma.plaidItem.findUnique({
      where: { id: plaidItemId },
      select: {
        connectedBy: true,
        workspace: {
          select: {
            memberships: {
              select: { userId: true },
            },
          },
        },
      },
    });
    if (!item?.connectedBy) {
      await prisma.plaidWebhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: "no_owner" },
      });
      return;
    }
    const hasWorkspaceMembership = item.workspace.memberships.some(
      (membership) => membership.userId === item.connectedBy,
    );
    if (!hasWorkspaceMembership) {
      await prisma.plaidWebhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: "no_membership" },
      });
      return;
    }

    const gate = await checkBackgroundSyncGate(item.connectedBy);
    if (!gate.ok) {
      await prisma.plaidWebhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: `tier_gated:${gate.reason}` },
      });
      return;
    }

    const r = await syncTransactions(env, workspaceId, plaidItemId);

    if (r.newTxIds.length > 0) {
      // Categorize is best-effort and must not affect the lock_held retry sentinel.
      // A DB error here would otherwise jump to the catch block and set processedAt,
      // losing the NULL that signals cron to retry the unfinished sync.
      await categorizeNewTransactions(env, workspaceId, r.newTxIds).catch((catErr) => {
        logError(
          { plaidItemId, err: catErr },
          `categorize after webhook sync failed webhookEventId=${webhookEventId}`,
        );
      });
    }

    if ("skipped" in r) {
      // lock_held — leave processedAt NULL so cron retries.
      return;
    }

    await prisma.plaidWebhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), processError: null },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await prisma.plaidWebhookEvent
      .update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: msg },
      })
      .catch(() => {/* swallow — log handles diagnostic */});
    logError(
      { plaidItemId, err: e },
      `webhook sync failed webhookEventId=${webhookEventId}`,
    );
  }
}
