import type { Env } from "../env.js";
import type { PaidTier } from "@fina/shared";

/** tier → Stripe price ID. Throws if env is missing the mapping
 * (should never happen because env zod requires both). */
export function priceIdForTier(env: Env, tier: PaidTier): string {
  if (tier === "lite") return env.STRIPE_PRICE_LITE_MONTHLY;
  if (tier === "pro") return env.STRIPE_PRICE_PRO_MONTHLY;
  // Exhaustiveness — keeps TS happy if PaidTier ever grows.
  const _exhaustive: never = tier;
  throw new Error(`Unknown tier for pricing map: ${_exhaustive}`);
}

/** Stripe price ID → tier. Returns null for unknown IDs; webhook
 * handler logs + returns 200 in that case (prevents Stripe retry storm). */
export function tierForPriceId(env: Env, priceId: string): PaidTier | null {
  if (priceId === env.STRIPE_PRICE_LITE_MONTHLY) return "lite";
  if (priceId === env.STRIPE_PRICE_PRO_MONTHLY) return "pro";
  return null;
}
