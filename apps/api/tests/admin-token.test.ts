import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createAdminTokenVerifier } from "../src/auth/admin-token.js";
import { parseAdminTokenPublicKeys } from "../src/env.js";

const NOW = 1_800_000_000;
const ISSUER = "https://admin.buildingintent.com";
const AUDIENCE = "fina-admin-api";
const ADMIN_EMAIL = "operator@example.com";
const KID = "hub-2026-07";

const keyPair = generateKeyPairSync("ed25519");
const otherKeyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

const verifier = createAdminTokenVerifier({
  issuer: ISSUER,
  audience: AUDIENCE,
  adminEmail: ADMIN_EMAIL,
  publicKeys: { [KID]: Buffer.from(publicKey).toString("base64") },
  now: () => NOW,
});

type TokenOverrides = {
  kid?: string;
  privateKey?: typeof keyPair.privateKey;
  issuer?: string;
  audience?: string;
  payload?: Record<string, unknown>;
};

async function token(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({
    email: ADMIN_EMAIL,
    scope: "admin:read",
    sub: "cf-operator-1",
    jti: "request-token-1",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 60,
    ...overrides.payload,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: overrides.kid ?? KID })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .sign(overrides.privateKey ?? keyPair.privateKey);
}

async function tokenWithoutKid(): Promise<string> {
  return new SignJWT({
    email: ADMIN_EMAIL,
    scope: "admin:read",
    sub: "cf-operator-1",
    jti: "request-token-1",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 60,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(keyPair.privateKey);
}

async function tokenWithWrongAlgorithm(): Promise<string> {
  return new SignJWT({
    email: ADMIN_EMAIL,
    scope: "admin:read",
    sub: "cf-operator-1",
    jti: "request-token-1",
    iat: NOW,
    nbf: NOW,
    exp: NOW + 60,
  })
    .setProtectedHeader({ alg: "HS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(new TextEncoder().encode("not-the-hub-signing-key"));
}

async function expectHttpError(
  authorization: string | undefined,
  statusCode: number,
  code: string,
): Promise<void> {
  const error = await verifier(authorization).catch((cause) => cause);
  expect(error).toMatchObject({ statusCode, code });
}

describe("createAdminTokenVerifier", () => {
  it("accepts the exact Fina delegation contract", async () => {
    await expect(verifier(`Bearer ${await token()}`)).resolves.toEqual({
      sub: "cf-operator-1",
      email: ADMIN_EMAIL,
      jti: "request-token-1",
    });
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer ", "bearer abc", "Bearer abc extra"])(
    "rejects a missing or malformed bearer header",
    async (authorization) => {
      await expectHttpError(authorization, 401, "unauthenticated");
    },
  );

  it.each([
    ["missing kid", () => tokenWithoutKid()],
    ["empty kid", () => token({ kid: "" })],
    ["unknown kid", () => token({ kid: "unknown" })],
    ["wrong algorithm", () => tokenWithWrongAlgorithm()],
    ["wrong signature", () => token({ privateKey: otherKeyPair.privateKey })],
    ["wrong issuer", () => token({ issuer: "https://wrong.example.com" })],
    ["wrong audience", () => token({ audience: "other-admin-api" })],
    ["Say Better audience", () => token({ audience: "saybetter-admin-api" })],
    ["expired token", () => token({ payload: { iat: NOW - 66, nbf: NOW - 66, exp: NOW - 6 } })],
    ["future token", () => token({ payload: { iat: NOW + 6, nbf: NOW + 6, exp: NOW + 60 } })],
  ])("rejects %s as unauthenticated", async (_name, makeToken) => {
    await expectHttpError(`Bearer ${await makeToken()}`, 401, "unauthenticated");
  });

  it.each([
    ["wrong email", { email: "someone@example.com" }],
    ["wrong scope", { scope: "admin:write" }],
    ["multi-valued scope", { scope: "admin:read other" }],
  ])("rejects %s as admin_required", async (_name, payload) => {
    await expectHttpError(`Bearer ${await token({ payload })}`, 403, "admin_required");
  });

  it.each(["sub", "jti", "iat", "nbf", "exp"])("rejects a missing %s claim", async (claim) => {
    const payload: Record<string, unknown> = {
      email: ADMIN_EMAIL,
      scope: "admin:read",
      sub: "cf-operator-1",
      jti: "request-token-1",
      iat: NOW,
      nbf: NOW,
      exp: NOW + 60,
    };
    delete payload[claim];
    const missingClaimToken = await new SignJWT(payload)
      .setProtectedHeader({ alg: "EdDSA", kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .sign(keyPair.privateKey);
    await expectHttpError(`Bearer ${missingClaimToken}`, 401, "unauthenticated");
  });

  it.each([
    ["empty sub", { sub: "" }],
    ["empty jti", { jti: "" }],
    ["lifetime over 60 seconds", { exp: NOW + 61 }],
    ["non-positive lifetime", { exp: NOW }],
    ["nbf different from iat", { nbf: NOW + 1 }],
  ])("rejects %s", async (_name, payload) => {
    await expectHttpError(`Bearer ${await token({ payload })}`, 401, "unauthenticated");
  });
});

describe("parseAdminTokenPublicKeys", () => {
  it("parses a nonempty kid-to-base64-SPKI object", () => {
    const encoded = Buffer.from(publicKey).toString("base64");
    expect(parseAdminTokenPublicKeys(JSON.stringify({ [KID]: encoded }))).toEqual({
      [KID]: encoded,
    });
  });

  it.each([
    ["missing", undefined],
    ["invalid JSON", "{"],
    ["array", "[]"],
    ["empty object", "{}"],
    ["empty kid", JSON.stringify({ "": Buffer.from(publicKey).toString("base64") })],
    ["non-string value", JSON.stringify({ [KID]: 1 })],
    ["invalid base64", JSON.stringify({ [KID]: "***" })],
    ["non-public-key text", JSON.stringify({ [KID]: Buffer.from("secret").toString("base64") })],
  ])("rejects %s without exposing the configured value", (_name, value) => {
    let message = "";
    try {
      parseAdminTokenPublicKeys(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("ADMIN_TOKEN_PUBLIC_KEYS is invalid");
    if (value) expect(message).not.toContain(value);
  });
});
