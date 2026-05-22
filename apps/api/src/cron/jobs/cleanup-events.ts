import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { logInfo } from "../../logger.js";

const CRON_NAME = "cleanup-events";

// CRON_EVENT_TTL_DAYS is optional (| undefined) in Env — always apply this default.
// Callers that add new TTL-consuming jobs must also use `?? DEFAULT_TTL_DAYS` or
// risk `undefined * ms_per_day = NaN`, producing an invalid cutoff date.
const DEFAULT_TTL_DAYS = 30;

export async function runCleanupEvents(env: Env): Promise<void> {
  const ttlDays = env.CRON_EVENT_TTL_DAYS ?? DEFAULT_TTL_DAYS;
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000);
  // Intentionally no processedAt filter: rows still NULL at TTL days are
  // superseded by cursor-driven syncs or permanently stuck. TTL sweeps them.
  const r = await prisma.plaidWebhookEvent.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  logInfo(
    { cron: CRON_NAME },
    `cleanup-events complete — deleted=${r.count} cutoff=${cutoff.toISOString()}`,
  );

  // ScheduledSpend resolved TTL (Plan 1J Task 7). Uses updatedAt as a proxy
  // for "time of resolution" since the schema has no resolvedAt column.
  // "Resolved" = dismissedAt set OR matchedTxId set.
  const ssTtlDays = env.SCHEDULED_SPEND_TTL_DAYS ?? 90;
  const scheduledSpendCutoff = new Date(Date.now() - ssTtlDays * 24 * 60 * 60 * 1000);
  const ssDeleted = await prisma.scheduledSpend.deleteMany({
    where: {
      OR: [
        { dismissedAt: { not: null } },
        { matchedTxId: { not: null } },
      ],
      updatedAt: { lt: scheduledSpendCutoff },
    },
  });
  logInfo(
    { cron: CRON_NAME, deletedScheduledSpends: ssDeleted.count, ttlDays: ssTtlDays },
    "cleanup-events scheduled-spend pass",
  );
}
