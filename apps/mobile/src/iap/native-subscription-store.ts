import { NativeModules, Platform, Share } from "react-native";
import type { IAPProductId, MeDTO } from "@fina/shared";

import { postIAPCheckout } from "../api/billing";
import { isExpoGo } from "../env";
import { deriveAppleToken } from "./binding";
import { productIdsForPlatform } from "./products";

type NativeSubscriptionPurchase = {
  platform: "ios";
  productId: IAPProductId;
  selectedProductId?: string;
  originalTransactionId?: string;
  transactionId?: string;
  receipt: string;
};

export type NativeSubscriptionProduct = {
  productId: string;
  displayName: string;
  displayPrice: string;
  price: string;
  currencyCode: string | null;
  subscriptionPeriod?: { unit: string; value: number };
  introductoryOffer?: {
    displayPrice: string;
    price: string;
    period: { unit: string; value: number };
    periodCount: number;
    paymentMode: string;
    type: string;
  } | null;
};

type FinaNativeSubscriptionStoreModule = {
  present(
    productIds: string[],
    appAccountToken: string,
  ): Promise<NativeSubscriptionPurchase | null>;
  copyText?(text: string): Promise<boolean>;
  appTransaction?(): Promise<{ signedAppTransaction: string } | null>;
  currentEntitlements?(productIds: string[]): Promise<NativeSubscriptionPurchase[]>;
  products?(productIds: string[]): Promise<NativeSubscriptionProduct[]>;
};

export async function getSignedAppleAppTransaction(): Promise<string | null> {
  if (Platform.OS !== "ios" || isExpoGo) return null;
  const mod = nativeSubscriptionStoreModule();
  if (typeof mod?.appTransaction !== "function") return null;
  const result = await mod.appTransaction();
  return result?.signedAppTransaction || null;
}

function nativeSubscriptionStoreModule(): FinaNativeSubscriptionStoreModule | null {
  const mod = NativeModules.FinaNativeSubscriptionStore as
    | FinaNativeSubscriptionStoreModule
    | undefined;
  return typeof mod?.present === "function" ? mod : null;
}

export function nativeSubscriptionProductIds(): string[] {
  return productIdsForPlatform("ios");
}

export function hasNativeSubscriptionStoreEntitlementReader(): boolean {
  if (Platform.OS !== "ios" || isExpoGo) return false;
  const mod = nativeSubscriptionStoreModule();
  return typeof mod?.currentEntitlements === "function";
}

export async function copyTextToClipboard(text: string): Promise<"clipboard" | "share"> {
  const mod = nativeSubscriptionStoreModule();
  if (Platform.OS === "ios" && !isExpoGo && typeof mod?.copyText === "function") {
    await mod.copyText(text);
    return "clipboard";
  }

  await Share.share({ message: text });
  return "share";
}

export async function presentNativeSubscriptionStore(
  userId: string,
): Promise<NativeSubscriptionPurchase | null> {
  if (Platform.OS !== "ios") {
    throw new Error("Native App Store subscriptions are only available on iOS.");
  }

  const mod = nativeSubscriptionStoreModule();
  if (!mod || isExpoGo) {
    throw new Error(
      "Native App Store subscription selection is not available in this build. Rebuild the iOS dev client and try again.",
    );
  }

  return await mod.present(nativeSubscriptionProductIds(), deriveAppleToken(userId));
}

export async function presentNativeSubscriptionStoreAndSync(userId: string): Promise<MeDTO | null> {
  const purchase = await presentNativeSubscriptionStore(userId);
  if (!purchase) return null;

  console.info("[iap.nativeStore] completed", {
    productId: purchase.productId,
    selectedProductId: purchase.selectedProductId ?? null,
    originalTransactionId: purchase.originalTransactionId ?? null,
    transactionId: purchase.transactionId ?? null,
    receiptLength: purchase.receipt.length,
    dotCount: purchase.receipt.split(".").length - 1,
  });

  return await postIAPCheckout({
    platform: purchase.platform,
    productId: purchase.productId,
    receipt: purchase.receipt,
  });
}

export async function listNativeSubscriptionStoreEntitlements(): Promise<
  NativeSubscriptionPurchase[]
> {
  if (Platform.OS !== "ios") return [];
  const mod = nativeSubscriptionStoreModule();
  if (!mod?.currentEntitlements || isExpoGo) return [];
  return await mod.currentEntitlements(nativeSubscriptionProductIds());
}

export async function listNativeSubscriptionStoreProducts(): Promise<NativeSubscriptionProduct[]> {
  if (Platform.OS !== "ios") return [];
  const mod = nativeSubscriptionStoreModule();
  if (!mod?.products || isExpoGo) return [];
  return await mod.products(nativeSubscriptionProductIds());
}
