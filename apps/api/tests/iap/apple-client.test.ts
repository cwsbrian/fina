// apps/api/tests/iap/apple-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleClient } from "../../src/iap/apple-client.js";
import type { AppleIapConfig } from "../../src/iap/env-guard.js";

const cfg: AppleIapConfig = {
  bundleId: "com.fina.app",
  ascIssuerId: "00000000-0000-0000-0000-000000000000",
  ascKeyId: "K1",
  ascPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  env: "sandbox",
};

const makeTx = (overrides: Partial<{
  bundleId: string; environment: string; signedDate: number;
  appAccountToken: string | undefined; productId: string; originalTransactionId: string;
}> = {}) => {
  const tx: Record<string, unknown> = {
    bundleId: overrides.bundleId ?? "com.fina.app",
    environment: overrides.environment ?? "Sandbox",
    signedDate: overrides.signedDate ?? Date.now(),
    productId: overrides.productId ?? "max_monthly",
    originalTransactionId: overrides.originalTransactionId ?? "1000000000000001",
    transactionId: "1000000000000099",
  };
  // Use hasOwn to distinguish explicit undefined from omitted key
  if (!Object.prototype.hasOwnProperty.call(overrides, "appAccountToken") || overrides.appAccountToken !== undefined) {
    tx.appAccountToken = overrides.appAccountToken ?? "00000000-0000-0000-0000-000000000aaa";
  }
  return tx;
};

describe("AppleClient.verifyAndDecodeTransaction", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("happy path returns decoded transaction", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx());
    const out = await c.verifyAndDecodeTransaction("jws-string");
    expect(out.productId).toBe("max_monthly");
    expect(out.originalTransactionId).toBe("1000000000000001");
  });

  it("rejects when bundleId mismatch", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ bundleId: "com.other.app" }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects sandbox JWS in production env", async () => {
    const prodCfg = { ...cfg, env: "production" as const, appAppleId: 1234567890 };
    const c = new AppleClient(prodCfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ environment: "Sandbox" }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when signedDate is too old (ASC-API 10min window)", async () => {
    const c = new AppleClient(cfg);
    const old = Date.now() - 11 * 60 * 1000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: old }));
    await expect(c.verifyAndDecodeTransaction("x", { context: "asc-api" })).rejects.toMatchObject({ code: "expired_receipt" });
  });

  it("accepts older payload in ASSN window (1h)", async () => {
    const c = new AppleClient(cfg);
    const oldButOk = Date.now() - 55 * 60 * 1000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: oldButOk }));
    const out = await c.verifyAndDecodeTransaction("x", { context: "assn" });
    expect(out).toBeDefined();
  });

  it("accepts old restore payloads after signature verification", async () => {
    const c = new AppleClient(cfg);
    const oldRestoreTx = Date.now() - 30 * 86400_000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: oldRestoreTx }));
    const out = await c.verifyAndDecodeTransaction("x", { context: "restore" });
    expect(out).toBeDefined();
  });

  it("accepts old checkout payloads when Apple returns an already-owned subscription", async () => {
    const c = new AppleClient(cfg);
    const oldCheckoutTx = Date.now() - 30 * 86400_000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: oldCheckoutTx }));
    const out = await c.verifyAndDecodeTransaction("x", { context: "checkout" });
    expect(out).toBeDefined();
  });

  it("rejects when appAccountToken is missing", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ appAccountToken: undefined }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "user_mismatch" });
  });

  it("rejects future-dated signedDate beyond 30s skew", async () => {
    const c = new AppleClient(cfg);
    const future = Date.now() + 60_000; // 60s in the future
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: future }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "expired_receipt" });
  });
});

describe("AppleClient.getSubscriptionStatus", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("preserves Apple APIException details in platform_unavailable errors", async () => {
    const c = new AppleClient(cfg);
    (c as any).asc = {
      getAllSubscriptionStatuses: vi.fn().mockRejectedValue({
        name: "Error",
        httpStatusCode: 401,
        apiError: 4010002,
        errorMessage: "Invalid app identifier",
      }),
    };

    await expect(c.getSubscriptionStatus("OT-1")).rejects.toMatchObject({
      code: "platform_unavailable",
      message: "asc api: status=401 apiError=4010002 errorMessage=Invalid app identifier",
    });
  });
});
