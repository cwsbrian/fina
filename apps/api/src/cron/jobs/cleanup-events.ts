import { prisma } from "../../db.js";
import type { Env } from "../../env.js";

export async function runCleanupEvents(env: Env): Promise<void> {
  const ttlDays = env.CRON_EVENT_TTL_DAYS ?? 30;
  const cutoff = new Date(Date.now() - ttlDays * 86_400_000);
  // Intentionally no processedAt filter: rows still NULL at TTL days are
  // superseded by cursor-driven syncs or permanently stuck. TTL sweeps them.
  const r = await prisma.plaidWebhookEvent.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  console.info("cleanup-events complete", { deleted: r.count, cutoff });
}
