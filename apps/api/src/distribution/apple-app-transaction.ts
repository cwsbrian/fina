import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";
import { HttpError } from "../auth/context.js";
import { APPLE_ROOT_CERTS } from "../iap/apple-roots.js";

export type VerifiedAppleAppTransaction = {
  environment: "Sandbox" | "Production";
  applicationVersion: string | null;
};

export type AppleAppTransactionVerifier = {
  verify(signedAppTransaction: string): Promise<VerifiedAppleAppTransaction>;
};

type AppleDistributionConfig = {
  bundleId?: string;
  appAppleId?: number;
};

function unverifiedReceiptType(jws: string): "Sandbox" | "Production" {
  const segments = jws.split(".");
  if (segments.length !== 3 || !segments[1]) {
    throw new HttpError(400, "invalid_receipt");
  }

  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as {
      receiptType?: unknown;
    };
    if (payload.receiptType === "Sandbox" || payload.receiptType === "Production") {
      return payload.receiptType;
    }
  } catch {
    // Fall through to the canonical public error below.
  }

  // Xcode and LocalTesting AppTransactions are not signed by Apple. Never use
  // those client-controlled payloads to classify production data.
  throw new HttpError(400, "invalid_receipt");
}

export function createAppleAppTransactionVerifier(
  config: AppleDistributionConfig,
): AppleAppTransactionVerifier {
  return {
    async verify(signedAppTransaction) {
      if (!config.bundleId) {
        throw new HttpError(503, "iap_not_configured", "APPLE_BUNDLE_ID is not set");
      }

      // The payload is inspected only to select the matching verifier. No
      // claim is trusted until SignedDataVerifier validates Apple's chain and
      // signature below.
      const receiptType = unverifiedReceiptType(signedAppTransaction);
      if (receiptType === "Production" && !config.appAppleId) {
        throw new HttpError(
          503,
          "iap_not_configured",
          "APPLE_APP_APPLE_ID is required for production AppTransaction verification",
        );
      }

      const environment =
        receiptType === "Production" ? Environment.PRODUCTION : Environment.SANDBOX;
      const verifier = new SignedDataVerifier(
        APPLE_ROOT_CERTS,
        false,
        environment,
        config.bundleId,
        receiptType === "Production" ? config.appAppleId : undefined,
      );

      const decoded = await verifier
        .verifyAndDecodeAppTransaction(signedAppTransaction)
        .catch(() => {
          throw new HttpError(400, "invalid_receipt");
        });

      return {
        environment: receiptType,
        applicationVersion:
          typeof decoded.applicationVersion === "string" && decoded.applicationVersion.length > 0
            ? decoded.applicationVersion
            : null,
      };
    },
  };
}
