import { describe, it, expect } from "vitest";
import { loadEnv } from "../src/env.js";

// Minimal env that satisfies all other required fields.
const base = {
  NODE_ENV: "test" as const,
  DATABASE_URL: "postgresql://fina:fina@localhost:5433/fina",
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox",
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
  TRUST_PROXY: "false",
};

describe("CRON env vars", () => {
  it("CRON_ENABLED is undefined (falsy) when absent", () => {
    const env = loadEnv(base);
    expect(env.CRON_ENABLED).toBeUndefined();
  });

  it("CRON_ENABLED parses 'true' as true", () => {
    const env = loadEnv({ ...base, CRON_ENABLED: "true" });
    expect(env.CRON_ENABLED).toBe(true);
  });

  it("CRON_ENABLED parses '1' as true", () => {
    const env = loadEnv({ ...base, CRON_ENABLED: "1" });
    expect(env.CRON_ENABLED).toBe(true);
  });

  it("CRON_ENABLED parses 'false' as false", () => {
    const env = loadEnv({ ...base, CRON_ENABLED: "false" });
    expect(env.CRON_ENABLED).toBe(false);
  });

  it("CRON_EVENT_TTL_DAYS is undefined when absent", () => {
    const env = loadEnv(base);
    expect(env.CRON_EVENT_TTL_DAYS).toBeUndefined();
  });

  it("CRON_EVENT_TTL_DAYS parses '7' as 7", () => {
    const env = loadEnv({ ...base, CRON_EVENT_TTL_DAYS: "7" });
    expect(env.CRON_EVENT_TTL_DAYS).toBe(7);
  });
});
