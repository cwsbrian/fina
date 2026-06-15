import {
  IAP_PRICING,
  STRIPE_PRICING,
  type PaidTier,
  type SubscriptionDTO,
  type SubscriptionSource,
} from "@fina/shared";

export function canManageSubscriptionOnWeb(sub: SubscriptionDTO | null): boolean {
  return sub?.source === "stripe";
}

export function canSwitchPlanOnWeb(sub: SubscriptionDTO | null): boolean {
  return sub === null || sub.source === "stripe";
}

export function externalBillingManagementText(sub: SubscriptionDTO | null): string | null {
  if (!sub || sub.source === "stripe") return null;
  if (sub.source === "iap_apple") {
    return "Manage this subscription in the App Store.";
  }
  return "Manage this subscription in Google Play.";
}

export function priceForBillingSource(
  source: SubscriptionSource,
  tier: PaidTier,
): string {
  return source === "stripe"
    ? STRIPE_PRICING[tier].displayPrice
    : IAP_PRICING[tier].displayPrice;
}
