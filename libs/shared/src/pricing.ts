/** Human-readable Stripe web prices. Stripe Price IDs live in apps/api env
 *  (STRIPE_PRICE_*); this is only display copy. */
export const STRIPE_PRICING = {
  pro: { monthlyCAD: 7, displayPrice: "$7" },
  max: { monthlyCAD: 15, displayPrice: "$15" },
} as const;

/** Human-readable native in-app purchase prices. Apple / Google own the
 *  authoritative price; this mirrors our configured storefront copy. */
export const IAP_PRICING = {
  pro: { monthlyCAD: 7.99, displayPrice: "$7.99" },
  max: { monthlyCAD: 16.99, displayPrice: "$16.99" },
} as const;

/** Back-compat alias for web/Stripe pricing. New code should choose
 *  STRIPE_PRICING or IAP_PRICING explicitly. */
export const PRICING = STRIPE_PRICING;

/** Tuple of paid tiers. Mirrors `keyof typeof STRIPE_PRICING` at runtime so
 *  consumers like zod schemas and select dropdowns can iterate or
 *  pass it to `z.enum`. Keep in sync with pricing constants — if a tier is
 *  added there, append it here too. */
export const PAID_TIERS = ["pro", "max"] as const;

/** "pro" | "max". */
export type PaidTier = (typeof PAID_TIERS)[number];
