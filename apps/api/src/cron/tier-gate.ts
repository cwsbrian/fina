import { effectiveTier } from "../auth/tier.js";
import { prisma } from "../db.js";

export type GateResult =
  | { ok: true; billingGrace?: true }
  | { ok: false; reason: string };

/**
 * Background-sync Plaid entitlement check — never throws; returns a
 * structured skip reason so callers can log and continue.
 */
export async function checkBackgroundSyncGate(
  userId: string,
  plaidItemId?: string,
): Promise<GateResult> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit > 0) return { ok: true };
  if (plaidItemId) {
    const item = await prisma.plaidItem.findFirst({
      where: {
        id: plaidItemId,
        connectedBy: userId,
        billingGraceEndsAt: { gt: new Date() },
        status: { not: "disconnected" },
      },
      select: { id: true },
    });
    if (item) return { ok: true, billingGrace: true };
  }
  return { ok: false, reason: "no_plaid_entitlement" };
}
