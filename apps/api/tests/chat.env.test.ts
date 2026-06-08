import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const BASE = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://fina:fina@localhost:5433/fina",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:4000",
  WEB_APP_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  STRIPE_PRICE_MAX_MONTHLY: "price_max_test",
  LLM_BUDGET_USD_TO_CAD_RATE: 1.4,
  PLAID_CLIENT_ID: "x",
  PLAID_SECRET: "x",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  DEEPSEEK_API_KEY: "x",
  TRUST_PROXY: "false",
};

describe("chat env keys", () => {
  it("CHAT_HISTORY_LIMIT_MESSAGES, CHAT_HISTORY_BUDGET_TOKENS, CHAT_MAX_TOOL_CALLS_PER_TURN, CHAT_MODEL are optional", () => {
    const env = loadEnv(BASE);
    expect(env.CHAT_HISTORY_LIMIT_MESSAGES).toBeUndefined();
    expect(env.CHAT_HISTORY_BUDGET_TOKENS).toBeUndefined();
    expect(env.CHAT_MAX_TOOL_CALLS_PER_TURN).toBeUndefined();
    expect(env.CHAT_MODEL).toBeUndefined();
  });

  it("parses numeric strings via z.coerce", () => {
    const env = loadEnv({ ...BASE, CHAT_HISTORY_LIMIT_MESSAGES: "200", CHAT_HISTORY_BUDGET_TOKENS: "400000", CHAT_MAX_TOOL_CALLS_PER_TURN: "25" });
    expect(env.CHAT_HISTORY_LIMIT_MESSAGES).toBe(200);
    expect(env.CHAT_HISTORY_BUDGET_TOKENS).toBe(400000);
    expect(env.CHAT_MAX_TOOL_CALLS_PER_TURN).toBe(25);
  });

  it("rejects non-positive integers", () => {
    expect(() => loadEnv({ ...BASE, CHAT_HISTORY_LIMIT_MESSAGES: "0" })).toThrow(/CHAT_HISTORY_LIMIT_MESSAGES/);
  });
});
