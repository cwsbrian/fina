import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "x",
  PLAID_SECRET: "x",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "x",
  PRISMA_CONNECTION_LIMIT: 10,
  TRUST_PROXY: false,
};

describe("Helmet headers", () => {
  it("GET /health returns x-frame-options DENY and a strict CSP", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(String(csp)).toContain("default-src 'none'");
    await app.close();
  });
});
