/** Display prices for the /settings/plan comparison table and any other
 * pricing copy. Stripe Price IDs live in apps/api env (STRIPE_PRICE_*);
 * this file is the single source of truth for human-readable amounts. */
export const PRICING = {
  pro: { monthlyCAD: 7.99, displayPrice: "$7.99" },
  max: { monthlyCAD: 16.99, displayPrice: "$16.99" },
} as const;

/** Tuple of paid tiers. Mirrors `keyof typeof PRICING` at runtime so
 *  consumers like zod schemas and select dropdowns can iterate or
 *  pass it to `z.enum`. Keep in sync with PRICING — if a tier is
 *  added there, append it here too. */
export const PAID_TIERS = ["pro", "max"] as const;

/** "pro" | "max" — derived from PRICING so the union has exactly one
 *  source of truth. */
export type PaidTier = (typeof PAID_TIERS)[number];
