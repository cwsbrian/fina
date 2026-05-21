/** Display prices for the /settings/plan comparison table and any other
 * pricing copy. Stripe Price IDs live in apps/api env (STRIPE_PRICE_*);
 * this file is the single source of truth for human-readable amounts. */
export const PRICING = {
  lite: { monthlyCAD: 7, displayPrice: "$7" },
  pro: { monthlyCAD: 15, displayPrice: "$15" },
} as const;

/** Tuple of paid tiers. Mirrors `keyof typeof PRICING` at runtime so
 *  consumers like zod schemas and select dropdowns can iterate or
 *  pass it to `z.enum`. Keep in sync with PRICING — if a tier is
 *  added there, append it here too. */
export const PAID_TIERS = ["lite", "pro"] as const;

/** "lite" | "pro" — derived from PRICING so the union has exactly one
 *  source of truth. */
export type PaidTier = (typeof PAID_TIERS)[number];
