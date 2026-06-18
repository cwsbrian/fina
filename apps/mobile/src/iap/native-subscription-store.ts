import { NativeModules, Platform } from "react-native";
import type { IAPProductId, MeDTO } from "@fina/shared";

import { postIAPCheckout } from "../api/billing";
import { isExpoGo } from "../env";
import { deriveAppleToken } from "./binding";
import { productIdsForPlatform } from "./products";

type NativeSubscriptionPurchase = {
  platform: "ios";
  productId: IAPProductId;
  receipt: string;
};

type FinaNativeSubscriptionStoreModule = {
  present(
    productIds: string[],
    appAccountToken: string,
  ): Promise<NativeSubscriptionPurchase | null>;
};

function nativeSubscriptionStoreModule(): FinaNativeSubscriptionStoreModule | null {
  const mod = NativeModules.FinaNativeSubscriptionStore as
    | FinaNativeSubscriptionStoreModule
    | undefined;
  return typeof mod?.present === "function" ? mod : null;
}

export function nativeSubscriptionProductIds(): string[] {
  return productIdsForPlatform("ios");
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

export async function presentNativeSubscriptionStoreAndSync(
  userId: string,
): Promise<MeDTO | null> {
  const purchase = await presentNativeSubscriptionStore(userId);
  if (!purchase) return null;

  return await postIAPCheckout({
    platform: purchase.platform,
    productId: purchase.productId,
    receipt: purchase.receipt,
  });
}
