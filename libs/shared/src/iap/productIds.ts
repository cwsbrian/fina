import type { PaidTier } from "../pricing.js";

/** Single source of truth for IAP product SKUs. Same IDs on both
 *  Apple App Store and Google Play. v1 is monthly only — annual lands
 *  in v1.5 (per spec §12). billingPeriod intentionally omitted from
 *  the constant until then; v1 stores "monthly" directly on
 *  Subscription.billingPeriod at upsert time. */
export const IAP_PRODUCT_IDS = {
  lite_monthly: { tier: "lite" as const },
  pro_monthly:  { tier: "pro"  as const },
} as const;

export type IAPProductId = keyof typeof IAP_PRODUCT_IDS;

export function tierForIapProductId(id: IAPProductId | string): PaidTier | null {
  if (id === "lite_monthly") return "lite";
  if (id === "pro_monthly") return "pro";
  return null;
}

export function iapProductIdForTier(tier: PaidTier): IAPProductId {
  if (tier === "lite") return "lite_monthly";
  if (tier === "pro") return "pro_monthly";
  const _exhaustive: never = tier;
  throw new Error(`Unknown tier: ${_exhaustive}`);
}
