import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { syncTransactions } from "../../plaid/sync.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";

export async function runDailyRefresh(env: Env): Promise<void> {
  const items = await prisma.plaidItem.findMany({
    where: { status: "active" },
    // connectedBy is the userId who ran Plaid Link — used for tier gating.
    // Workspace has no ownerUserId column. connectedBy is nullable (SetNull on user delete).
    select: { id: true, workspaceId: true, connectedBy: true },
  });

  const t0 = Date.now();
  let synced = 0, gated = 0, failed = 0, lockHeld = 0;

  for (const item of items) {
    if (item.connectedBy) {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) { gated++; continue; }
    } else {
      console.warn("daily-refresh: connectedBy null, skipping tier gate", { itemId: item.id });
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
          console.error("categorize after daily-refresh failed", { itemId: item.id, err: e }),
        );
      }
    } catch (e) {
      failed++;
      console.error("daily-refresh sync failed", { itemId: item.id, err: sanitizePlaidError(e) });
    }
  }

  console.info("daily-refresh complete", {
    durationMs: Date.now() - t0,
    itemsTotal: items.length, synced, gated, lockHeld, failed,
  });
}
