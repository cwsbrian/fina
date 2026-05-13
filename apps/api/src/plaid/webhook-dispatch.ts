import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { syncTransactions } from "./sync.js";
import { categorizeNewTransactions } from "../categorize/service.js";

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
    const r = await syncTransactions(env, workspaceId, plaidItemId);

    if (r.newTxIds.length > 0) {
      await categorizeNewTransactions(env, workspaceId, r.newTxIds);
    }

    if ("skipped" in r) {
      // lock_held — leave processedAt NULL so cron retries.
      return;
    }

    await prisma.plaidWebhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date() },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await prisma.plaidWebhookEvent
      .update({
        where: { id: webhookEventId },
        data: { processedAt: new Date(), processError: msg },
      })
      .catch(() => {/* swallow — log handles diagnostic */});
    console.error("webhook sync failed", { err: e, plaidItemId, webhookEventId });
  }
}
