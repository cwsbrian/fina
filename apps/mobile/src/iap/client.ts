// Type-only imports from react-native-iap are elided at runtime, so they
// don't pull in the Nitro native module. All runtime imports go through
// `getIap()` below — lazy-required inside try/catch so Expo Go (which has
// no NitroModules support) can still load this file. Functions degrade to
// empty-state / typed errors when the module is unavailable.
import type { Purchase, ProductSubscription } from "react-native-iap";
import { Platform } from "react-native";
import { isExpoGo } from "../env";
import { deriveAppleToken, deriveGoogleToken } from "./binding";
import type { IAPProductId } from "@fina/shared";

const SKUS: IAPProductId[] = ["lite_monthly", "pro_monthly"];

export type LocalProduct = {
  productId: IAPProductId;
  tier: "lite" | "pro";
  localizedPrice: string;
  localizedTitle: string;
};

/** Error class surfaced to callers so the UI can map react-native-iap's
 *  string codes to user-friendly messaging. The code is the canonical
 *  rn-iap error code; `recoverable` is true for user-cancel and
 *  already-owned (Restore handles the latter). `E_RN_IAP_UNAVAILABLE` is
 *  our own code, emitted only when running under Expo Go (no dev client). */
export class IapPurchaseError extends Error {
  constructor(public code: string, public recoverable: boolean, message: string) {
    super(message);
    this.name = "IapPurchaseError";
  }
}

type RnIap = typeof import("react-native-iap");

let _iap: RnIap | null | undefined; // undefined = not yet probed

/** Lazy-require react-native-iap. Returns null under Expo Go where the
 *  Nitro native module isn't linked. Cached after first probe — both
 *  success and the null sentinel persist for the session. */
function getIap(): RnIap | null {
  if (_iap !== undefined) return _iap;
  // Expo Go ships no NitroModules. react-native-iap v14's module-level Nitro
  // init throws an *uncaught* error that escapes the try/catch below (it isn't
  // a clean synchronous require failure), so skip the require in Expo Go.
  if (isExpoGo) {
    _iap = null;
    return _iap;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _iap = require("react-native-iap") as RnIap;
  } catch {
    _iap = null;
  }
  return _iap;
}

export function isIapAvailable(): boolean {
  return getIap() !== null;
}

let connected = false;

async function ensureConnected(): Promise<RnIap> {
  const iap = getIap();
  if (!iap) {
    throw new IapPurchaseError(
      "E_RN_IAP_UNAVAILABLE",
      false,
      "In-app purchases require a dev client build (Expo Go cannot load native modules).",
    );
  }
  if (!connected) {
    await iap.initConnection();
    connected = true;
  }
  return iap;
}

export async function fetchProducts(): Promise<LocalProduct[]> {
  const iap = getIap();
  // Under Expo Go: return empty array so the plan picker shows the
  // empty-state ("Subscriptions aren't available right now") instead of
  // crashing the whole app on module load.
  if (!iap) return [];
  await ensureConnected();
  const raw = await iap.fetchProducts({ skus: SKUS, type: "subs" });
  if (!raw) return [];
  return (raw as ProductSubscription[])
    .filter((s): s is ProductSubscription => Boolean((s as any).id))
    .map((s) => {
      const id = String((s as any).id);
      const productId = (id === "pro_monthly" ? "pro_monthly" : "lite_monthly") as IAPProductId;
      const tier: "lite" | "pro" = productId === "pro_monthly" ? "pro" : "lite";
      const localizedPrice = String((s as any).displayPrice ?? (s as any).localizedPrice ?? (s as any).price ?? "");
      const localizedTitle = String((s as any).displayName ?? (s as any).title ?? productId);
      return { productId, tier, localizedPrice, localizedTitle };
    });
}

