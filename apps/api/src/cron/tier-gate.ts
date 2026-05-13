import { effectiveTier } from "../auth/tier.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Background-sync version of requireProTier — never throws; returns a
 * structured skip reason so callers can log and continue.
 *
 * Reuses effectiveTier so trial/subscription logic stays in one place.
 * When paid subscriptions land (future plan), effectiveTier will return
 * tier:"pro" for subscribers — the first branch handles that correctly.
 */
export async function checkBackgroundSyncGate(userId: string): Promise<GateResult> {
  const t = await effectiveTier(userId);
  if (t.tier === "pro") return { ok: true };
  if (t.trialEndsAt && t.trialEndsAt <= new Date()) return { ok: false, reason: "trial_expired" };
  return { ok: false, reason: "no_subscription" };
}
