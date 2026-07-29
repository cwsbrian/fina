// Type-only imports from react-native-iap are elided at runtime, so they
// don't pull in the Nitro native module. All runtime imports go through
// `getIap()` below — lazy-required inside try/catch so Expo Go (which has
// no NitroModules support) can still load this file. Functions degrade to
// empty-state / typed errors when the module is unavailable.
import type { Purchase } from "react-native-iap";
import { Platform } from "react-native";
import { isExpoGo } from "../env";
import type { IAPProductId, PaidTier } from "@fina/shared";
import { deriveAppleToken, deriveGoogleToken } from "./binding";
import {
  itemUnavailableMessage,
  productIdsForPlatform,
  productIdsForTier,
  purchaseFlowTimeoutMessage,
  type NativeIapPlatform,
} from "./products";

const SKUS: IAPProductId[] = productIdsForPlatform(Platform.OS === "ios" ? "ios" : "android");
const IS_DEV = typeof __DEV__ !== "undefined" ? __DEV__ : process.env.NODE_ENV !== "production";
const PURCHASE_FLOW_TIMEOUT_MS = IS_DEV ? 20_000 : 90_000;

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
    code === "already-owned" ||
    normalizedCode === "ALREADY_OWNED" ||
    lowerMessage.includes("already owned") ||
    code === "duplicate-purchase" ||
    message.toLowerCase().includes("duplicate purchase update")
  ) {
    return new IapPurchaseError("E_ALREADY_OWNED", true, "Already owned — restoring purchase");
  }
  if (code === "E_NETWORK_ERROR") return new IapPurchaseError(code, true, "Network error");
  if (
    code === "E_ITEM_UNAVAILABLE" ||
    normalizedCode === "ITEM_UNAVAILABLE" ||
    normalizedCode === "SKU_NOT_FOUND"
  ) {
    return new IapPurchaseError(
      "E_ITEM_UNAVAILABLE",
      false,
      Platform.OS === "ios"
        ? "This subscription is not available for purchase in the current App Store Connect setup."
        : "This subscription is not available for purchase in the current Google Play test setup.",
    );
  }
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

export async function clearPendingNativeTransactions(): Promise<void> {
  if (Platform.OS !== "ios") return;
  const iap = getIap();
  if (!iap) return;
  const clear = (iap as any).clearTransactionIOS;
  if (typeof clear !== "function") return;
  await clear();
}

export type RestorablePurchase = {
  productId: IAPProductId;
  receipt: string;
  platform: "ios" | "android";
  purchase?: Purchase;
};

export type LocalizedPlanPrices = Partial<Record<PaidTier, string>>;

