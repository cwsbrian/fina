import { describe, it, expect } from "vitest";
import { redactEnv } from "../../src/iap/redactEnv.js";

describe("redactEnv", () => {
  it("masks every IAP secret while preserving other env keys", () => {
    const out = redactEnv({
      NODE_ENV: "test",
      APPLE_ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGTAg...",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN..."}',
      DATABASE_URL: "postgres://u:p@h/d",
    } as any);
    expect(out.NODE_ENV).toBe("test");
    expect(out.APPLE_ASC_PRIVATE_KEY).toBe("[REDACTED]");
    expect(out.GOOGLE_SERVICE_ACCOUNT_JSON).toBe("[REDACTED]");
    expect(out.DATABASE_URL).toBe("postgres://u:p@h/d");
  });
});
