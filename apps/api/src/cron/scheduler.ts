import { Cron } from "croner";
import type { Env } from "../env.js";
import { logInfo, logWarn, logError } from "../logger.js";
import { runDailyRefresh } from "./jobs/daily-refresh.js";
import { runRetryUnprocessed } from "./jobs/retry-unprocessed.js";
import { runCleanupEvents } from "./jobs/cleanup-events.js";
import { runScheduledSpendMatch } from "./jobs/scheduled-spend-match.js";
import { runDailyBrief } from "./jobs/daily-brief.js";
import { runPushReceipts } from "./jobs/push-receipts.js";
import { runTrialExpiring } from "./jobs/trial-expiring.js";
import { runGoalMilestones } from "./jobs/goal-milestones.js";
import { runSweepIntents } from "./jobs/sweep-intents.js";
import { runPlaidBillingReconcile } from "./jobs/plaid-billing-reconcile.js";

let jobs: Cron[] = [];

function makeCron(
  pattern: string,
  name: string,
  run: () => Promise<void>,
): Cron {
  return new Cron(
    pattern,
    {
      name,
      // croner's protect callback form: emits a structured warn on skipped
      // overlapping runs. The boolean form (`protect: true`) silently
      // skips — invisible in production logs.
      protect: (job) =>
        logWarn(
          { cron: job.name ?? name, event: "protected_skip" },
          "cron skipped — previous run still in flight",
        ),
    },
    () => safe(name, run),
  );
}

export function startScheduler(env: Env): void {
  if (!env.CRON_ENABLED) return;

  jobs = [
    makeCron("* * * * *",    "daily-brief",           () => runDailyBrief(env)),
    makeCron("0 * * * *",    "push-receipts",         () => runPushReceipts(env)),
    makeCron("0 * * * *",    "sweep-expired-intents", () => runSweepIntents()),
    makeCron(
      "45 8 * * *",
      "plaid-billing-reconcile",
      () => runPlaidBillingReconcile(env),
    ),
    makeCron("0 9 * * *",    "daily-refresh",         () => runDailyRefresh(env)),
    makeCron("*/10 * * * *", "retry-unprocessed",     () => runRetryUnprocessed(env)),
    makeCron("0 3 * * *",    "cleanup-events",        () => runCleanupEvents(env)),
    makeCron("5 9 * * *",    "scheduled-spend-match", () => runScheduledSpendMatch(env)),
    // Trial + goal milestones: morning UTC, after daily-refresh has had
    // time to import yesterday's tx. Goal milestones reads the same
    // savings figures the user sees on /goals.
    makeCron("0 10 * * *",   "trial-expiring",        () => runTrialExpiring(env)),
    makeCron("10 10 * * *",  "goal-milestones",       () => runGoalMilestones(env)),
  ];

  logInfo({}, `cron scheduler started — ${jobs.length} jobs`);
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
}

/**
 * Wraps a single cron run with structured start/success/fail logs and
 * swallows errors so a thrown job doesn't crash the croner timer. Exported
 * for unit testing the log shape; production callers go through `makeCron`.
 */
export async function safe(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const startedAt = Date.now();
  logInfo({ cron: name, event: "start" }, "cron started");
  try {
    await fn();
    logInfo(
      { cron: name, event: "success", durationMs: Date.now() - startedAt },
      "cron ok",
    );
  } catch (err) {
    logError(
      { cron: name, event: "fail", durationMs: Date.now() - startedAt, err },
      "cron failed",
    );
  }
}
