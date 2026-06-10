// Type-only imports from react-native-iap are elided at runtime, so they
// don't pull in the Nitro native module. All runtime imports go through
// `getIap()` below — lazy-required inside try/catch so Expo Go (which has
// no NitroModules support) can still load this file. Functions degrade to
// empty-state / typed errors when the module is unavailable.
import type { Purchase } from "react-native-iap";
import { Platform } from "react-native";
import { isExpoGo } from "../env";
import type { IAPProductId } from "@fina/shared";

const SKUS: IAPProductId[] =
  Platform.OS === "ios" ? ["fina_pro_monthly", "max_monthly"] : ["pro_monthly", "max_monthly"];

/** Error class surfaced to callers so the UI can map react-native-iap's
 *  string codes to user-friendly messaging. The code is the canonical
 *  rn-iap error code; `recoverable` is true for user-cancel and
 *  already-owned (Restore handles the latter). `E_RN_IAP_UNAVAILABLE` is
 *  our own code, emitted only when running under Expo Go (no dev client). */
export class IapPurchaseError extends Error {
  constructor(
    public code: string,
    public recoverable: boolean,
    message: string,
  ) {
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

/** Map react-native-iap's string error codes (from purchaseErrorListener or a
 *  synchronous launch throw) to our typed IapPurchaseError. */
function toIapError(e: any): IapPurchaseError {
  if (e instanceof IapPurchaseError) return e;
  const code: string = e?.code ?? "";
  const message = String(e?.message ?? "");
  const normalizedCode = code.toUpperCase().replace(/-/g, "_");
  const lowerMessage = message.toLowerCase();
  if (
    normalizedCode === "E_USER_CANCELLED" ||
    normalizedCode === "E_USER_CANCELED" ||
    normalizedCode === "USER_CANCELLED" ||
    normalizedCode === "USER_CANCELED" ||
    normalizedCode === "USER_CANCEL" ||
    lowerMessage.includes("user cancelled") ||
    lowerMessage.includes("user canceled")
  ) {
    return new IapPurchaseError("E_USER_CANCELLED", true, "User cancelled");
  }
  if (code === "E_ALREADY_OWNED")
    return new IapPurchaseError(code, true, "Already owned — try Restore");
  if (
    code === "duplicate-purchase" ||
    message.toLowerCase().includes("duplicate purchase update")
  ) {
    return new IapPurchaseError("E_ALREADY_OWNED", true, "Already owned — restoring purchase");
  }
  if (code === "E_NETWORK_ERROR") return new IapPurchaseError(code, true, "Network error");
  if (code === "E_ITEM_UNAVAILABLE")
    return new IapPurchaseError(code, false, "Product unavailable");
  if (code === "E_SERVICE_ERROR") return new IapPurchaseError(code, true, "Service unavailable");
  return new IapPurchaseError(code || "E_UNKNOWN", false, message || "Purchase failed");
}

function receiptForPurchase(purchase: Purchase, platform: "ios" | "android"): string | null {
  const p = purchase as any;
  const receipt =
    platform === "ios"
      ? (p.purchaseToken ?? p.jwsRepresentationIOS ?? p.transactionReceipt)
      : (p.purchaseToken ?? p.purchaseTokenAndroid);
  return typeof receipt === "string" && receipt.length > 0 ? receipt : null;
}

/** Call ONLY after server returns 2xx — protects against
 *  client-finishing-before-server-records race. No-op under Expo Go. */
export async function finishPurchase(p: Purchase): Promise<void> {
  const iap = getIap();
  if (!iap) return;
  await iap.finishTransaction({ purchase: p as any, isConsumable: false });
}

type RestorablePurchase = {
  productId: IAPProductId;
  receipt: string;
  platform: "ios" | "android";
  purchase?: Purchase;
};

function pushRestorablePurchase(
  out: RestorablePurchase[],
  seen: Set<string>,
  purchase: Purchase,
  platform: "ios" | "android",
): void {
  const id = (purchase as any).id ?? (purchase as any).productId;
  if (id !== "pro_monthly" && id !== "fina_pro_monthly" && id !== "max_monthly") return;
  const receipt = receiptForPurchase(purchase, platform);
  if (!receipt) return;
  const dedupKey =
    platform === "ios"
      ? ((purchase as any).originalTransactionIdentifierIOS ??
        (purchase as any).transactionIdIOS ??
        receipt)
      : receipt;
  if (seen.has(dedupKey)) return;
  seen.add(dedupKey);
  out.push({ productId: id as IAPProductId, receipt, platform, purchase });
}

function pushRestorableReceipt(
  out: RestorablePurchase[],
  seen: Set<string>,
  productId: unknown,
  receipt: unknown,
  platform: "ios" | "android",
  dedupKey?: unknown,
): void {
  if (
    productId !== "pro_monthly" &&
    productId !== "fina_pro_monthly" &&
    productId !== "max_monthly"
  )
    return;
  if (typeof receipt !== "string" || receipt.length === 0) return;
  const key = typeof dedupKey === "string" && dedupKey.length > 0 ? dedupKey : receipt;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ productId: productId as IAPProductId, receipt, platform });
}

