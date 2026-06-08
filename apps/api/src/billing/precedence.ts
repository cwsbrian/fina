type Sub = {
  source: string;
  tier: string;
  createdAt: Date;
  environment: string;
  sourceSubscriptionId: string;
  [k: string]: unknown;
};

const SOURCE_RANK: Record<string, number> = {
  stripe: 0,
  iap_apple: 2,
  iap_google: 3,
};
const TIER_RANK: Record<string, number> = { max: 0, pro: 1 };

/** Deterministic primary-sub picker. Stripe wins unconditionally;
 *  inside non-Stripe, max > pro; then source order; then createdAt ASC.
 *  See spec §8 "Stripe always wins regardless of tier". */
export function pickPrimarySub<T extends Sub>(subs: ReadonlyArray<T>): T | null {
  if (subs.length === 0) return null;
  const sorted = [...subs].sort((a, b) => {
    const aStripe = a.source === "stripe" ? 0 : 1;
    const bStripe = b.source === "stripe" ? 0 : 1;
    if (aStripe !== bStripe) return aStripe - bStripe;
    const tier = (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9);
    if (tier !== 0) return tier;
    const src = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    if (src !== 0) return src;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0] ?? null;
}

/** Filter out rows whose `environment` doesn't match the runtime.
 *  Stripe rows default to "Production" so they're always kept in prod.
 *  Generic over the minimal shape — accepts anything with `environment`. */
export function filterEnvironmentRows<T extends { environment: string }>(
  rows: ReadonlyArray<T>,
  runtime: "sandbox" | "production",
): T[] {
  if (runtime === "sandbox") return [...rows];
  return rows.filter((r) => r.environment === "Production");
}
