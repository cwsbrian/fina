import type { IAPProductId, PaidTier } from "@fina/shared";

export type NativeIapPlatform = "ios" | "android";

export function productIdsForTier(
  tier: PaidTier,
  platform: NativeIapPlatform,
): IAPProductId[] {
  if (tier === "max") return ["max_monthly"];
  return platform === "ios" ? ["fina_pro_monthly", "pro_monthly"] : ["pro_monthly"];
}

export function productIdsForPlatform(platform: NativeIapPlatform): IAPProductId[] {
  return platform === "ios"
    ? ["fina_pro_monthly", "max_monthly"]
    : ["pro_monthly", "max_monthly"];
}

export function purchaseFlowTimeoutMessage(platform: NativeIapPlatform): string {
  return platform === "ios"
    ? "The App Store did not return a purchase result. Your current subscription was refreshed; try again if nothing changed."
    : "Google Play did not return a purchase result. Your current subscription was refreshed; try again if nothing changed.";
}

export function itemUnavailableMessage(
  platform: NativeIapPlatform,
  productIds: readonly IAPProductId[],
): string {
  const idList = productIds.join(", ");
  return platform === "ios"
    ? `This subscription is not available in App Store Connect for this build. Checked product ID: ${idList}.`
    : `This subscription is not available in Google Play for this build. Checked product ID: ${idList}.`;
}
