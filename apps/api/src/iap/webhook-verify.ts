import { OAuth2Client } from "google-auth-library";
import { HttpError } from "../auth/context.js";
import type { AppleClient } from "./apple-client.js";
import type { AppleIapConfig, GoogleIapConfig } from "./env-guard.js";

export type AppleNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  signedTransactionJws: string;
  raw: Record<string, unknown>;
};

/** Thin wrapper that delegates to AppleClient.verifyAndDecodeNotification.
 *  Kept as a free function so the webhook route's tests can pass a
 *  mocked AppleClient without import cycles. The actual signature +
 *  shape verification lives in apple-client.ts. */
export async function verifyApplePayload(
  signedPayload: string,
  _cfg: AppleIapConfig,
  deps: { appleClient: Pick<AppleClient, "verifyAndDecodeNotification"> },
): Promise<AppleNotification> {
  const n = await deps.appleClient.verifyAndDecodeNotification(signedPayload);
  return {
    notificationUUID: n.notificationUUID,
    notificationType: n.notificationType,
    ...(n.subtype !== undefined ? { subtype: n.subtype } : {}),
    signedTransactionJws: n.signedTransactionJws,
    raw: n.raw,
  };
}

export type GoogleNotification =
  | {
      kind: "subscription";
      messageId: string;
      payload: { purchaseToken: string; subscriptionId: string; notificationType: number };
    }
  | { kind: "ignore"; messageId: string; reason: string };

/** Google Pub/Sub OIDC + envelope verifier. */
export async function verifyGoogleEnvelope(
  authorizationHeader: string | undefined,
  body: { message?: { data?: string; messageId?: string }; subscription?: string },
  cfg: GoogleIapConfig,
  deps: { oidcClient: Pick<OAuth2Client, "verifyIdToken"> },
): Promise<GoogleNotification> {
  // 1. OIDC bearer
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new HttpError(400, "invalid_receipt", "missing bearer");
  }
  const token = authorizationHeader.slice("Bearer ".length);

  const ticket = await deps.oidcClient.verifyIdToken({
    idToken: token,
    audience: cfg.pubsubVerifyAudience,
  } as any).catch(() => {
    throw new HttpError(400, "invalid_receipt", "oidc verify failed");
  });
  const payload = (ticket as any).getPayload?.() ?? {};
  if (payload.iss !== "https://accounts.google.com") {
    throw new HttpError(400, "invalid_receipt", "oidc issuer mismatch");
  }
  if (payload.aud !== cfg.pubsubVerifyAudience) {
    throw new HttpError(400, "invalid_receipt", "oidc audience mismatch");
  }
  if (payload.email !== cfg.pubsubVerifyEmail || payload.email_verified !== true) {
    throw new HttpError(400, "invalid_receipt", "oidc email mismatch");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec) {
    throw new HttpError(400, "invalid_receipt", "oidc expired");
  }

  // 2. Pub/Sub subscription pinning
  if (body.subscription !== cfg.pubsubSubscriptionName) {
    throw new HttpError(400, "invalid_receipt", "pubsub subscription mismatch");
  }

  // 3. Decode inner envelope
  const messageId = String(body.message?.messageId ?? "");
  const dataB64 = body.message?.data;
  if (!dataB64) throw new HttpError(400, "invalid_receipt", "pubsub missing data");
  const inner = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));

  if (inner.subscriptionNotification) {
    return {
      kind: "subscription",
      messageId,
      payload: {
        purchaseToken: String(inner.subscriptionNotification.purchaseToken ?? ""),
        subscriptionId: String(inner.subscriptionNotification.subscriptionId ?? ""),
        notificationType: Number(inner.subscriptionNotification.notificationType ?? 0),
      },
    };
  }

  // testNotification, oneTimeProductNotification, etc. — ignored.
  return { kind: "ignore", messageId, reason: Object.keys(inner)[0] ?? "unknown" };
}
