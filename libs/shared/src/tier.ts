export const TIERS = ["free", "lite", "pro"] as const;
export type Tier = (typeof TIERS)[number];

const TIER_RANK: Record<Tier, number> = { free: 0, lite: 1, pro: 2 };

export function tierAtLeast(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
  plaidItemLimit: number;  // 0 = no Plaid (Free), 2 = Lite, 5 = Pro
};
