import { loadEnv } from "./env.js";
import { buildApp } from "./server.js";
import { backfillWebhookUrls } from "./plaid/webhook-backfill.js";
import { logger, logFatal, logError } from "./logger.js";

// 1s watchdog: if pino's flush stalls (e.g. stdout pipe back-pressure),
// kill the process anyway. .unref() so the timer never keeps the loop
// alive when flush completes first.
function flushAndExit(code: number): void {
  setTimeout(() => process.exit(code), 1000).unref();
  logger.flush(() => process.exit(code));
}

// Register process handlers BEFORE any async work so a startup crash
// still gets logged + flushed.
process.on("unhandledRejection", (reason) => {
  logFatal({ err: reason }, "unhandled_rejection");
  flushAndExit(1);
});
process.on("uncaughtException", (err) => {
  logFatal({ err }, "uncaught_exception");
  flushAndExit(1);
});

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  // Detached — don't block server start. Backfill logs internally.
  void backfillWebhookUrls(env).catch((err) => {
    logError({ err }, "webhook backfill failed");
  });

  let stopScheduler: (() => void) | undefined;
  if (env.CRON_ENABLED) {
    const scheduler = await import("./cron/scheduler.js");
    scheduler.startScheduler(env);
    stopScheduler = scheduler.stopScheduler;
  }

  const shutdown = async () => {
    stopScheduler?.();
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

start().catch((err) => {
  logFatal({ err }, "start_failed");
  flushAndExit(1);
});
