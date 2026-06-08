import type { PaidTier } from "./pricing.js";

export const TIERS = ["free", "pro", "max"] as const;
export type Tier = (typeof TIERS)[number];

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierAtLeast(actual: Tier, required: Tier): boolean {
  return TIER_RANK[actual] >= TIER_RANK[required];
}

/** Per-tier limits — the canonical source for API enforcement and frontend
 * upsell copy. Max is marketed as expanded usage, with pragmatic internal caps. */
export const TIER_LIMITS: Record<Tier, { plaidItems: number; weeklyLlmBudgetCad: number }> = {
  free: { plaidItems: 0, weeklyLlmBudgetCad: 0 },
  pro: { plaidItems: 5, weeklyLlmBudgetCad: 0.5 },
  max: { plaidItems: 20, weeklyLlmBudgetCad: 2 },
};

/** Paid AI features are available to Pro and Max; this helper remains
 * for older call sites that ask whether a feature is Pro-exclusive. */
export function isProFeature(
  feature: "chat_input" | "advisor_chat" | "plan_generation" | "deep_audit",
): boolean {
  void feature;
  return false;
}

export function isPaidFeatureTier(tier: Tier): boolean {
  return tier === "pro" || tier === "max";
}

export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
  /** Mirror of `TIER_LIMITS[tier].plaidItems`. Included here so a single
   * `/me` response carries the cap without callers having to re-derive. */
  plaidItemLimit: number;
  /** Weekly LLM spend cap in CAD for user-initiated AI chat. */
  weeklyLlmBudgetCad: number;
};

/** Human-readable tier label for badges / settings copy. */
export function tierLabel(tier: Tier, trialActive: boolean): string {
  if (trialActive) return "Pro trial";
  if (tier === "max") return "Max";
  if (tier === "pro") return "Pro";
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

/** The tier a user reverts to when their active Pro trial ends. Returns the
 *  sub's tier — or its scheduled pendingTier when a change is queued. Returns
 *  null when: not in a trial, no standing sub on file, or the post-trial tier
 *  is still Pro-or-better (nothing to warn about).
 *  Param/return are PaidTier (exactly MeDTO.subscription's shape) — a standing
 *  sub is never `free`. */
export function trialRevertsTo(me: {
  trial: { active: boolean };
  subscription: { tier: PaidTier; pendingTier: PaidTier | null } | null;
}): PaidTier | null {
  if (!me.trial.active || !me.subscription) return null;
  const s = me.subscription;
  const next = s.pendingTier && s.pendingTier !== s.tier ? s.pendingTier : s.tier;
  return next === "pro" || next === "max" ? null : next;
}