async function collectCurrentIOSEntitlements(
  iap: RnIap,
  out: RestorablePurchase[],
  seen: Set<string>,
): Promise<void> {
  for (const sku of SKUS) {
    try {
      const entitlement = await iap.currentEntitlementIOS(sku);
      if (entitlement) {
        pushRestorablePurchase(out, seen, entitlement as Purchase, "ios");
        if (out.some((p) => p.productId === sku)) continue;
      }
    } catch {
      // Fall back to transaction JWS below.
    }
    try {
      const jws = await iap.getTransactionJwsIOS(sku);
      pushRestorableReceipt(out, seen, sku, jws, "ios", jws);
    } catch {
      // Some products simply have no current entitlement.
    }
  }
}

export async function listAvailablePurchases(): Promise<RestorablePurchase[]> {
  const iap = getIap();
  if (!iap) return [];
  await ensureConnected();
  const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
  const all: Purchase[] = await iap.getAvailablePurchases(
    platform === "ios"
      ? { alsoPublishToEventListenerIOS: false, onlyIncludeActiveItemsIOS: true }
      : undefined,
  );
  const out: RestorablePurchase[] = [];
  const seen = new Set<string>();
  for (const p of all) {
    pushRestorablePurchase(out, seen, p, platform);
  }
  if (out.length > 0) return out;

  if (platform === "ios") {
    await collectCurrentIOSEntitlements(iap, out, seen);
    if (out.length > 0) return out;
  }

  try {
    const active = await iap.getActiveSubscriptions(SKUS);
    for (const sub of active) {
      if (!sub.isActive) continue;
      const receipt =
        platform === "ios" ? sub.purchaseToken : (sub.purchaseTokenAndroid ?? sub.purchaseToken);
      pushRestorableReceipt(out, seen, sub.productId, receipt, platform, sub.transactionId);
    }
  } catch {
    // Best-effort fallback only. The caller will surface a restore message.
  }
  return out;
}

export async function showNativeSubscriptionManagement(): Promise<RestorablePurchase[]> {
  const iap = await ensureConnected();
  if (Platform.OS !== "ios") return [];

  let changed: Purchase[] = [];
  try {
    changed = await iap.showManageSubscriptionsIOS();
  } catch (e) {
    throw toIapError(e);
  }

  const out: RestorablePurchase[] = [];
  const seen = new Set<string>();

  for (const p of changed) pushRestorablePurchase(out, seen, p, "ios");

  try {
    const all: Purchase[] = await iap.getAvailablePurchases({
      alsoPublishToEventListenerIOS: false,
      onlyIncludeActiveItemsIOS: true,
    });
    for (const p of all) pushRestorablePurchase(out, seen, p, "ios");
  } catch {
    // Best-effort; App Store server notifications may still update the backend.
  }

  if (out.length === 0) {
    await collectCurrentIOSEntitlements(iap, out, seen);
  }

  try {
    const active = await iap.getActiveSubscriptions(SKUS);
    for (const sub of active) {
      if (!sub.isActive) continue;
      pushRestorableReceipt(out, seen, sub.productId, sub.purchaseToken, "ios", sub.transactionId);
    }
  } catch {
    // Best-effort; the caller falls back to refetching /me when no receipt is available.
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
