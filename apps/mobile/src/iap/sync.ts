import {
  tierForIapProductId,
  type MeDTO,
  type PaidTier,
  type SubscriptionSource,
} from "@fina/shared";
import { Platform } from "react-native";
import { postIAPCheckout, postIAPIntegrityCheck, postIAPRestore } from "../api/billing";
import { apiFetch } from "../api/client";
import { isBillingLocked } from "../billing/recovery-ui";
import { listNativeSubscriptionStoreEntitlements } from "./native-subscription-store";
import {
  clearPendingNativeTransactions,
  finishPurchase,
  IapPurchaseError,
  isIapAvailable,
  listAvailablePurchases,
  listCurrentNativeEntitlements,
  requestSubscriptionPurchase,
  showNativeSubscriptionManagement,
} from "./client";

let nativeIntegrityInFlight: Promise<MeDTO | null> | null = null;
let lastNativeIntegrityAttemptAt = 0;
const NATIVE_INTEGRITY_RETRY_COOLDOWN_MS = 30_000;
const NATIVE_CHECKOUT_STALE_PURCHASE_RETRY_LIMIT = 20;
const NATIVE_CHECKOUT_DUPLICATE_RETRY_LIMIT = 2;

function isAlreadyOwnedError(e: unknown): boolean {
  return e instanceof IapPurchaseError && e.code === "E_ALREADY_OWNED";
}

function isExpiredReceiptError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: unknown }).code === "expired_receipt"
  );
}

function nativeSubscriptionSource(): SubscriptionSource | null {
  if (Platform.OS === "ios") return "iap_apple";
  if (Platform.OS === "android") return "iap_google";
  return null;
}

function shouldCheckNativeIntegrity(me: MeDTO): boolean {
  const nativeSource = nativeSubscriptionSource();
  if (!nativeSource) return false;
  if (isBillingLocked(me)) return false;
  if (!me.subscription) return true;
  return me.subscription.source === nativeSource && me.iapIntegrity.requiresCheck;
}

export async function restoreCurrentNativeSubscriptions(): Promise<MeDTO | null> {
  if (Platform.OS === "ios") {
    const entitlements = await listNativeSubscriptionStoreEntitlements();
    if (entitlements.length > 0) {
      return await syncNativePurchaseProofs(entitlements);
    }
  }

  const purchases = await listAvailablePurchases();
  if (purchases.length === 0) return null;

  const nextMe = await syncNativePurchaseProofs(purchases);

  await Promise.allSettled(
    purchases.filter((p) => p.purchase).map((p) => finishPurchase(p.purchase!)),
  );

  return nextMe;
}

export async function syncCurrentNativeSubscriptions(): Promise<MeDTO | null> {
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
  if (!platform) return null;

  let entitlements =
    platform === "ios"
      ? await listNativeSubscriptionStoreEntitlements()
      : await listCurrentNativeEntitlements();
  if (entitlements.length === 0) return null;
  return await syncNativePurchaseProofs(entitlements);
}

async function syncNativePurchaseProofs(
  purchases: Awaited<ReturnType<typeof listAvailablePurchases>>,
): Promise<MeDTO> {
  return await postIAPRestore({
    platform: purchases[0]!.platform,
    purchases: purchases.map((p) => ({
      productId: p.productId,
      receipt: p.receipt,
    })),
  });
}

async function checkNativeIapIntegrity(me: MeDTO): Promise<MeDTO | null> {
  if (!isIapAvailable()) return null;
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
  if (!platform) return null;

  let entitlements =
    platform === "ios"
      ? await listNativeSubscriptionStoreEntitlements()
      : await listCurrentNativeEntitlements();
  if (entitlements.length === 0) return null;

  if (!me.subscription) {
    try {
      return await syncNativePurchaseProofs(entitlements);
    } catch (e) {
      console.warn("[iap.integrity] native entitlement restore failed", e);
    }
  }

  const matching = entitlements.find(
    (item) => tierForIapProductId(item.productId) === me.subscription?.tier,
  );
  const nativeProductId = matching?.productId ?? entitlements[0]?.productId ?? null;

  return await postIAPIntegrityCheck({
    platform,
    result: matching ? "matched" : "mismatched",
    nativeProductId,
    receipt: matching?.receipt ?? entitlements[0]?.receipt ?? null,
  });
}

export async function fetchMeWithNativeSubscriptionSync(): Promise<MeDTO> {
  const me = await apiFetch<MeDTO>("/me");
  if (!shouldCheckNativeIntegrity(me)) return me;

  const now = Date.now();
  if (
    !nativeIntegrityInFlight &&
    now - lastNativeIntegrityAttemptAt < NATIVE_INTEGRITY_RETRY_COOLDOWN_MS
  ) {
    return me;
  }

  if (!nativeIntegrityInFlight) {
    lastNativeIntegrityAttemptAt = now;
    nativeIntegrityInFlight = checkNativeIapIntegrity(me).finally(() => {
      nativeIntegrityInFlight = null;
    });
  }

  try {
    return (await nativeIntegrityInFlight) ?? me;
  } catch (e) {
    console.warn("[iap.integrity] failed", e);
    return me;
  }
}

export async function checkoutNativeSubscription(
  tier: PaidTier,
  userId: string,
): Promise<MeDTO> {
  let lastExpiredReceiptError: unknown = null;
  let duplicateRetries = 0;
  for (let attempt = 0; attempt < NATIVE_CHECKOUT_STALE_PURCHASE_RETRY_LIMIT; attempt += 1) {
    let purchase: Awaited<ReturnType<typeof requestSubscriptionPurchase>>;
    try {
      purchase = await requestSubscriptionPurchase(tier, userId);
    } catch (e) {
      if (isAlreadyOwnedError(e)) {
        if (Platform.OS === "ios" && duplicateRetries < NATIVE_CHECKOUT_DUPLICATE_RETRY_LIMIT) {
          duplicateRetries += 1;
          await Promise.resolve(clearPendingNativeTransactions()).catch((clearError) => {
            console.warn("[iap.checkout] failed to clear pending iOS transactions", clearError);
          });
          console.info("[iap.checkout] cleared pending iOS transactions after duplicate", {
            attempt: duplicateRetries,
            tier,
          });
          continue;
        }
        const synced = await restoreCurrentNativeSubscriptions();
        if (synced) return synced;
        const current = await apiFetch<MeDTO>("/me");
        if (current.subscription) return current;
      }
      throw e;
    }

    try {
      const nextMe = await postIAPCheckout({
        platform: purchase.platform,
        productId: purchase.productId,
        receipt: purchase.receipt,
      });

      if (purchase.purchase) {
        await finishPurchase(purchase.purchase);
      }

      return nextMe;
    } catch (e) {
      if (purchase.purchase && isExpiredReceiptError(e)) {
        lastExpiredReceiptError = e;
        await Promise.resolve(finishPurchase(purchase.purchase)).catch((finishError) => {
          console.warn("[iap.checkout] failed to finish expired purchase", finishError);
        });
        console.info("[iap.checkout] finished stale expired purchase", {
          attempt: attempt + 1,
          productId: purchase.productId,
        });
        continue;
      }
      throw e;
    }
  }
  throw lastExpiredReceiptError ?? new Error("No active App Store purchase was returned.");
}

export async function syncNativeSubscriptionManagement(): Promise<MeDTO> {
  try {
    await showNativeSubscriptionManagement();
  } catch (e) {
    if (e instanceof IapPurchaseError && e.code === "E_USER_CANCELLED") {
      return await apiFetch<MeDTO>("/me");
    }
    throw e;
  }
  return await apiFetch<MeDTO>("/me");
}
