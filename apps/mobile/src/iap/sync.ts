import type { MeDTO } from "@fina/shared";
import { postIAPRestore } from "../api/billing";
import { apiFetch } from "../api/client";
import { finishPurchase, IapPurchaseError, showNativeSubscriptionManagement } from "./client";

export async function syncNativeSubscriptionManagement(): Promise<MeDTO> {
  let purchases: Awaited<ReturnType<typeof showNativeSubscriptionManagement>>;
  try {
    purchases = await showNativeSubscriptionManagement();
  } catch (e) {
    if (e instanceof IapPurchaseError && e.code === "E_USER_CANCELLED") {
      return await apiFetch<MeDTO>("/me");
    }
    throw e;
  }
  if (purchases.length === 0) {
    return await apiFetch<MeDTO>("/me");
  }

  const nextMe = await postIAPRestore({
    platform: purchases[0]!.platform,
    purchases: purchases.map((p) => ({
      productId: p.productId,
      receipt: p.receipt,
    })),
  });

  await Promise.allSettled(
    purchases.filter((p) => p.purchase).map((p) => finishPurchase(p.purchase!)),
  );

  return nextMe;
}
