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
  if (plaidItemId) {
    const item = await prisma.plaidItem.findFirst({
      where: {
        id: plaidItemId,
        connectedBy: userId,
        status: { not: "disconnected" },
        workspace: { memberships: { some: { userId } } },
      },
      select: { billingGraceEndsAt: true },
    });
    if (!item) return { ok: false, reason: "invalid_plaid_item_owner" };
    if (t.plaidItemLimit > 0) return { ok: true };
    if (item.billingGraceEndsAt && item.billingGraceEndsAt > new Date()) {
      return { ok: true, billingGrace: true };
    }
  }
  if (t.plaidItemLimit > 0) return { ok: true };
  return { ok: false, reason: "no_plaid_entitlement" };
}