export async function purchaseSubscription(args: {
  productId: IAPProductId;
  userId: string;
}): Promise<{ receipt: string; platform: "ios" | "android"; purchase: Purchase }> {
  const iap = await ensureConnected();
  try {
    if (Platform.OS === "ios") {
      const appAccountToken = deriveAppleToken(args.userId);
      const result = await iap.requestPurchase({
        request: { apple: { sku: args.productId, appAccountToken } },
        type: "subs",
      });
      if (!result) throw new IapPurchaseError("E_NO_RECEIPT", false, "requestPurchase returned null");
      const single: Purchase = Array.isArray(result) ? result[0] : result;
      if (!single) throw new IapPurchaseError("E_NO_RECEIPT", false, "requestPurchase returned empty array");
      const jws = (single as any).jwsRepresentationIOS ?? (single as any).transactionReceipt;
      if (!jws) throw new IapPurchaseError("E_NO_RECEIPT", false, "No JWS receipt returned by StoreKit 2");
      return { receipt: String(jws), platform: "ios", purchase: single };
    }
    // Android
    const obfuscatedAccountId = deriveGoogleToken(args.userId);
    const result = await iap.requestPurchase({
      request: { google: { skus: [args.productId], obfuscatedAccountId } },
      type: "subs",
    });
    if (!result) throw new IapPurchaseError("E_NO_RECEIPT", false, "requestPurchase returned null");
    const single: Purchase = Array.isArray(result) ? result[0] : result;
    if (!single) throw new IapPurchaseError("E_NO_RECEIPT", false, "requestPurchase returned empty array");
    const purchaseToken = (single as any).purchaseToken ?? (single as any).purchaseTokenAndroid;
    if (!purchaseToken) throw new IapPurchaseError("E_NO_RECEIPT", false, "No purchaseToken returned by Play Billing");
    return { receipt: String(purchaseToken), platform: "android", purchase: single };
  } catch (e: any) {
    const code: string = e?.code ?? "";
    if (code === "E_USER_CANCELLED") throw new IapPurchaseError(code, true, "User cancelled");
    if (code === "E_ALREADY_OWNED") throw new IapPurchaseError(code, true, "Already owned — try Restore");
    if (code === "E_NETWORK_ERROR") throw new IapPurchaseError(code, true, "Network error");
    if (code === "E_ITEM_UNAVAILABLE") throw new IapPurchaseError(code, false, "Product unavailable");
    if (code === "E_SERVICE_ERROR") throw new IapPurchaseError(code, true, "Service unavailable");
    if (e instanceof IapPurchaseError) throw e;
    throw new IapPurchaseError("E_UNKNOWN", false, e?.message ?? "Purchase failed");
  }
}

/** Call ONLY after server returns 2xx — protects against
 *  client-finishing-before-server-records race. No-op under Expo Go. */
export async function finishPurchase(p: Purchase): Promise<void> {
  const iap = getIap();
  if (!iap) return;
  await iap.finishTransaction({ purchase: p as any, isConsumable: false });
}

export async function listAvailablePurchases(): Promise<
  Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android"; purchase: Purchase }>
> {
  const iap = getIap();
  if (!iap) return [];
  await ensureConnected();
  const all: Purchase[] = await iap.getAvailablePurchases();
  const out: Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android"; purchase: Purchase }> = [];
  const seen = new Set<string>();
  for (const p of all) {
    const id = (p as any).id ?? (p as any).productId;
    if (id !== "lite_monthly" && id !== "pro_monthly") continue;
    const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
    const receipt = String(
      platform === "ios"
        ? (p as any).jwsRepresentationIOS ?? (p as any).transactionReceipt
        : (p as any).purchaseToken ?? (p as any).purchaseTokenAndroid,
    );
    const dedupKey = platform === "ios"
      ? (p as any).originalTransactionIdentifierIOS ?? (p as any).transactionIdIOS ?? receipt
      : receipt;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ productId: id as IAPProductId, receipt, platform, purchase: p });
  }
  return out;
}

export async function disconnect(): Promise<void> {
  if (!connected) return;
  const iap = getIap();
  if (!iap) {
    connected = false;
    return;
  }
  await iap.endConnection();
  connected = false;
}
