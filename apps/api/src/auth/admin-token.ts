import { decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from "jose";
import { HttpError } from "./context.js";

export type AdminActor = { sub: string; email: string; jti: string };
export type AdminTokenVerifier = (authorization: string | undefined) => Promise<AdminActor>;

export function createAdminTokenVerifier(input: {
  issuer: string;
  audience: "fina-admin-api";
  adminEmail: string;
  publicKeys: Record<string, string>;
  now?: () => number;
}): AdminTokenVerifier {
  const keys = new Map<string, ReturnType<typeof importSPKI>>();
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));

  return async (authorization) => {
    const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
    if (!token) throw new HttpError(401, "unauthenticated");

    let payload: JWTPayload;
    try {
      const header = decodeProtectedHeader(token);
      if (header.alg !== "EdDSA" || typeof header.kid !== "string" || header.kid.length === 0) {
        throw new Error("invalid protected header");
      }
      const encodedKey = input.publicKeys[header.kid];
      if (!encodedKey) throw new Error("unknown key");
      let key = keys.get(header.kid);
      if (!key) {
        key = importSPKI(Buffer.from(encodedKey, "base64").toString("utf8"), "EdDSA");
        keys.set(header.kid, key);
      }
      ({ payload } = await jwtVerify(token, await key, {
        issuer: input.issuer,
        audience: input.audience,
        algorithms: ["EdDSA"],
        clockTolerance: 5,
        currentDate: new Date(now() * 1000),
        requiredClaims: ["email", "scope", "sub", "jti", "iat", "nbf", "exp"],
      }));
    } catch {
      throw new HttpError(401, "unauthenticated");
    }

    if (payload.aud !== input.audience) {
      throw new HttpError(401, "unauthenticated");
    }
    if (payload.email !== input.adminEmail || payload.scope !== "admin:read") {
      throw new HttpError(403, "admin_required");
    }
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.jti !== "string" ||
      payload.jti.length === 0 ||
      typeof payload.iat !== "number" ||
      typeof payload.nbf !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp - payload.iat > 60 ||
      payload.exp <= payload.iat ||
      payload.nbf !== payload.iat
    ) {
      throw new HttpError(401, "unauthenticated");
    }

    return { sub: payload.sub, email: payload.email, jti: payload.jti };
  };
}
