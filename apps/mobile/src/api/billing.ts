import type { IAPCheckoutBody, IAPRestoreBody, MeDTO } from "@fina/shared";
import { apiFetch } from "./client";

function requireSyncedSubscription(result: MeDTO, source: "checkout" | "restore"): MeDTO {
  if (result.subscription) return result;
  throw new Error(
    source === "restore"
      ? "Purchase was found, but the server did not sync an active subscription."
      : "Purchase completed, but the server did not return an active subscription.",
  );
}

export async function postIAPCheckout(body: IAPCheckoutBody): Promise<MeDTO> {
  try {
    const result = await apiFetch<MeDTO>("/billing/iap/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const synced = requireSyncedSubscription(result, "checkout");
    console.info("[iap.checkout] ok", {
      platform: body.platform,
      productId: body.productId,
      receiptLength: body.receipt.length,
      tier: synced.tier,
      subscriptionTier: synced.subscription?.tier ?? null,
      subscriptionSource: synced.subscription?.source ?? null,
    });
    return synced;
  } catch (e) {
    console.warn("[iap.checkout] failed", {
      platform: body.platform,
      productId: body.productId,
      receiptLength: body.receipt.length,
      error: e,
    });
    throw e;
  }
}

export async function postIAPRestore(body: IAPRestoreBody): Promise<MeDTO> {
  try {
    const result = await apiFetch<MeDTO>("/billing/iap/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const synced = requireSyncedSubscription(result, "restore");
    console.info("[iap.restore] ok", {
      platform: body.platform,
      purchases: body.purchases.map((p) => ({
        productId: p.productId,
        receiptLength: p.receipt.length,
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
        receiptLength: p.receipt.length,
      })),
      error: e,
    });
    throw e;
  }
}
