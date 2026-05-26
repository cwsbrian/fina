import type { PaidTier } from "../pricing.js";

/** Single source of truth for IAP product SKUs. Same IDs on both
 *  Apple App Store and Google Play. v1 is monthly only — annual lands
 *  in v1.5 (per spec §12). billingPeriod intentionally omitted from
 *  the constant until then; v1 stores "monthly" directly on
 *  Subscription.billingPeriod at upsert time. */
export const IAP_PRODUCT_IDS = {
  lite_monthly: { tier: "lite" as const },
  pro_monthly: { tier: "pro" as const },
} as const;

/** Tuple of IAP product IDs. Mirrors `keyof typeof IAP_PRODUCT_IDS` at
 *  runtime so zod schemas can iterate or pass it to `z.enum`. Keep in
 *  sync with IAP_PRODUCT_IDS — if a SKU is added there, append it here too. */
export const IAP_PRODUCT_IDS_TUPLE = ["lite_monthly", "pro_monthly"] as const;

export type IAPProductId = (typeof IAP_PRODUCT_IDS_TUPLE)[number];

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
