import { describe, it, expect } from "vitest";
import { requireIapEnv } from "../../src/iap/env-guard.js";

const APPLE_ONLY = {
  APPLE_BUNDLE_ID: "com.fina.app",
  APPLE_ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  APPLE_ASC_KEY_ID: "ABCDEF1234",
  APPLE_ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGTAg...\n-----END PRIVATE KEY-----\n",
  APPLE_ENV: "sandbox" as const,
};

describe("requireIapEnv", () => {
  it("returns apple+google configs when all set", () => {
    const env = {
      ...APPLE_ONLY,
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n"}',
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "https://api.fina.app/webhooks/iap/google",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "iap-pubsub@fina.iam.gserviceaccount.com",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "projects/fina/subscriptions/iap-rtdn",
    } as any;
    const cfg = requireIapEnv(env);
    expect(cfg.apple.bundleId).toBe("com.fina.app");
    expect(cfg.google.packageName).toBe("app.fina");
  });

  it("accepts base64-encoded GOOGLE_SERVICE_ACCOUNT_JSON", () => {
    const raw = '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n"}';
    const env = {
      ...APPLE_ONLY,
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(raw).toString("base64"),
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "x",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "y@z",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "n",
    } as any;
    const cfg = requireIapEnv(env);
    expect(cfg.google.serviceAccount.client_email).toBe("x@y");
  });

  it("throws 503 iap_not_configured when APPLE_ASC_PRIVATE_KEY missing", () => {
    const env: any = { ...APPLE_ONLY, APPLE_ASC_PRIVATE_KEY: undefined };
    let err: any;
    try { requireIapEnv(env); } catch (e) { err = e; }
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("iap_not_configured");
  });

  it("throws WITHOUT echoing any portion of the env value", () => {
    const env: any = { ...APPLE_ONLY, APPLE_ASC_PRIVATE_KEY: "leak-this-prefix-NOT" };
    let err: any;
    try {
      requireIapEnv({ ...env, APPLE_ASC_PRIVATE_KEY: "leak-this-prefix-NOT" });
    } catch (e) { err = e; }
    const msg = String(err?.message ?? "") + String(err?.stack ?? "");
    expect(msg).not.toContain("leak-this-prefix");
  });

  it("throws when APPLE_APP_APPLE_ID is missing in production", () => {
    const env: any = {
      ...APPLE_ONLY,
      APPLE_ENV: "production",
      APPLE_APP_APPLE_ID: undefined,
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}',
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "x",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "y@z",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "n",
    };
    let err: any;
    try { requireIapEnv(env); } catch (e) { err = e; }
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("iap_not_configured");
  });

  it("accepts production env with valid APPLE_APP_APPLE_ID", () => {
    const env: any = {
      ...APPLE_ONLY,
      APPLE_ENV: "production",
      APPLE_APP_APPLE_ID: "1234567890",
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n"}',
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "x",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "y@z",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "n",
    };
    const cfg = requireIapEnv(env);
    expect(cfg.apple.appAppleId).toBe(1234567890);
  });
});
