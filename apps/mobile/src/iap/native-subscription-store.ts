import { NativeModules, Platform } from "react-native";
import type { MeDTO } from "@fina/shared";

import { isExpoGo } from "../env";
import { openManageBilling } from "./manage";
import { productIdsForPlatform } from "./products";
import { restoreCurrentNativeSubscriptions } from "./sync";

type FinaNativeSubscriptionStoreModule = {
  present(productIds: string[]): Promise<boolean>;
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

export async function presentNativeSubscriptionStore(): Promise<void> {
  if (Platform.OS !== "ios") {
    throw new Error("Native App Store subscriptions are only available on iOS.");
  }

  const mod = nativeSubscriptionStoreModule();
  if (!mod || isExpoGo) {
    await openManageBilling(undefined, "iap_apple");
    return;
  }

  await mod.present(nativeSubscriptionProductIds());
}

export async function presentNativeSubscriptionStoreAndSync(): Promise<MeDTO | null> {
  await presentNativeSubscriptionStore();
  return await restoreCurrentNativeSubscriptions().catch(() => null);
}
