import type { PaidTier } from "../pricing.js";

/** Single source of truth for IAP product SKUs. Same IDs on both
 *  Apple App Store and Google Play. Annual products may exist in store
 *  consoles, but the app intentionally exposes monthly plans only until
 *  annual billing is enabled in product. */
export const IAP_PRODUCT_IDS = {
  pro_monthly: { tier: "pro" as const },
  max_monthly: { tier: "max" as const },
} as const;

/** Tuple of IAP product IDs. Mirrors `keyof typeof IAP_PRODUCT_IDS` at
 *  runtime so zod schemas can iterate or pass it to `z.enum`. Keep in
 *  sync with IAP_PRODUCT_IDS — if a SKU is added there, append it here too. */
export const IAP_PRODUCT_IDS_TUPLE = ["pro_monthly", "max_monthly"] as const;

export type IAPProductId = (typeof IAP_PRODUCT_IDS_TUPLE)[number];

export function tierForIapProductId(id: IAPProductId | string): PaidTier | null {
  if (id === "pro_monthly") return "pro";
  if (id === "max_monthly") return "max";
  return null;
}

export function iapProductIdForTier(tier: PaidTier): IAPProductId {
  if (tier === "pro") return "pro_monthly";
  if (tier === "max") return "max_monthly";
  const _exhaustive: never = tier;
  throw new Error(`Unknown tier: ${_exhaustive}`);
}
