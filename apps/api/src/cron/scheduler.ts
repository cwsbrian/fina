import { Cron } from "croner";
import type { Env } from "../env.js";
import { runDailyRefresh } from "./jobs/daily-refresh.js";
import { runRetryUnprocessed } from "./jobs/retry-unprocessed.js";
import { runCleanupEvents } from "./jobs/cleanup-events.js";
import { runScheduledSpendMatch } from "./jobs/scheduled-spend-match.js";

let jobs: Cron[] = [];

export function startScheduler(env: Env): void {
  if (!env.CRON_ENABLED) return;

  jobs = [
    new Cron("0 9 * * *",    { protect: true, name: "daily-refresh" },     () => safe("daily-refresh",     () => runDailyRefresh(env))),
    new Cron("*/10 * * * *", { protect: true, name: "retry-unprocessed" }, () => safe("retry-unprocessed", () => runRetryUnprocessed(env))),
    new Cron("0 3 * * *",    { protect: true, name: "cleanup-events" },    () => safe("cleanup-events",    () => runCleanupEvents(env))),
    new Cron("5 9 * * *",    { protect: true, name: "scheduled-spend-match" }, () => safe("scheduled-spend-match", () => runScheduledSpendMatch(env))),  // 5 min after daily-refresh
  ];

  console.info("cron scheduler started", { jobs: jobs.map((j) => j.name) });
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
}

async function safe(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("cron job uncaught", { jobName: name, err: e });
  }
}
