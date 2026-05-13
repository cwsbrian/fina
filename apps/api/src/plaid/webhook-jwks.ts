import { compactVerify, importJWK, type JWK } from "jose";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Env } from "../env.js";
import { plaidClient } from "./client.js";

const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IAT_WINDOW_S = 300;

export class PlaidWebhookVerifyError extends Error {
  constructor(public readonly code: string) {
    super(`Plaid webhook verification failed: ${code}`);
    this.name = "PlaidWebhookVerifyError";
  }
}

const PlaidJwtPayloadSchema = z.object({
  request_body_sha256: z.string(),
  iat: z.number(),
});

type CacheEntry = { key: CryptoKey; expiresAt: number };
const cache = new Map<string, CacheEntry>();

async function getJwk(env: Env, kid: string): Promise<CryptoKey> {
  const hit = cache.get(kid);
  if (hit && Date.now() < hit.expiresAt) return hit.key;

  const res = await plaidClient(env).webhookVerificationKeyGet({ key_id: kid });
  const jwk = res.data.key as JWK & { expired_at: number | null };

  if (jwk.expired_at !== null && jwk.expired_at * 1000 <= Date.now()) {
    throw new PlaidWebhookVerifyError("key_expired");
  }

  const key = await importJWK(jwk, "ES256");
  if (typeof key !== "object" || !("type" in key)) {
    throw new PlaidWebhookVerifyError("invalid_jwk");
  }
  const plaidExpiry = jwk.expired_at !== null ? jwk.expired_at * 1000 : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(Date.now() + MAX_CACHE_TTL_MS, plaidExpiry);
  cache.set(kid, { key: key as CryptoKey, expiresAt });
  return key as CryptoKey;
}

export async function verifyPlaidWebhook(
  env: Env,
  rawBody: Buffer,
  jwtHeader: string | undefined,
): Promise<void> {
  if (!jwtHeader) throw new PlaidWebhookVerifyError("missing_header");

  let payload: Uint8Array;
  let kid: string;
  try {
    const headerB64 = jwtHeader.split(".")[0];
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { kid?: string };
    if (!header.kid) throw new Error("no kid");
    kid = header.kid;
  } catch {
    throw new PlaidWebhookVerifyError("invalid_signature");
  }

  let key: CryptoKey;
  try {
    key = await getJwk(env, kid);
  } catch (e) {
    if (e instanceof PlaidWebhookVerifyError) throw e;
    throw new PlaidWebhookVerifyError("invalid_signature");
  }

  try {
    const verified = await compactVerify(jwtHeader, key, { algorithms: ["ES256"] });
    payload = verified.payload;
  } catch {
    throw new PlaidWebhookVerifyError("invalid_signature");
  }

  let claims: z.infer<typeof PlaidJwtPayloadSchema>;
  try {
    claims = PlaidJwtPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    throw new PlaidWebhookVerifyError("invalid_claims");
  }

  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (claims.request_body_sha256 !== bodyHash) {
    throw new PlaidWebhookVerifyError("body_mismatch");
  }

  if (Math.abs(Date.now() / 1000 - claims.iat) > IAT_WINDOW_S) {
    throw new PlaidWebhookVerifyError("iat_expired");
  }
}

// Test-only helpers. Not part of the public surface.
export function _clearCacheForTest(): void {
  cache.clear();
}
export function _injectJwkForTest(kid: string, key: CryptoKey, expiresAt: number): void {
  cache.set(kid, { key, expiresAt });
}
