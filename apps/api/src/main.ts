import { loadEnv } from "./env.js";
import { buildApp } from "./server.js";

async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
