// apps/api/src/iap/apple-client.ts
import { createHash, X509Certificate } from "node:crypto";
import {
  SignedDataVerifier,
  Environment,
  AppStoreServerAPIClient,
} from "@apple/app-store-server-library";
import { HttpError } from "../auth/context.js";
import type { AppleIapConfig } from "./env-guard.js";
import { mapAppleStatus } from "./status-mapping.js";
import type { MappedStatus } from "./status-mapping.js";
import { APPLE_ROOT_CERTS, EXPECTED_APPLE_ROOT_SPKI_SHA256 } from "./apple-roots.js";

/** Verify on module load that the pinned cert(s) parse + match the
 *  expected SPKI SHA-256 hash. This is the "pinned by SPKI hash in
 *  code" guarantee from spec §5.2 check #2 — a PEM-bytes mismatch
 *  (re-encoded same cert) still validates iff the SPKI matches.
 *  Throws at boot rather than at first webhook so misconfiguration
 *  surfaces during deploy, not during a real Apple notification. */
function validateAppleRoots(): void {
  if (APPLE_ROOT_CERTS.length === 0) {
    throw new Error(
      "APPLE_ROOT_CERTS is empty — install the Apple root cert(s) per spec §5.2 check #2. " +
        "See apps/api/src/iap/apple-roots.ts.",
    );
  }
  for (const pem of APPLE_ROOT_CERTS) {
    const pemStr = pem.toString("utf8");
    if (pemStr.includes("<<INSTALLER") || pemStr.includes(">>")) {
      throw new Error(
        "APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM. " +
          "See https://www.apple.com/certificateauthority/",
      );
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch (e) {
      throw new Error(
        `APPLE_ROOT_CERTS contains an unparseable certificate: ${(e as Error).message}`,
      );
    }
    const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const spkiHash = createHash("sha256").update(spki).digest("hex");
    if (!EXPECTED_APPLE_ROOT_SPKI_SHA256.includes(spkiHash)) {
      throw new Error(
        `APPLE_ROOT_CERTS SPKI SHA-256 ${spkiHash.slice(0, 16)}… is not in the expected pinned set. ` +
          `Refusing to start.`,
      );
    }
  }
}
validateAppleRoots();

export type VerifiedAppleTransaction = {
  bundleId: string;
  environment: "Sandbox" | "Production";
  signedDate: number;
  appAccountToken: string | null;
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  /** Raw decoded payload for callers that need fields not surfaced above. */
  raw: Record<string, unknown>;
};

export type VerifyContext = "checkout" | "restore" | "asc-api" | "assn";

function describeAppleApiError(e: unknown): string {
  const x = e as {
    name?: unknown;
    message?: unknown;
    httpStatusCode?: unknown;
    apiError?: unknown;
    errorMessage?: unknown;
  };
  const parts: string[] = [];
  if (typeof x.httpStatusCode === "number") parts.push(`status=${x.httpStatusCode}`);
  if (x.apiError !== undefined && x.apiError !== null) parts.push(`apiError=${String(x.apiError)}`);
  if (typeof x.errorMessage === "string" && x.errorMessage.length > 0) {
    parts.push(`errorMessage=${x.errorMessage}`);
  }
  if (parts.length > 0) return parts.join(" ");

  const name = typeof x.name === "string" && x.name.length > 0 ? x.name : "error";
  const message = typeof x.message === "string" && x.message.length > 0 ? `: ${x.message}` : "";
  return `${name}${message}`;
}

export class AppleClient {
  private verifier: SignedDataVerifier;
  private asc: AppStoreServerAPIClient;

  constructor(private cfg: AppleIapConfig) {
    const env = cfg.env === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
    // appAppleId: only meaningful in production (the SDK skips the check
    // in sandbox). Pass undefined → SDK accepts it for sandbox; pass the
    // configured value for production (requireIapEnv guarantees it's set).
    this.verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTS,
      /* enableOnlineChecks */ false,
      env,
      cfg.bundleId,
      cfg.appAppleId,
    );
    this.asc = new AppStoreServerAPIClient(
      cfg.ascPrivateKey,
      cfg.ascKeyId,
      cfg.ascIssuerId,
      cfg.bundleId,
      env,
    );
  }

  /** Internal — testable injection seam. Verifies the JWS cert chain
   *  via Apple's SDK and returns the decoded transaction payload. */
  protected async _decodeAndVerifyJws(jws: string): Promise<Record<string, unknown>> {
    const decoded = await this.verifier.verifyAndDecodeTransaction(jws);
    return decoded as unknown as Record<string, unknown>;
  }

  /** Verifies a SignedTransaction JWS through mandatory checks
   *  (alg, root chain, bundleId, environment, signedDate window).
   *  appAccountToken remains mandatory for app-initiated checkout and
   *  ASSN attribution, but restore/ASC status payloads can legitimately
   *  come from subscriptions created in Apple's native management surface
   *  where our appAccountToken was never attached. */
  async verifyAndDecodeTransaction(
    jws: string,
    opts: { context?: VerifyContext } = {},
  ): Promise<VerifiedAppleTransaction> {
    // Apple SDK enforces alg + root chain internally (checks 1, 2).
    const raw = await this._decodeAndVerifyJws(jws).catch((e) => {
      throw new HttpError(400, "invalid_receipt", `apple jws verify failed: ${e?.name ?? "error"}`);
    });

    const bundleId = String(raw.bundleId ?? "");
    if (bundleId !== this.cfg.bundleId) {
      throw new HttpError(400, "invalid_receipt", "bundleId mismatch");
    }

    const environment = String(raw.environment ?? "");
    const expectedEnv = this.cfg.env === "production" ? "Production" : "Sandbox";
    if (environment !== expectedEnv) {
      throw new HttpError(400, "invalid_receipt", "environment mismatch");
    }

    const signedDate = Number(raw.signedDate ?? 0);
    const ageMs = Date.now() - signedDate;
    // Client-sourced StoreKit transaction JWS values can be older than the
    // current button tap when Apple returns an already-owned subscription.
    // The current entitlement is fetched from ASC immediately after this
    // verification, so checkout/restore keep only the future skew guard.
    const maxAgeMs =
      opts.context === "checkout" || opts.context === "restore"
        ? null
        : opts.context === "assn"
          ? 60 * 60 * 1000
          : 10 * 60 * 1000;
    const maxFutureSkewMs = 30_000; // 30s clock skew tolerance for "future" payloads
    if (signedDate <= 0 || (maxAgeMs !== null && ageMs > maxAgeMs) || ageMs < -maxFutureSkewMs) {
      throw new HttpError(400, "expired_receipt", "signedDate outside acceptable window");
    }

    const appAccountToken =
      typeof raw.appAccountToken === "string" && raw.appAccountToken.length > 0
        ? raw.appAccountToken
        : null;
    if (!appAccountToken && opts.context !== "restore" && opts.context !== "asc-api") {
      throw new HttpError(403, "user_mismatch", "appAccountToken absent on verified transaction");
    }

    return {
      bundleId,
      environment: environment as "Sandbox" | "Production",
      signedDate,
      appAccountToken,
      productId: String(raw.productId ?? ""),
      originalTransactionId: String(raw.originalTransactionId ?? ""),
      transactionId: String(raw.transactionId ?? ""),
      raw,
    };
  }

  /** Decodes an ASSN V2 signedPayload (the webhook outer JWS). Uses
   *  the SDK's dedicated notification verifier — DO NOT route this
   *  through verifyAndDecodeTransaction (different payload shape;
   *  the transaction validator's bundleId/environment/appAccountToken
   *  checks have no counterpart in notification payloads). */
  async verifyAndDecodeNotification(signedPayload: string): Promise<{
    notificationUUID: string;
    notificationType: string;
    subtype?: string;
    signedTransactionJws: string;
    signedRenewalInfoJws?: string;
    raw: Record<string, unknown>;
  }> {
    const decoded = await this.verifier.verifyAndDecodeNotification(signedPayload).catch((e) => {
      throw new HttpError(
        400,
        "invalid_receipt",
        `apple notification verify failed: ${e?.name ?? "error"}`,
      );
    });
    const data = ((decoded as any).data ?? {}) as Record<string, unknown>;
    const subtype =
      typeof (decoded as any).subtype === "string" ? (decoded as any).subtype : undefined;
    const signedRenewalInfoJws =
      typeof data.signedRenewalInfo === "string" ? data.signedRenewalInfo : undefined;
    return {
      notificationUUID: String((decoded as any).notificationUUID ?? ""),
      notificationType: String((decoded as any).notificationType ?? ""),
      ...(subtype !== undefined ? { subtype } : {}),
      signedTransactionJws: String(data.signedTransactionInfo ?? ""),
      ...(signedRenewalInfoJws !== undefined ? { signedRenewalInfoJws } : {}),
      raw: decoded as Record<string, unknown>,
    };
  }

  /** Decodes signedRenewalInfo. Distinct SDK method from
   *  verifyAndDecodeTransaction — renewal-info payloads have their
   *  own claim set (autoRenewProductId, offerType, autoRenewStatus). */
  async verifyAndDecodeRenewalInfo(jws: string): Promise<Record<string, unknown>> {
    return (await this.verifier.verifyAndDecodeRenewalInfo(jws).catch((e) => {
      throw new HttpError(
        400,
        "invalid_receipt",
        `apple renewal verify failed: ${e?.name ?? "error"}`,
      );
    })) as unknown as Record<string, unknown>;
  }

  /** Fetches the latest subscription state from ASC API by
   *  originalTransactionId. Returns the verified renewal-info + a
   *  mapped status. */
  async getSubscriptionStatus(originalTransactionId: string): Promise<{
    expiresDate: Date;
    productId: string;
    pendingProductId: string | null;
    pendingAt: Date | null;
    mapped: MappedStatus;
  }> {
    const status = await this.asc.getAllSubscriptionStatuses(originalTransactionId).catch((e) => {
      throw new HttpError(502, "platform_unavailable", `asc api: ${describeAppleApiError(e)}`);
    });
    const items = (status.data ?? []).flatMap((group) => group.lastTransactions ?? []);
    if (items.length === 0) throw new HttpError(400, "invalid_receipt", "asc no transaction");

    // Decode each inner JWS through its DEDICATED Apple SDK verifier —
    // signedTransactionInfo through the transaction verifier (which
    // re-runs root/bundle/environment/signedDate checks), and
    // signedRenewalInfo through the renewal-info verifier (different
    // payload shape: autoRenewStatus, offerType, autoRenewProductId).
    const decoded = await Promise.all(
      items.map(async (item) => {
        const verifiedTx = await this.verifyAndDecodeTransaction(item.signedTransactionInfo!, {
          context: "asc-api",
        });
        const renewal = await this.verifyAndDecodeRenewalInfo(item.signedRenewalInfo!);
        const autoRenewStatus = (renewal.autoRenewStatus as 0 | 1) ?? 1;
        const autoRenewProductId =
          typeof renewal.autoRenewProductId === "string" && renewal.autoRenewProductId.length > 0
            ? renewal.autoRenewProductId
            : null;
        const expiresDate = new Date(Number(verifiedTx.raw.expiresDate ?? 0));
        const purchaseDate = new Date(
          Number(verifiedTx.raw.purchaseDate ?? verifiedTx.signedDate ?? 0),
        );
        const pendingProductId =
          autoRenewStatus === 1 && autoRenewProductId && autoRenewProductId !== verifiedTx.productId
            ? autoRenewProductId
            : null;
        const mapped = mapAppleStatus({
          subscriptionStatus: appleStatusFromCode(item.status as number),
          offerType: (renewal.offerType as number | null) ?? null,
          autoRenewStatus,
        });
        return { verifiedTx, renewal, expiresDate, purchaseDate, pendingProductId, mapped };
      }),
    );
    const activeDecoded = decoded.filter((item) => item.mapped.status === "active");
    const candidates = activeDecoded.length > 0 ? activeDecoded : decoded;
    const selected = candidates.sort((a, b) => {
      const purchaseDiff = b.purchaseDate.getTime() - a.purchaseDate.getTime();
      if (purchaseDiff !== 0) return purchaseDiff;
      return b.expiresDate.getTime() - a.expiresDate.getTime();
    })[0]!;
    return {
      expiresDate: selected.expiresDate,
      productId: selected.verifiedTx.productId,
      pendingProductId: selected.pendingProductId,
      pendingAt: selected.pendingProductId ? selected.expiresDate : null,
      mapped: selected.mapped,
    };
  }
}

function appleStatusFromCode(
  code: number,
): "SUBSCRIBED" | "BILLING_RETRY" | "EXPIRED" | "REVOKED" | "PAUSED" {
  // Apple's status enum: 1=active, 2=expired, 3=billing retry,
  //                      4=grace, 5=revoked. (Family Sharing handled
  //                      in the webhook subtype path, not here.)
  switch (code) {
    case 1:
      return "SUBSCRIBED";
    case 2:
      return "EXPIRED";
    case 3:
      return "BILLING_RETRY";
    case 4:
      return "BILLING_RETRY"; // grace is part of past_due window
    case 5:
      return "REVOKED";
    case 6:
      return "PAUSED";
    default:
      return "EXPIRED";
  }
}
