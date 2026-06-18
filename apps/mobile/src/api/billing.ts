import type {
  IAPCheckoutBody,
  IAPIntegrityCheckBody,
  IAPRestoreBody,
  MeDTO,
  SyncBody,
} from "@fina/shared";
import { apiFetch } from "./client";

function requireSyncedSubscription(result: MeDTO): MeDTO {
  if (result.subscription) return result;
  throw new Error("Purchase was found, but the server did not sync an active subscription.");
}

export function isUnsyncedIAPPurchaseError(e: unknown): boolean {
  return (
    e instanceof Error &&
    e.message === "Purchase was found, but the server did not sync an active subscription."
  );
}

function receiptMeta(receipt: string): {
  receiptLength: number;
  dotCount: number;
  looksLikeJws: boolean;
} {
  const dotCount = receipt.split(".").length - 1;
  return {
    receiptLength: receipt.length,
    dotCount,
    looksLikeJws: dotCount === 2,
  };
}

export async function postIAPRestore(body: IAPRestoreBody): Promise<MeDTO> {
  try {
    const result = await apiFetch<MeDTO>("/billing/iap/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const synced = requireSyncedSubscription(result);
    console.info("[iap.restore] ok", {
      platform: body.platform,
      purchases: body.purchases.map((p) => ({
        productId: p.productId,
        ...receiptMeta(p.receipt),
      })),
      tier: synced.tier,
      subscriptionTier: synced.subscription?.tier ?? null,
      subscriptionSource: synced.subscription?.source ?? null,
    });
    return synced;
  } catch (e) {
    console.warn("[iap.restore] failed", {
      platform: body.platform,
      purchases: body.purchases.map((p) => ({
        productId: p.productId,
        ...receiptMeta(p.receipt),
      })),
      error: e,
    });
    throw e;
  }
}

export async function postIAPCheckout(body: IAPCheckoutBody): Promise<MeDTO> {
  try {
    const result = await apiFetch<MeDTO>("/billing/iap/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const synced = requireSyncedSubscription(result);
    console.info("[iap.checkout] ok", {
      platform: body.platform,
      productId: body.productId,
      ...receiptMeta(body.receipt),
      tier: synced.tier,
      subscriptionTier: synced.subscription?.tier ?? null,
      subscriptionSource: synced.subscription?.source ?? null,
    });
    return synced;
  } catch (e) {
    console.warn("[iap.checkout] failed", {
      platform: body.platform,
      productId: body.productId,
      ...receiptMeta(body.receipt),
      error: e,
    });
    throw e;
  }
}

export async function postIAPIntegrityCheck(body: IAPIntegrityCheckBody): Promise<MeDTO> {
  return await apiFetch<MeDTO>("/billing/iap/integrity-check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postBillingSync(body: SyncBody = {}): Promise<MeDTO> {
  return await apiFetch<MeDTO>("/billing/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
