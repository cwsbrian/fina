import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/env.js";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost/x",
    BETTER_AUTH_SECRET: "x".repeat(48),
    BETTER_AUTH_URL: "http://localhost:0",
    WEB_APP_URL: "http://localhost:3000",
    PLAID_CLIENT_ID: "x",
    PLAID_SECRET: "x",
    ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    DEEPSEEK_API_KEY: "x",
    TRUST_PROXY: "false", // 1J Task 2 strict opt-in requires explicit value
    // 1K: billing-stripe merged 4 required Stripe env vars. Use clear
    // "_stub" suffixes so future readers see they're test fixtures.
    STRIPE_SECRET_KEY: "sk_test_stub",
    STRIPE_WEBHOOK_SECRET: "whsec_stub",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_stub",
    STRIPE_PRICE_MAX_MONTHLY: "price_max_stub",
    LLM_BUDGET_USD_TO_CAD_RATE: 1.4,
  };
}

const adminEnv = {
  ADMIN_TOKEN_PUBLIC_KEYS: '{"test":"non-secret-test-value"}',
  ADMIN_TOKEN_ISSUER: "https://admin.buildingintent.com",
  ADMIN_EMAIL: "operator@example.com",
};

describe("loadEnv RESEND_API_KEY refine", () => {
  it("rejects production startup with missing RESEND_API_KEY", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "production" };
    expect(() => loadEnv()).toThrow(/RESEND_API_KEY/);
    process.env = old;
  });

  it("rejects production with short or stub RESEND_API_KEY", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "production", RESEND_API_KEY: "re_..." };
    expect(() => loadEnv()).toThrow(/RESEND_API_KEY/);
    process.env = { ...baseEnv(), NODE_ENV: "production", RESEND_API_KEY: "re_dev_stub" };
    expect(() => loadEnv()).toThrow(/RESEND_API_KEY/);
    process.env = old;
  });

  it("accepts production with a real-looking RESEND_API_KEY", () => {
    const old = process.env;
    process.env = {
      ...baseEnv(),
      ...adminEnv,
      NODE_ENV: "production",
      RESEND_API_KEY: "re_" + "a".repeat(24),
    };
    expect(() => loadEnv()).not.toThrow();
    process.env = old;
  });

  it("dev/test accept missing RESEND_API_KEY", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development" };
    expect(() => loadEnv()).not.toThrow();
    process.env = { ...baseEnv(), NODE_ENV: "test" };
    expect(() => loadEnv()).not.toThrow();
    process.env = old;
  });
});

describe("loadEnv new keys", () => {
  it("requires all admin delegation variables in production", () => {
    expect(() =>
      loadEnv({
        ...baseEnv(),
        NODE_ENV: "production",
        RESEND_API_KEY: "re_" + "a".repeat(24),
      }),
    ).toThrow(/ADMIN_TOKEN_PUBLIC_KEYS.*ADMIN_TOKEN_ISSUER.*ADMIN_EMAIL/);
  });

  it("PRISMA_CONNECTION_LIMIT defaults to 10", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development" };
    expect(loadEnv().PRISMA_CONNECTION_LIMIT).toBe(10);
    process.env = old;
  });

  it("PRISMA_CONNECTION_LIMIT honours env override", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development", PRISMA_CONNECTION_LIMIT: "20" };
    expect(loadEnv().PRISMA_CONNECTION_LIMIT).toBe(20);
    process.env = old;
  });

  it("RATE_LIMIT_TEST is optional", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "test", RATE_LIMIT_TEST: "1" };
    expect(loadEnv().RATE_LIMIT_TEST).toBe("1");
    process.env = old;
  });
});

describe("loadEnv TRUST_PROXY strict opt-in", () => {
  it("rejects production with unset TRUST_PROXY", () => {
    const old = process.env;
    const { TRUST_PROXY: _drop, ...noTrust } = baseEnv();
    void _drop;
    process.env = {
      ...noTrust,
      NODE_ENV: "production",
      RESEND_API_KEY: "re_" + "a".repeat(24),
    };
    expect(() => loadEnv()).toThrow(/TRUST_PROXY/);
    process.env = old;
  });

  it("rejects dev with unset TRUST_PROXY", () => {
    const old = process.env;
    const { TRUST_PROXY: _drop, ...noTrust } = baseEnv();
    void _drop;
    process.env = { ...noTrust, NODE_ENV: "development" };
    expect(() => loadEnv()).toThrow(/TRUST_PROXY/);
    process.env = old;
  });

  it("accepts TRUST_PROXY=true in production (assumed behind a CDN)", () => {
    const old = process.env;
    process.env = {
      ...baseEnv(),
      ...adminEnv,
      NODE_ENV: "production",
      RESEND_API_KEY: "re_" + "a".repeat(24),
      TRUST_PROXY: "true",
    };
    expect(loadEnv().TRUST_PROXY).toBe(true);
    process.env = old;
  });

  it("accepts TRUST_PROXY=false in dev", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development", TRUST_PROXY: "false" };
    expect(loadEnv().TRUST_PROXY).toBe(false);
    process.env = old;
  });
});
