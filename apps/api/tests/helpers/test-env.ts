import type { Env } from "../../src/env.js";

/** Single source of truth for test env fixtures. Inline `const env = {...}`
 *  literals in test files break every time the Env schema gains a required
 *  field. This helper absorbs that churn. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://fina:fina@localhost:5433/fina_test",
    BETTER_AUTH_SECRET: "x".repeat(48),
    BETTER_AUTH_URL: "http://localhost:0",
    EMAIL_FROM: "test@fina.app",
    WEB_APP_URL: "http://localhost:3000",
    PLAID_CLIENT_ID: "x",
    PLAID_SECRET: "x",
    PLAID_ENV: "sandbox",
    ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    DEEPSEEK_API_KEY: "x",
    CHAT_MODEL: "deepseek-v4-flash",
    LLM_BUDGET_USD_TO_CAD_RATE: 1.4,
    PRISMA_CONNECTION_LIMIT: 10,
    TRUST_PROXY: false,
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
    STRIPE_PRICE_MAX_MONTHLY: "price_max_test",
    ...overrides,
  };
}
