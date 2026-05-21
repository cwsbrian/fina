import { TIER_LIMITS, type EffectiveTier } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError } from "./context.js";

/** Pure computation — accepts an already-fetched user so callers that already
 *  hold the row (e.g. GET /me) avoid a redundant findUniqueOrThrow. */
export function computeEffectiveTier(user: {
  trialEndsAt: Date | null;
}): EffectiveTier {
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: TIER_LIMITS.pro.plaidItems,
    };
  }
  // Future: check paid subscription column here → "lite" or "pro".
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: TIER_LIMITS.free.plaidItems,
  };
}

export async function effectiveTier(userId: string): Promise<EffectiveTier> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return computeEffectiveTier(user);
}

export async function requireProTier(userId: string): Promise<void> {
  const t = await effectiveTier(userId);
  if (t.tier !== "pro") {
    throw new HttpError(402, "upgrade_required", `Pro tier required (current: ${t.tier})`);
  }
}
