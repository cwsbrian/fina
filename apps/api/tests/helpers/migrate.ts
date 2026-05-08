import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let applied = false;

export function ensureMigrationsApplied(): void {
  if (applied) return;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  execSync("pnpm prisma migrate deploy", {
    stdio: "ignore",
    cwd: path.resolve(__dirname, "../.."),
    env: process.env,
  });
  applied = true;
}
