import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyApplePayload,
  verifyGoogleEnvelope,
} from "../../src/iap/webhook-verify.js";
import type { AppleIapConfig, GoogleIapConfig } from "../../src/iap/env-guard.js";

const appleCfg: AppleIapConfig = {
  bundleId: "com.fina.app",
  ascIssuerId: "00000000-0000-0000-0000-000000000000",
  ascKeyId: "K1",
  ascPrivateKey: "fake",
  env: "sandbox",
};

const googleCfg: GoogleIapConfig = {
  packageName: "app.fina",
  serviceAccount: { client_email: "iap@fina.iam.gserviceaccount.com", private_key: "k" } as any,
  pubsubVerifyAudience: "https://api.fina.app/webhooks/iap/google",
  pubsubVerifyEmail: "iap@fina.iam.gserviceaccount.com",
  pubsubSubscriptionName: "projects/fina/subscriptions/iap-rtdn",
};

describe("verifyApplePayload", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("delegates to AppleClient.verifyAndDecodeNotification and returns flat shape", async () => {
    const fakeClient = {
      verifyAndDecodeNotification: vi.fn().mockResolvedValue({
        notificationUUID: "uuid-1",
        notificationType: "DID_RENEW",
        signedTransactionJws: "tx-jws",
        raw: {},
      }),
    };
    const out = await verifyApplePayload("signed-payload-string", appleCfg, { appleClient: fakeClient as any });
    expect(out.notificationUUID).toBe("uuid-1");
    expect(out.signedTransactionJws).toBe("tx-jws");
    expect(fakeClient.verifyAndDecodeNotification).toHaveBeenCalledWith("signed-payload-string");
  });
});

describe("verifyGoogleEnvelope", () => {
  beforeEach(() => vi.restoreAllMocks());

  const makeEnvelope = (overrides: any = {}) => ({
    message: {
      data: Buffer.from(JSON.stringify({
        subscriptionNotification: {
          purchaseToken: "tok-1",
          subscriptionId: "max_monthly",
          notificationType: 4,
        },
      })).toString("base64"),
      messageId: "msg-1",
    },
    subscription: overrides.subscription ?? googleCfg.pubsubSubscriptionName,
  });

  const makeOidcOk = () => ({ verifyIdToken: vi.fn().mockResolvedValue({
    getPayload: () => ({
      aud: googleCfg.pubsubVerifyAudience,
      iss: "https://accounts.google.com",
      email: googleCfg.pubsubVerifyEmail,
      azp: "113774264463038321964",
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  }) });

  it("happy path returns parsed subscriptionNotification", async () => {
    const out = await verifyGoogleEnvelope(
      "Bearer fake-jwt",
      makeEnvelope(),
      googleCfg,
      { oidcClient: makeOidcOk() as any },
    );
    expect(out.kind).toBe("subscription");
    if (out.kind === "subscription") expect(out.payload.purchaseToken).toBe("tok-1");
  });

  it("rejects when subscription name mismatches", async () => {
    await expect(
      verifyGoogleEnvelope(
        "Bearer fake-jwt",
        makeEnvelope({ subscription: "projects/evil/subscriptions/x" }),
        googleCfg,
        { oidcClient: makeOidcOk() as any },
      ),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when audience mismatches", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: "wrong", iss: "https://accounts.google.com", email: googleCfg.pubsubVerifyEmail, azp: "113774264463038321964", email_verified: true, exp: Math.floor(Date.now()/1000)+60 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when email mismatches", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: googleCfg.pubsubVerifyAudience, iss: "https://accounts.google.com", email: "attacker@evil.com", azp: "113774264463038321964", email_verified: true, exp: Math.floor(Date.now()/1000)+60 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects expired token (zero clock skew)", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: googleCfg.pubsubVerifyAudience, iss: "https://accounts.google.com", email: googleCfg.pubsubVerifyEmail, azp: "113774264463038321964", email_verified: true, exp: Math.floor(Date.now()/1000) - 10 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("returns kind=ignore for non-subscription notifications", async () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ testNotification: { version: "1.0" } })).toString("base64"),
        messageId: "msg-2",
      },
      subscription: googleCfg.pubsubSubscriptionName,
    };
    const out = await verifyGoogleEnvelope(
      "Bearer x", envelope, googleCfg, { oidcClient: makeOidcOk() as any },
    );
    expect(out.kind).toBe("ignore");
  });
});
