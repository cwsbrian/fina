import { loadEnv } from "./env.js";
import { buildApp } from "./server.js";
import { backfillWebhookUrls } from "./plaid/webhook-backfill.js";

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  // Detached — don't block server start. Backfill logs internally.
  void backfillWebhookUrls(env).catch((err) => {
    console.error("webhook backfill failed", err);
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
  console.error(err);
  process.exit(1);
});
