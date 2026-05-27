import {
  initConnection,
  endConnection,
  getSubscriptions,
  requestSubscription,
  getAvailablePurchases,
  finishTransaction,
  type Subscription as RnIapSubscription,
  type SubscriptionPurchase,
} from "react-native-iap";
import { Platform } from "react-native";
import { deriveAppleToken, deriveGoogleToken } from "./binding";
import type { IAPProductId } from "@fina/shared";

const SKUS: IAPProductId[] = ["lite_monthly", "pro_monthly"];

export type LocalProduct = {
  productId: IAPProductId;
  tier: "lite" | "pro";
  localizedPrice: string;
  localizedTitle: string;
};

let connected = false;

async function ensureConnected(): Promise<void> {
  if (connected) return;
  await initConnection();
  connected = true;
}

export async function fetchProducts(): Promise<LocalProduct[]> {
  await ensureConnected();
  const raw: RnIapSubscription[] = await getSubscriptions({ skus: SKUS });
  return raw
    .filter((s): s is RnIapSubscription => Boolean(s.productId))
    .map((s) => {
      const tier: "lite" | "pro" = s.productId === "pro_monthly" ? "pro" : "lite";
      const localizedPrice = (s as any).localizedPrice ?? (s as any).price ?? "";
      const localizedTitle = (s as any).title ?? s.productId;
      return { productId: s.productId as IAPProductId, tier, localizedPrice, localizedTitle };
    });
}

export class IapPurchaseError extends Error {
  constructor(public code: string, public recoverable: boolean, message: string) {
    super(message);
  }
}

export async function purchaseSubscription(args: {
  productId: IAPProductId;
  userId: string;
}): Promise<{ receipt: string; platform: "ios" | "android" }> {
  await ensureConnected();
  try {
    if (Platform.OS === "ios") {
      const appAccountToken = deriveAppleToken(args.userId);
      const purchase = await requestSubscription({
        sku: args.productId,
        appAccountToken,
      });
      const single: SubscriptionPurchase = Array.isArray(purchase) ? purchase[0] : purchase;
      const jws = (single as any).transactionReceipt ?? (single as any).jwsRepresentation;
      if (!jws) throw new IapPurchaseError("E_NO_RECEIPT", false, "No JWS receipt returned by StoreKit 2");
      return { receipt: String(jws), platform: "ios" };
    }
    const obfuscatedAccountId = deriveGoogleToken(args.userId);
    const purchase = await requestSubscription({
      sku: args.productId,
      obfuscatedAccountIdAndroid: obfuscatedAccountId,
      subscriptionOffers: undefined,
    } as any);
    const single: SubscriptionPurchase = Array.isArray(purchase) ? purchase[0] : purchase;
    const purchaseToken = (single as any).purchaseToken;
    if (!purchaseToken) throw new IapPurchaseError("E_NO_RECEIPT", false, "No purchaseToken returned by Play Billing");
    return { receipt: String(purchaseToken), platform: "android" };
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

export async function finishPurchase(p: SubscriptionPurchase): Promise<void> {
  await finishTransaction({ purchase: p, isConsumable: false });
}

export async function listAvailablePurchases(): Promise<
  Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android" }>
> {
  await ensureConnected();
  const all: SubscriptionPurchase[] = await getAvailablePurchases();
  const out: Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android" }> = [];
  const seen = new Set<string>();
  for (const p of all) {
    const productId = p.productId as string;
    if (productId !== "lite_monthly" && productId !== "pro_monthly") continue;
    const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
    const receipt = String(
      platform === "ios"
        ? (p as any).transactionReceipt ?? (p as any).jwsRepresentation
        : (p as any).purchaseToken,
    );
    const dedupKey = platform === "ios" ? (p as any).originalTransactionIdentifierIOS ?? receipt : receipt;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ productId: productId as IAPProductId, receipt, platform });
  }
  return out;
}

export async function disconnect(): Promise<void> {
  if (!connected) return;
  await endConnection();
  connected = false;
}
