import { Cron } from "croner";
import type { Env } from "../env.js";
import { logInfo, logWarn, logError } from "../logger.js";
import { runDailyRefresh } from "./jobs/daily-refresh.js";
import { runRetryUnprocessed } from "./jobs/retry-unprocessed.js";
import { runCleanupEvents } from "./jobs/cleanup-events.js";
import { runScheduledSpendMatch } from "./jobs/scheduled-spend-match.js";
import { runDailyBrief } from "./jobs/daily-brief.js";

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
    makeCron("0 9 * * *",    "daily-refresh",         () => runDailyRefresh(env)),
    makeCron("*/10 * * * *", "retry-unprocessed",     () => runRetryUnprocessed(env)),
    makeCron("0 3 * * *",    "cleanup-events",        () => runCleanupEvents(env)),
    makeCron("5 9 * * *",    "scheduled-spend-match", () => runScheduledSpendMatch(env)),
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
