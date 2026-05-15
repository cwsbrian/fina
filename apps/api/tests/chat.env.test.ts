import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const BASE = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://fina:fina@localhost:5433/fina",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:4000",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "x",
  PLAID_SECRET: "x",
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  GEMINI_API_KEY: "x",
};

describe("chat env keys", () => {
  it("CHAT_HISTORY_LIMIT, CHAT_MAX_TOOL_CALLS_PER_TURN, CHAT_MODEL are optional", () => {
    const env = loadEnv(BASE);
    expect(env.CHAT_HISTORY_LIMIT).toBeUndefined();
    expect(env.CHAT_MAX_TOOL_CALLS_PER_TURN).toBeUndefined();
    expect(env.CHAT_MODEL).toBeUndefined();
  });

  it("parses numeric strings via z.coerce", () => {
    const env = loadEnv({ ...BASE, CHAT_HISTORY_LIMIT: "50", CHAT_MAX_TOOL_CALLS_PER_TURN: "25" });
    expect(env.CHAT_HISTORY_LIMIT).toBe(50);
    expect(env.CHAT_MAX_TOOL_CALLS_PER_TURN).toBe(25);
  });

  it("rejects non-positive integers", () => {
    expect(() => loadEnv({ ...BASE, CHAT_HISTORY_LIMIT: "0" })).toThrow(/CHAT_HISTORY_LIMIT/);
  });
});
