import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { createHash } from "node:crypto";
import { _clearCacheForTest, _injectJwkForTest } from "../../src/plaid/webhook-jwks.js";

export type WebhookKeyPair = {
  privateKey: KeyLike;
  publicKey: KeyLike;
  jwk: Record<string, unknown>;
  kid: string;
};

export async function generateWebhookKeys(kid = "test-kid-1"): Promise<WebhookKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = "ES256";
  jwk.use = "sig";
  return { privateKey, publicKey, jwk, kid };
}

/**
 * Sign a body buffer and return the plaid-verification JWT header value.
 * `iat` defaults to now (in seconds). Pass an older value to test iat_expired.
 */
export async function signWebhook(
  body: Buffer,
  privateKey: KeyLike,
  kid: string,
  iat: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return await new SignJWT({ request_body_sha256: bodyHash })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt(iat)
    .sign(privateKey);
}

/**
 * Inject a public key into the JWK cache so verification skips the Plaid API call.
 * `expiresAt` is an absolute ms timestamp; defaults to 1h from now.
 */
export function injectJwkForTest(kid: string, publicKey: KeyLike, expiresAt?: number): void {
  _injectJwkForTest(kid, publicKey, expiresAt ?? Date.now() + 60 * 60 * 1000);
}

export function resetJwkCache(): void {
  _clearCacheForTest();
}
