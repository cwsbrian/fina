import { describe, it, expect } from "vitest";
import { buildApp } from "../src/server.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: "postgresql://test",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

describe("GET /health", () => {
  it("returns ok with timestamp", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.time).toBe("string");
    await app.close();
  });
});
