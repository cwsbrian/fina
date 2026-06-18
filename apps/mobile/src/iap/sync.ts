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
import {
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

function isAlreadyOwnedError(e: unknown): boolean {
  return e instanceof IapPurchaseError && e.code === "E_ALREADY_OWNED";
}

function nativeSubscriptionSource(): SubscriptionSource | null {
  if (Platform.OS === "ios") return "iap_apple";
  if (Platform.OS === "android") return "iap_google";
  return null;
}

function shouldCheckNativeIntegrity(me: MeDTO): boolean {
  const nativeSource = nativeSubscriptionSource();
  if (!nativeSource || !me.iapIntegrity.requiresCheck) return false;
  if (!me.subscription || me.subscription.source !== nativeSource) return false;
  if (isBillingLocked(me)) return false;
  return true;
}

export async function restoreCurrentNativeSubscriptions(): Promise<MeDTO | null> {
  const purchases = await listAvailablePurchases();
  if (purchases.length === 0) return null;

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

export async function syncCurrentNativeSubscriptions(): Promise<MeDTO | null> {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  return await restoreCurrentNativeSubscriptions();
}

async function checkNativeIapIntegrity(me: MeDTO): Promise<MeDTO | null> {
  if (!isIapAvailable()) return null;
  if (!me.subscription) return null;
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : null;
  if (!platform) return null;

  const entitlements = await listCurrentNativeEntitlements();
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
  let purchase: Awaited<ReturnType<typeof requestSubscriptionPurchase>>;
  try {
    purchase = await requestSubscriptionPurchase(tier, userId);
  } catch (e) {
    if (isAlreadyOwnedError(e)) {
      const synced = await restoreCurrentNativeSubscriptions();
      if (synced) return synced;
      const current = await apiFetch<MeDTO>("/me");
      if (current.subscription) return current;
    }
    throw e;
  }

  const nextMe = await postIAPCheckout({
    platform: purchase.platform,
    productId: purchase.productId,
    receipt: purchase.receipt,
  });

  if (purchase.purchase) {
    await finishPurchase(purchase.purchase);
  }

  return nextMe;
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
