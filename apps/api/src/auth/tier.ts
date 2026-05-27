import { ACTIVE_SUBSCRIPTION_STATUSES, TIER_LIMITS, type EffectiveTier, type Tier } from "@fina/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError } from "./context.js";
import { filterEnvironmentRows } from "../billing/precedence.js";

// Read APPLE_ENV directly from process.env to avoid validating the entire
// env schema at call time — tests that call effectiveTier() directly may
// not have STRIPE_* vars set (they use per-app `testEnv()` objects instead).
// APPLE_ENV is optional in the schema; default to "sandbox" when absent.
function getRuntimeEnv(): "sandbox" | "production" {
  return process.env.APPLE_ENV === "production" ? "production" : "sandbox";
}

/** Pure computation when caller already has the User + active subs.
 *  Order of precedence: trial > active paid sub (highest tier) > free. */
export function computeEffectiveTier(
  user: { trialEndsAt: Date | null },
  activeSubs: ReadonlyArray<{ tier: string }> = [],
): EffectiveTier {
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: TIER_LIMITS.pro.plaidItems,
    };
  }
  // Pick highest tier from active subs.
  const ranked = activeSubs
    .map((s) => s.tier as Tier)
    .filter((t): t is "lite" | "pro" => t === "lite" || t === "pro");
  if (ranked.length > 0) {
    const tier: "lite" | "pro" = ranked.includes("pro") ? "pro" : "lite";
    return {
      tier,
      source: "paid",
      trialActive: false,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: TIER_LIMITS[tier].plaidItems,
    };
  }
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: TIER_LIMITS.free.plaidItems,
  };
}

export async function effectiveTier(userId: string): Promise<EffectiveTier> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: { userId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] } },
      select: { tier: true, environment: true },
    }),
  ]);
  const filtered = filterEnvironmentRows(activeSubs, getRuntimeEnv());
  return computeEffectiveTier(user, filtered);
}

export async function requireProTier(userId: string): Promise<void> {
  const t = await effectiveTier(userId);
  if (t.tier !== "pro") {
    throw new HttpError(402, "upgrade_required", `Pro tier required (current: ${t.tier})`);
  }
}
