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

const SKUS: IAPProductId[] = ["pro_monthly", "max_monthly"];

export type LocalProduct = {
  productId: IAPProductId;
  tier: "pro" | "max";
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
      const productId = (id === "max_monthly" ? "max_monthly" : "pro_monthly") as IAPProductId;
      const tier: "pro" | "max" = productId === "max_monthly" ? "max" : "pro";
      const localizedPrice = String((s as any).displayPrice ?? (s as any).localizedPrice ?? (s as any).price ?? "");
      const localizedTitle = String((s as any).displayName ?? (s as any).title ?? productId);
      return { productId, tier, localizedPrice, localizedTitle };
    });
}

/** Resolve the Android base-plan offerToken for a subscription SKU. Play
 *  Billing v5+ requires it on the purchase request — launchBillingFlow fails
 *  with "item could not be found" if a sub is launched without one. The
 *  product query carries the token in subscriptionOfferDetailsAndroid. */
async function androidOfferToken(
  iap: RnIap,
  productId: IAPProductId,
): Promise<string | undefined> {
  const raw = await iap.fetchProducts({ skus: [productId], type: "subs" });
  const product = (raw as any[] | null)?.find((p) => String(p?.id) === productId);
  const offers = product?.subscriptionOfferDetailsAndroid ?? product?.subscriptionOffers;
  const token = offers?.[0]?.offerToken;
  return token ? String(token) : undefined;
}

/** Map react-native-iap's string error codes (from purchaseErrorListener or a
 *  synchronous launch throw) to our typed IapPurchaseError. */
function toIapError(e: any): IapPurchaseError {
  if (e instanceof IapPurchaseError) return e;
  const code: string = e?.code ?? "";
  if (code === "E_USER_CANCELLED") return new IapPurchaseError(code, true, "User cancelled");
  if (code === "E_ALREADY_OWNED") return new IapPurchaseError(code, true, "Already owned — try Restore");
  if (code === "E_NETWORK_ERROR") return new IapPurchaseError(code, true, "Network error");
  if (code === "E_ITEM_UNAVAILABLE") return new IapPurchaseError(code, false, "Product unavailable");
  if (code === "E_SERVICE_ERROR") return new IapPurchaseError(code, true, "Service unavailable");
  return new IapPurchaseError(code || "E_UNKNOWN", false, e?.message ?? "Purchase failed");
}

export async function purchaseSubscription(args: {
  productId: IAPProductId;
  userId: string;
}): Promise<{ receipt: string; platform: "ios" | "android"; purchase: Purchase }> {
  const iap = await ensureConnected();
  const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";

  // react-native-iap v14 (Nitro) delivers the completed purchase through
  // purchaseUpdatedListener — NOT as the return value of requestPurchase, which
  // resolves empty on Android. Arm the listeners first, fire the request, then
  // resolve on the matching purchase event (or reject via the error listener).
  return await new Promise((resolve, reject) => {
    let settled = false;
    const subs: Array<{ remove: () => void }> = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      for (const s of subs) s.remove();
    };
    const fail = (e: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(toIapError(e));
    };
    const succeed = (purchase: Purchase) => {
      if (settled) return;
      const receipt =
        platform === "ios"
          ? (purchase as any).jwsRepresentationIOS ?? (purchase as any).transactionReceipt
          : (purchase as any).purchaseToken ?? (purchase as any).purchaseTokenAndroid;
      if (!receipt) {
        fail(
          new IapPurchaseError(
            "E_NO_RECEIPT",
            false,
            platform === "ios"
              ? "No JWS receipt returned by StoreKit 2"
              : "No purchaseToken returned by Play Billing",
          ),
        );
        return;
      }
      settled = true;
      cleanup();
      resolve({ receipt: String(receipt), platform, purchase });
    };

    subs.push(
      iap.purchaseUpdatedListener((purchase) => {
        const id = (purchase as any).productId ?? (purchase as any).id;
        if (id && id !== args.productId) return; // a different SKU — keep waiting
        succeed(purchase);
      }),
    );
    subs.push(iap.purchaseErrorListener((err) => fail(err)));

    // Safety net: if neither listener fires (e.g. the sheet is dismissed with
    // no cancel event), don't leave the subscribe button spinning forever.
    timer = setTimeout(
      () => fail(new IapPurchaseError("E_UNKNOWN", true, "Purchase timed out")),
      180_000,
    );

    void (async () => {
      try {
        if (platform === "ios") {
          const appAccountToken = deriveAppleToken(args.userId);
          await iap.requestPurchase({
            request: { apple: { sku: args.productId, appAccountToken } },
            type: "subs",
          });
        } else {
          // Android — Play Billing requires the base-plan offerToken for subs.
          const obfuscatedAccountId = deriveGoogleToken(args.userId);
          const offerToken = await androidOfferToken(iap, args.productId);
          await iap.requestPurchase({
            request: {
              google: {
                skus: [args.productId],
                obfuscatedAccountId,
                ...(offerToken
                  ? { subscriptionOffers: [{ sku: args.productId, offerToken }] }
                  : {}),
              },
            },
            type: "subs",
          });
        }
      } catch (e) {
        fail(e); // synchronous launch failure (e.g. bad offer token)
      }
    })();
  });
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
    if (id !== "pro_monthly" && id !== "max_monthly") continue;
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
