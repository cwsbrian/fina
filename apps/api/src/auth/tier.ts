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
    };
  }
  // Future: check active subscriptions for paid Pro/Lite — not in this plan.
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
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
