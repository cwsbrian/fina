import { prisma } from "../../db.js";
import type { Env } from "../../env.js";

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
  console.info("cleanup-events complete", { deleted: r.count, cutoff });
}
