import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { dispatchWebhookSync } from "../../plaid/webhook-dispatch.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";

export async function runRetryUnprocessed(env: Env): Promise<void> {
  // 24h window: Plaid retries undelivered webhooks for up to 24h, so retrying
  // within that window can still catch new deltas. Events aged 24h–30d are
  // superseded by cursor-driven syncs and swept by cleanup-events at TTL.
  const cutoff = new Date(Date.now() - 24 * 3600_000);

  const events = await prisma.plaidWebhookEvent.findMany({
    where: {
      processedAt: null,
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      plaidItemId: { not: null },
      receivedAt: { gte: cutoff },
      plaidItem: { is: { status: { not: "disconnected" } } },
    },
    // No workspace join — tier gate uses plaidItem.connectedBy directly.
    // disconnected items are filtered at query time via the where clause above;
    // no in-loop status check needed (snapshot reads can't catch a live race anyway).
    include: { plaidItem: { select: { id: true, workspaceId: true, connectedBy: true } } },
    take: 50,
    orderBy: { receivedAt: "asc" },
  });

  let attempted = 0, gated = 0;

  for (const ev of events) {
    // Guard: plaidItemId filter ensures non-null at query time, but onDelete:SetNull
    // can race between findMany and here.
    if (!ev.plaidItem) continue;

    const item = ev.plaidItem;

    // Positive-condition form avoids an empty-if lint warning.
    if (item.connectedBy) {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) {
        // Stamp the row so it stops appearing in the NULL retry set.
        await prisma.plaidWebhookEvent.update({
          where: { id: ev.id },
          data: { processedAt: new Date(), processError: `tier_gated:${gate.reason}` },
        });
        gated++;
        continue;
      }
    }
    // connectedBy null → pre-dates tracking; allow sync, no gate possible.

    // dispatchWebhookSync handles its own try/catch + processedAt semantics:
    //  - normal sync:  processedAt set
    //  - sync throws:  processedAt + processError set
    //  - lock_held:    processedAt stays NULL (row reappears next tick).
    //                  NOTE: any newTxIds from already-committed pages are still
    //                  categorized inside dispatchWebhookSync before it returns.
    await dispatchWebhookSync(env, item.workspaceId, item.id, ev.id);
    attempted++;
  }

  console.info("retry-unprocessed complete", { found: events.length, attempted, gated });
}
