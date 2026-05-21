export const TIERS = ["free", "lite", "pro"] as const;
export type Tier = (typeof TIERS)[number];

const TIER_RANK: Record<Tier, number> = { free: 0, lite: 1, pro: 2 };

export function tierAtLeast(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/** Per-tier limits — the canonical source for both API enforcement and
 * frontend upsell copy. `plaidItems` is the cap; chat / AI is gated on
 * `tier === "pro"` (see `isProFeature`). */
export const TIER_LIMITS: Record<Tier, { plaidItems: number }> = {
  free: { plaidItems: 0 },
  lite: { plaidItems: 2 },
  pro: { plaidItems: 5 },
};

/** Features gated to Pro tier (chat input, advisor mode, etc.). Lite gets
 * read-only daily ritual; Free is manual entry only. */
export function isProFeature(
  feature: "chat_input" | "advisor_chat" | "plan_generation" | "deep_audit",
): boolean {
  // All Pro-only flags are unconditionally Pro today. The function exists so
  // future Lite-extends-to behaviour lands in one place.
  void feature;
  return true;
}

export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
  /** Mirror of `TIER_LIMITS[tier].plaidItems`. Included here so a single
   * `/me` response carries the cap without callers having to re-derive. */
  plaidItemLimit: number;
};

/** Human-readable tier label for badges / settings copy. */
export function tierLabel(tier: Tier, trialActive: boolean): string {
  if (trialActive) return "Pro trial";
  if (tier === "pro") return "Pro";
  if (tier === "lite") return "Lite";
  return "Free";
}

/** Whole days remaining until `endsAt` (ISO string from MeDTO.trial.endsAt
 *  or a Date). Returns 0 if already past, null when endsAt is missing.
 *  Used for trial-ending UI ("3 days left"). */
export function trialDaysLeft(endsAt: string | Date | null | undefined): number | null {
  if (!endsAt) return null;
  const t = typeof endsAt === "string" ? new Date(endsAt).getTime() : endsAt.getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}
