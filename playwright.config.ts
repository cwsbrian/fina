import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests for Fina web app.
 *
 * Requires:
 *   - API running on $API_URL (default http://localhost:4000)
 *   - Web running on $WEB_URL (default http://localhost:3100)
 *   - PLAID_* env vars set for Plaid-specific tests (skipped otherwise)
 *   - DATABASE_URL for Postgres direct queries in helpers
 *
 * Run:
 *   pnpm e2e               # all tests, headless
 *   pnpm e2e:ui            # playwright UI mode
 *   pnpm e2e -- --grep "banks" --headed  # specific test, visible browser
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // tests share the same DB; serialize to avoid truncate races
  retries: 2, // transient 500s after Plaid network-intensive tests can require 2 retries
  reporter: "list",
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    actionTimeout: 8_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
