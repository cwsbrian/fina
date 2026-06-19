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

const makeTx = (
  overrides: Partial<{
    bundleId: string;
    environment: string;
    signedDate: number;
    appAccountToken: string | undefined;
    productId: string;
    originalTransactionId: string;
  }> = {},
) => {
  const tx: Record<string, unknown> = {
    bundleId: overrides.bundleId ?? "com.fina.app",
    environment: overrides.environment ?? "Sandbox",
    signedDate: overrides.signedDate ?? Date.now(),
    productId: overrides.productId ?? "max_monthly",
    originalTransactionId: overrides.originalTransactionId ?? "1000000000000001",
    transactionId: "1000000000000099",
  };
  // Use hasOwn to distinguish explicit undefined from omitted key
  if (
    !Object.prototype.hasOwnProperty.call(overrides, "appAccountToken") ||
    overrides.appAccountToken !== undefined
  ) {
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
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ bundleId: "com.other.app" }),
    );
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({
      code: "invalid_receipt",
    });
  });

  it("rejects sandbox JWS in production env", async () => {
    const prodCfg = { ...cfg, env: "production" as const, appAppleId: 1234567890 };
    const c = new AppleClient(prodCfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ environment: "Sandbox" }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({
      code: "invalid_receipt",
    });
  });

  it("rejects when signedDate is too old (ASC-API 10min window)", async () => {
    const c = new AppleClient(cfg);
    const old = Date.now() - 11 * 60 * 1000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: old }));
    await expect(c.verifyAndDecodeTransaction("x", { context: "asc-api" })).rejects.toMatchObject({
      code: "expired_receipt",
    });
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
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ signedDate: oldRestoreTx }),
    );
    const out = await c.verifyAndDecodeTransaction("x", { context: "restore" });
    expect(out).toBeDefined();
  });

  it("accepts old checkout payloads when Apple returns an already-owned subscription", async () => {
    const c = new AppleClient(cfg);
    const oldCheckoutTx = Date.now() - 30 * 86400_000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ signedDate: oldCheckoutTx }),
    );
    const out = await c.verifyAndDecodeTransaction("x", { context: "checkout" });
    expect(out).toBeDefined();
  });

  it("rejects when appAccountToken is missing", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ appAccountToken: undefined }),
    );
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({
      code: "user_mismatch",
    });
  });

  it("accepts missing appAccountToken for restore payloads", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ appAccountToken: undefined }),
    );
    const out = await c.verifyAndDecodeTransaction("x", { context: "restore" });
    expect(out.appAccountToken).toBeNull();
  });

  it("accepts missing appAccountToken for ASC status payloads", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(
      makeTx({ appAccountToken: undefined }),
    );
    const out = await c.verifyAndDecodeTransaction("x", { context: "asc-api" });
    expect(out.appAccountToken).toBeNull();
  });

  it("rejects future-dated signedDate beyond 30s skew", async () => {
    const c = new AppleClient(cfg);
    const future = Date.now() + 60_000; // 60s in the future
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: future }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({
      code: "expired_receipt",
    });
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

  it("surfaces pendingProductId from autoRenewProductId when a plan change is queued", async () => {
    const c = new AppleClient(cfg);
    const expiresDate = Date.now() + 30 * 86400_000;
    (c as any).asc = {
      getAllSubscriptionStatuses: vi.fn().mockResolvedValue({
        data: [
          {
            lastTransactions: [
              { status: 1, signedTransactionInfo: "tx-jws", signedRenewalInfo: "renewal-jws" },
            ],
          },
        ],
      }),
    };
    vi.spyOn(c, "verifyAndDecodeTransaction").mockResolvedValue({
      ...makeTx({ productId: "max_monthly" }),
      bundleId: "com.fina.app",
      environment: "Sandbox",
      raw: { expiresDate },
    } as any);
    vi.spyOn(c, "verifyAndDecodeRenewalInfo").mockResolvedValue({
      autoRenewStatus: 1,
      autoRenewProductId: "fina_pro_monthly",
    });

    const out = await c.getSubscriptionStatus("OT-1");
    expect(out.productId).toBe("max_monthly");
    expect(out.pendingProductId).toBe("fina_pro_monthly");
    expect(out.pendingAt?.getTime()).toBe(expiresDate);
  });

  it("chooses the newest active lastTransaction when Apple returns multiple products", async () => {
    const c = new AppleClient(cfg);
    const proPurchaseDate = Date.now() - 60_000;
    const maxPurchaseDate = Date.now();
    const proExpiresDate = Date.now() + 5 * 60_000;
    const maxExpiresDate = Date.now() + 10 * 60_000;
    (c as any).asc = {
      getAllSubscriptionStatuses: vi.fn().mockResolvedValue({
        data: [
          {
            lastTransactions: [
              { status: 1, signedTransactionInfo: "pro-tx-jws", signedRenewalInfo: "pro-renewal-jws" },
              { status: 1, signedTransactionInfo: "max-tx-jws", signedRenewalInfo: "max-renewal-jws" },
            ],
          },
        ],
      }),
    };
    vi.spyOn(c, "verifyAndDecodeTransaction").mockImplementation(async (jws) => {
      if (jws === "pro-tx-jws") {
        return {
          ...makeTx({ productId: "fina_pro_monthly" }),
          bundleId: "com.fina.app",
          environment: "Sandbox",
          raw: { expiresDate: proExpiresDate, purchaseDate: proPurchaseDate },
        } as any;
      }
      return {
        ...makeTx({ productId: "max_monthly" }),
        bundleId: "com.fina.app",
        environment: "Sandbox",
        raw: { expiresDate: maxExpiresDate, purchaseDate: maxPurchaseDate },
      } as any;
    });
    vi.spyOn(c, "verifyAndDecodeRenewalInfo").mockResolvedValue({
      autoRenewStatus: 1,
      autoRenewProductId: "max_monthly",
    });

    const out = await c.getSubscriptionStatus("OT-1");

    expect(out.productId).toBe("max_monthly");
    expect(out.expiresDate.getTime()).toBe(maxExpiresDate);
  });
});
