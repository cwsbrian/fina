import { logInfo } from "../../logger.js";
import { sweepExpiredIntents } from "../../intents/sweep.js";

const CRON_NAME = "sweep-expired-intents";

// Interactive read-tool cards (recurring_candidates, scheduled_list) pre-create
// ActionIntent rows eagerly with a short TTL (INTENT_TTL_MS). Consumed intents
// are kept — audit events FK-reference them — so this only removes the
// unconsumed, expired backlog. Runs hourly to bound the table.
export async function runSweepIntents(): Promise<void> {
  const deleted = await sweepExpiredIntents();
  logInfo(
    { cron: CRON_NAME, deleted },
    `sweep-expired-intents complete — deleted=${deleted}`,
  );
}
