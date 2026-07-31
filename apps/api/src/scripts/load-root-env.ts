import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

/** Production injects env vars directly; local admin commands use the root
 * .env when present. Node's built-in loader avoids a dev-only dotenv runtime
 * dependency in the production image. */
export function loadRootEnv(): void {
  const path = resolve(fileURLToPath(new URL("../../../..", import.meta.url)), ".env");
  if (existsSync(path)) loadEnvFile(path);
}
