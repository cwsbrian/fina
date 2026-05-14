import type { EffectiveTier } from "@fina/shared";
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
      plaidItemLimit: 5,
    };
  }
  // Future: check paid subscription column here → "lite" (2) or "pro" (5).
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: 0,
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
