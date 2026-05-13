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
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