function formattedStorePrice(product: any): string | null {
  const direct = [product?.displayPrice, product?.localizedPrice].find(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (typeof direct === "string") return direct.trim();

  // Google Play can expose the formatted recurring price only inside a
  // base-plan/offer pricing phase. The final phase is the ongoing monthly
  // price after any free trial or introductory period.
  const offers = [
    ...(Array.isArray(product?.subscriptionOffers) ? product.subscriptionOffers : []),
    ...(Array.isArray(product?.subscriptionOfferDetailsAndroid)
      ? product.subscriptionOfferDetailsAndroid
      : []),
  ];
  for (const offer of offers) {
    const phases =
      offer?.pricingPhases?.pricingPhaseList ??
      offer?.pricingPhasesAndroid?.pricingPhaseList ??
      [];
    if (!Array.isArray(phases)) continue;
    for (const phase of [...phases].reverse()) {
      const formatted = phase?.formattedPrice ?? phase?.priceFormatted;
      if (typeof formatted === "string" && formatted.trim().length > 0) {
        return formatted.trim();
      }
    }
  }
  return null;
}

function localizedPlanPricesFromProducts(
  products: readonly any[],
  platform: NativeIapPlatform,
): LocalizedPlanPrices {
  const result: LocalizedPlanPrices = {};
  for (const tier of ["pro", "max"] as const) {
    const candidates = productIdsForTier(tier, platform);
    const product = candidates
      .map((candidate) =>
        products.find((item: any) => {
          const id = item?.id ?? item?.productId;
          return id === candidate;
        }),
      )
      .find(Boolean);
    const displayPrice = formattedStorePrice(product);
    if (displayPrice) result[tier] = displayPrice;
  }
  return result;
}

/** Fetch storefront-localized subscription prices.
 *
 * StoreKit / Google Play own these values, including currency formatting and
 * regional pricing. An empty result means native IAP is unavailable (Expo Go)
 * or the storefront did not return a product; callers must not substitute a
 * hardcoded amount because it may be wrong for the user's country.
 */
export async function listLocalizedPlanPrices(): Promise<LocalizedPlanPrices> {
  const iap = getIap();
  if (!iap || (Platform.OS !== "ios" && Platform.OS !== "android")) return {};
  await ensureConnected();

  const platform: NativeIapPlatform = Platform.OS === "ios" ? "ios" : "android";
  const products = await iap.fetchProducts({
    skus: productIdsForPlatform(platform),
    type: "subs",
  });
  return localizedPlanPricesFromProducts(products ?? [], platform);
}

function pushRestorablePurchase(
  out: RestorablePurchase[],
  seen: Set<string>,
  purchase: Purchase,
  platform: "ios" | "android",
): void {
  const id = (purchase as any).productId ?? (purchase as any).id;
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

function purchaseFromNativeResult(
  result: Purchase | Purchase[] | null | undefined,
  expectedProductId: IAPProductId,
  platform: "ios" | "android",
): RestorablePurchase | null {
  const purchases = Array.isArray(result) ? result : result ? [result] : [];
  const out: RestorablePurchase[] = [];
  const seen = new Set<string>();
  for (const purchase of purchases) {
    pushRestorablePurchase(out, seen, purchase, platform);
  }
  return out.find((purchase) => purchase.productId === expectedProductId) ?? null;
}

async function resolveAndroidSubscriptionProduct(
  iap: RnIap,
  tier: PaidTier,
): Promise<{ productId: IAPProductId; subscriptionOffers: Array<{ sku: string; offerToken: string }> }> {
  const candidates = productIdsForTier(tier, "android");
  const products = await iap.fetchProducts({ skus: candidates, type: "subs" });
  const product = candidates
    .map((candidate) =>
      (products ?? []).find((item: any) => {
        const id = item?.id ?? item?.productId;
        return id === candidate;
      }),
    )
    .find(Boolean) as any;

  if (!product) {
    throw new IapPurchaseError(
      "E_ITEM_UNAVAILABLE",
      false,
      itemUnavailableMessage("android", candidates),
    );
  }

  const productId = (product.id ?? product.productId) as IAPProductId;

  const offers = [
    ...(Array.isArray(product?.subscriptionOffers) ? product.subscriptionOffers : []),
    ...(Array.isArray(product?.subscriptionOfferDetailsAndroid)
      ? product.subscriptionOfferDetailsAndroid
      : []),
  ];
  const offer = offers.find((item: any) => {
    const token = item?.offerTokenAndroid ?? item?.offerToken;
    return typeof token === "string" && token.length > 0;
  }) as any;
  const offerToken = offer?.offerTokenAndroid ?? offer?.offerToken;
  if (typeof offerToken !== "string" || offerToken.length === 0) {
    throw new IapPurchaseError(
      "E_ITEM_UNAVAILABLE",
      false,
      "This subscription product has no available Google Play base plan offer.",
    );
  }
  return { productId, subscriptionOffers: [{ sku: productId, offerToken }] };
}

async function resolveIOSSubscriptionProduct(iap: RnIap, tier: PaidTier): Promise<IAPProductId> {
  const candidates = productIdsForTier(tier, "ios");
  console.info("[iap.rn] fetchProducts start", { platform: "ios", tier, candidates });
  const products = await iap.fetchProducts({ skus: candidates, type: "subs" });
  console.info("[iap.rn] fetchProducts result", {
    platform: "ios",
    tier,
    products: (products ?? []).map((item: any) => ({
      id: item?.id ?? item?.productId ?? null,
      title: item?.title ?? item?.displayName ?? null,
      price: item?.displayPrice ?? item?.localizedPrice ?? item?.price ?? null,
    })),
  });
  const product = candidates
    .map((candidate) =>
      (products ?? []).find((item: any) => {
        const id = item?.id ?? item?.productId;
        return id === candidate;
      }),
    )
    .find(Boolean) as any;

  if (!product) {
    throw new IapPurchaseError(
      "E_ITEM_UNAVAILABLE",
      false,
      itemUnavailableMessage("ios", candidates),
    );
  }

  return (product.id ?? product.productId) as IAPProductId;
}

export async function requestSubscriptionPurchase(
  tier: PaidTier,
  userId: string,
): Promise<RestorablePurchase> {
  console.info("[iap.rn] checkout start", { tier, platform: Platform.OS });
  const iap = await ensureConnected();
  if (Platform.OS !== "ios" && Platform.OS !== "android") {
    throw new IapPurchaseError("E_RN_IAP_UNAVAILABLE", false, "Unsupported platform.");
  }

  const platform: NativeIapPlatform = Platform.OS === "ios" ? "ios" : "android";
  let productId = productIdsForTier(tier, platform)[0]!;
  let subscriptionOffers: Array<{ sku: string; offerToken: string }> | undefined;
  let androidReplacement:
    | { oldProductId: string; replacementMode: "with-time-proration" | "deferred" }
    | undefined;
  if (platform === "ios") {
    productId = await resolveIOSSubscriptionProduct(iap, tier);
  } else {
    const resolved = await resolveAndroidSubscriptionProduct(iap, tier);
    productId = resolved.productId;
    subscriptionOffers = resolved.subscriptionOffers;
    try {
      const active = await iap.getActiveSubscriptions(SKUS);
      const current = active.find(
        (sub) => sub.isActive && sub.productId && sub.productId !== productId,
      );
      if (current?.productId) {
        androidReplacement = {
          oldProductId: current.productId,
          replacementMode:
            current.productId === "max_monthly" && productId !== "max_monthly"
              ? "deferred"
              : "with-time-proration",
        };
      }
    } catch {
      // If Play cannot report active subscriptions, start the normal flow.
    }
  }

  return await new Promise<RestorablePurchase>((resolve, reject) => {
    let settled = false;
    let purchaseSub: { remove(): void } | null = null;
    let errorSub: { remove(): void } | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      purchaseSub?.remove();
      errorSub?.remove();
      fn();
    };

    purchaseSub = iap.purchaseUpdatedListener((purchase) => {
      console.info("[iap.rn] purchaseUpdated", {
        platform,
        expectedProductId: productId,
        purchase: Array.isArray(purchase)
          ? purchase.map((item: any) => ({
              id: item?.id ?? item?.productId ?? null,
              productId: item?.productId ?? item?.id ?? null,
              transactionIdIOS: item?.transactionIdIOS ?? null,
              originalTransactionIdentifierIOS: item?.originalTransactionIdentifierIOS ?? null,
              hasToken: Boolean(item?.purchaseToken ?? item?.jwsRepresentationIOS ?? item?.transactionReceipt),
            }))
          : {
              id: (purchase as any)?.id ?? (purchase as any)?.productId ?? null,
              productId: (purchase as any)?.productId ?? (purchase as any)?.id ?? null,
              transactionIdIOS: (purchase as any)?.transactionIdIOS ?? null,
              originalTransactionIdentifierIOS:
                (purchase as any)?.originalTransactionIdentifierIOS ?? null,
              hasToken: Boolean(
                (purchase as any)?.purchaseToken ??
                  (purchase as any)?.jwsRepresentationIOS ??
                  (purchase as any)?.transactionReceipt,
              ),
            },
      });
      const next = purchaseFromNativeResult(purchase, productId, platform);
      if (next) settle(() => resolve(next));
    });
    errorSub = iap.purchaseErrorListener((error) => {
      console.warn("[iap.rn] purchaseError", {
        code: (error as any)?.code ?? null,
        message: (error as any)?.message ?? null,
      });
      settle(() => reject(toIapError(error)));
    });
    timeout = setTimeout(() => {
      settle(() =>
        reject(
          new IapPurchaseError(
            "E_PURCHASE_FLOW_TIMEOUT",
            true,
            purchaseFlowTimeoutMessage(platform),
          ),
        ),
      );
    }, PURCHASE_FLOW_TIMEOUT_MS);

    void (async () => {
      try {
        console.info("[iap.rn] requestPurchase start", { platform, productId });
        const result =
          platform === "ios"
            ? await iap.requestPurchase({
                request: {
                  apple: {
                    sku: productId,
                    appAccountToken: deriveAppleToken(userId),
                    andDangerouslyFinishTransactionAutomatically: false,
                  },
                },
                type: "subs",
              })
            : await iap.requestPurchase({
                request: {
                  google: {
                    skus: [productId],
                    obfuscatedAccountId: deriveGoogleToken(userId),
                    ...(subscriptionOffers ? { subscriptionOffers } : {}),
                    ...(androidReplacement
                      ? { subscriptionProductReplacementParams: androidReplacement }
                      : {}),
                  },
                },
                type: "subs",
              });
        console.info("[iap.rn] requestPurchase result", {
          platform,
          productId,
          result: Array.isArray(result)
            ? result.map((item: any) => ({
                id: item?.id ?? item?.productId ?? null,
                productId: item?.productId ?? item?.id ?? null,
                transactionIdIOS: item?.transactionIdIOS ?? null,
                originalTransactionIdentifierIOS: item?.originalTransactionIdentifierIOS ?? null,
                hasToken: Boolean(item?.purchaseToken ?? item?.jwsRepresentationIOS ?? item?.transactionReceipt),
              }))
            : result
              ? {
                  id: (result as any)?.id ?? (result as any)?.productId ?? null,
                  productId: (result as any)?.productId ?? (result as any)?.id ?? null,
                  transactionIdIOS: (result as any)?.transactionIdIOS ?? null,
                  originalTransactionIdentifierIOS:
                    (result as any)?.originalTransactionIdentifierIOS ?? null,
                  hasToken: Boolean(
                    (result as any)?.purchaseToken ??
                      (result as any)?.jwsRepresentationIOS ??
                      (result as any)?.transactionReceipt,
                  ),
                }
              : null,
        });
        const next = purchaseFromNativeResult(result, productId, platform);
        if (next) settle(() => resolve(next));
      } catch (e) {
        console.warn("[iap.rn] requestPurchase throw", {
          code: (e as any)?.code ?? null,
          message: (e as any)?.message ?? null,
        });
        settle(() => reject(toIapError(e)));
      }
    })();
  });
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
      }
    } catch {
      // Some products simply have no current entitlement.
    }
  }
}

export const __private = {
  collectCurrentIOSEntitlements,
  formattedStorePrice,
  localizedPlanPricesFromProducts,
};

export async function listCurrentNativeEntitlements(): Promise<RestorablePurchase[]> {
  const iap = getIap();
  if (!iap) return [];
  await ensureConnected();
  const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
  const out: RestorablePurchase[] = [];
  const seen = new Set<string>();

  if (platform === "ios") {
    await collectCurrentIOSEntitlements(iap, out, seen);
    return out;
  }

  try {
    const active = await iap.getActiveSubscriptions(SKUS);
    for (const sub of active) {
      if (!sub.isActive) continue;
      const receipt = sub.purchaseTokenAndroid ?? sub.purchaseToken;
      pushRestorableReceipt(out, seen, sub.productId, receipt, platform, sub.transactionId);
    }
  } catch {
    // No active Play subscription visible on this device.
  }
  return out;
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

  try {
    if (typeof iap.deepLinkToSubscriptions === "function") {
      await iap.deepLinkToSubscriptions();
      return [];
    }
    return [];
  } catch (e) {
    throw toIapError(e);
  }
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
