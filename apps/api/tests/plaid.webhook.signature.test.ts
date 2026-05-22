import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetPlaidMock, plaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import {
  generateWebhookKeys,
  signWebhook,
  injectJwkForTest,
  resetJwkCache,
  type WebhookKeyPair,
} from "./helpers/plaid-webhook-mock.js";
import {
  verifyPlaidWebhook,
  PlaidWebhookVerifyError,
} from "../src/plaid/webhook-jwks.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let keys: WebhookKeyPair;

beforeEach(async () => {
  resetPlaidMock();
  resetJwkCache();
  keys = await generateWebhookKeys();
});

describe("verifyPlaidWebhook", () => {
  it("accepts a valid JWT + matching body hash", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const body = Buffer.from(JSON.stringify({ webhook_type: "TRANSACTIONS", item_id: "i1" }));
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).resolves.toBeUndefined();
  });

  it("throws missing_header when JWT is undefined", async () => {
    const body = Buffer.from("{}");
    await expect(verifyPlaidWebhook(env, body, undefined)).rejects.toMatchObject({
      code: "missing_header",
    });
  });

  it("throws invalid_signature when JWT was signed by a different key", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const otherKeys = await generateWebhookKeys("test-kid-1"); // same kid, different actual key
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, otherKeys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "invalid_signature",
    });
  });

  it("throws body_mismatch when body hash claim doesn't match raw body", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const signedBody = Buffer.from('{"webhook_type":"TRANSACTIONS"}');
    const actualBody = Buffer.from('{"webhook_type":"ITEM"}'); // different bytes
    const jwt = await signWebhook(signedBody, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, actualBody, jwt)).rejects.toMatchObject({
      code: "body_mismatch",
    });
  });

  it("throws iat_expired when iat is more than 5 minutes old", async () => {
    injectJwkForTest(keys.kid, keys.publicKey);
    const body = Buffer.from("{}");
    const oldIat = Math.floor(Date.now() / 1000) - 301; // 5min 1s ago
    const jwt = await signWebhook(body, keys.privateKey, keys.kid, oldIat);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "iat_expired",
    });
  });

  it("fetches JWK from Plaid on cache miss and caches it", async () => {
    plaidMock.webhookVerificationKeyGet.push({ data: { key: { ...keys.jwk, expired_at: null } } });
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);

    await verifyPlaidWebhook(env, body, jwt);
    expect(plaidMock.webhookVerificationKeyGet.length).toBe(0); // consumed

    // Second call uses cache — no second Plaid call needed.
    const body2 = Buffer.from("{}");
    const jwt2 = await signWebhook(body2, keys.privateKey, keys.kid);
    await verifyPlaidWebhook(env, body2, jwt2); // would throw if it tried to pop from empty mock queue
  });

  it("rejects already-expired JWK from Plaid", async () => {
    const pastUnix = Math.floor(Date.now() / 1000) - 60;
    plaidMock.webhookVerificationKeyGet.push({
      data: { key: { ...keys.jwk, expired_at: pastUnix } },
    });
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);
    await expect(verifyPlaidWebhook(env, body, jwt)).rejects.toMatchObject({
      code: "key_expired",
    });
  });

  it("respects Plaid expired_at when shorter than max TTL", async () => {
    // Inject a key with an explicit short expiry (5 seconds from now).
    const shortExpiry = Date.now() + 5000;
    injectJwkForTest(keys.kid, keys.publicKey, shortExpiry);
    const body = Buffer.from("{}");
    const jwt = await signWebhook(body, keys.privateKey, keys.kid);

    // Within expiry: ok.
    await expect(verifyPlaidWebhook(env, body, jwt)).resolves.toBeUndefined();

    // Simulate time passing past the cache expiry — cache miss should re-fetch.
    vi.useFakeTimers();
    vi.setSystemTime(shortExpiry + 1);
    plaidMock.webhookVerificationKeyGet.push({
      data: { key: { ...keys.jwk, expired_at: null } },
    });
    const jwt2 = await signWebhook(body, keys.privateKey, keys.kid, Math.floor(shortExpiry / 1000));
    await expect(verifyPlaidWebhook(env, body, jwt2)).resolves.toBeUndefined();
    expect(plaidMock.webhookVerificationKeyGet.length).toBe(0);
    vi.useRealTimers();
  });
});
