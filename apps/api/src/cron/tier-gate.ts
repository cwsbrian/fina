import { effectiveTier } from "../auth/tier.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Background-sync Plaid entitlement check — never throws; returns a
 * structured skip reason so callers can log and continue.
 */
export async function checkBackgroundSyncGate(userId: string): Promise<GateResult> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit > 0) return { ok: true };
  return { ok: false, reason: "no_plaid_entitlement" };
}
