import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, ".env.test") });

export default defineConfig({
  resolve: {
    alias: {
      "@fina/shared": path.resolve(__dirname, "../../libs/shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    hookTimeout: 30_000,
  },
});
