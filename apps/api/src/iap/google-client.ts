import { google } from "googleapis";
import { HttpError } from "../auth/context.js";
import type { GoogleReceiptIapConfig } from "./env-guard.js";
import { mapGoogleStatus } from "./status-mapping.js";
import type { MappedStatus, GoogleStatusInput } from "./status-mapping.js";

export type NormalizedGooglePurchase = {
  obfuscatedExternalAccountId: string;
  acknowledgementState: string;
  subscriptionState: GoogleStatusInput["subscriptionState"];
  productId: string;
  expiryTime: Date;
  pendingProductId: string | null;
  pendingAt: Date | null;
  linkedPurchaseToken: string | null;
  environment: "Production" | "Sandbox";
  mapped: MappedStatus;
  raw: Record<string, unknown>;
};

export class GoogleClient {
  private androidPublisher;

  constructor(private cfg: GoogleReceiptIapConfig) {
    const auth = new google.auth.GoogleAuth({
      credentials: cfg.serviceAccount as any,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    this.androidPublisher = google.androidpublisher({ version: "v3", auth });
  }

  /** Testable seam — raw v2 fetch. */
  protected async _getV2(purchaseToken: string): Promise<Record<string, unknown>> {
    const res = await this.androidPublisher.purchases.subscriptionsv2
      .get({
        packageName: this.cfg.packageName,
        token: purchaseToken,
      })
      .catch((e: any) => {
        const status = Number(e?.code ?? e?.response?.status ?? 0);
        if (status === 404 || status === 410) throw new HttpError(400, "invalid_receipt", "google purchase not found");
        throw new HttpError(502, "platform_unavailable", `google api: ${e?.message ?? "error"}`);
      });
    return res.data as Record<string, unknown>;
  }

  /** Testable seam — invoke the acknowledge call. Must pass the
   *  product's subscriptionId (NOT an empty string) per the v1
   *  endpoint contract; v2 has no acknowledge method as of
   *  `googleapis@^140`. We always have the productId at the call
   *  site because the prior fetchAndNormalize surfaces it. */
  protected async _acknowledge(purchaseToken: string, productId: string): Promise<void> {
    await this.androidPublisher.purchases.subscriptions
      .acknowledge({
        packageName: this.cfg.packageName,
        subscriptionId: productId,
        token: purchaseToken,
        requestBody: {},
      })
      .catch((e: any) => {
        throw new HttpError(502, "platform_unavailable", `google ack: ${e?.message ?? "error"}`);
      });
  }

  /** Fetch the v2 purchase, normalize into our shape, derive
   *  environment from `testPurchase` presence, derive mapped status. */
  async fetchAndNormalize(purchaseToken: string): Promise<NormalizedGooglePurchase> {
    const raw = await this._getV2(purchaseToken);
    const obf = (raw.externalAccountIdentifiers as any)?.obfuscatedExternalAccountId;
    if (!obf || typeof obf !== "string") {
      throw new HttpError(403, "user_mismatch", "obfuscatedExternalAccountId absent");
    }
    const lineItem = ((raw.lineItems as any[]) ?? [])[0] ?? {};
    const productId = String(lineItem.productId ?? "");
    const expiryTime = new Date(lineItem.expiryTime ?? Date.now());
    const deferredProductId = lineItem.deferredItemReplacement?.productId;
    const pendingProductId =
      typeof deferredProductId === "string" && deferredProductId.length > 0
        ? deferredProductId
        : null;
    const subscriptionState = String(raw.subscriptionState ?? "") as GoogleStatusInput["subscriptionState"];
    const linkedPurchaseToken = (raw.linkedPurchaseToken as string | null) ?? null;
    const environment: "Production" | "Sandbox" = raw.testPurchase ? "Sandbox" : "Production";
    const introOffer = Boolean(lineItem.offerDetails?.offerId);
    const mapped = mapGoogleStatus({ subscriptionState, expiryTime, introOffer });
    return {
      obfuscatedExternalAccountId: obf,
      acknowledgementState: String(raw.acknowledgementState ?? ""),
      subscriptionState,
      productId,
      expiryTime,
      pendingProductId,
      pendingAt: pendingProductId ? expiryTime : null,
      linkedPurchaseToken,
      environment,
      mapped,
      raw,
    };
  }

  /** Idempotent acknowledge — caller passes the already-fetched
   *  state to avoid a second fetchAndNormalize round-trip (TOCTOU
   *  window + ~150ms latency). Calls API only when PENDING. Spec
   *  §7 requires this after every successful upsert so Google
   *  doesn't auto-refund within 3 days. */
  async acknowledgeIfPending(args: {
    purchaseToken: string;
    productId: string;
    acknowledgementState: string;
  }): Promise<boolean> {
    if (args.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") return false;
    await this._acknowledge(args.purchaseToken, args.productId);
    return true;
  }
}
