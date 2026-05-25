import { prisma } from "../../db.js";
import { logInfo, logError } from "../../logger.js";
import type { Env } from "../../env.js";
import { sendTrialExpiringPush } from "../../push/send.js";

const THRESHOLDS = [5, 3, 1] as const;
const CRON_NAME = "trial-expiring";

/** Daily cron. For every user whose trial is still scheduled (not yet
 *  expired) and whose remaining-days count matches one of 5/3/1, send
 *  one push — but only if we haven't already sent for that same
 *  threshold. `lastTrialPushDays` on User stores the last threshold
 *  we pushed for, so within the same threshold band we don't repeat. */
export async function runTrialExpiring(env: Env): Promise<void> {
  const candidates = await prisma.user.findMany({
    where: {
      trialEndsAt: { gt: new Date() },
      trialConsumed: false,
    },
    select: {
      id: true,
      trialEndsAt: true,
      lastTrialPushDays: true,
    },
  });
  if (candidates.length === 0) return;

  const now = Date.now();
  for (const u of candidates) {
    if (!u.trialEndsAt) continue;
    const msLeft = u.trialEndsAt.getTime() - now;
    if (msLeft <= 0) continue;
    // Round UP so day-1 catches the final 24h, not just exact midnight.
    const daysLeft = Math.ceil(msLeft / 86_400_000);
    const matched = THRESHOLDS.find((t) => t === daysLeft);
    if (matched === undefined) continue;
    if (u.lastTrialPushDays === matched) continue; // already pushed at this threshold

    try {
      await sendTrialExpiringPush(env, u.id, matched);
      await prisma.user.update({
        where: { id: u.id },
        data: { lastTrialPushDays: matched },
      });
      logInfo(
        { cron: CRON_NAME, userId: u.id, daysLeft: matched },
        "trial-expiring push sent",
      );
    } catch (err) {
      logError(
        { cron: CRON_NAME, userId: u.id, err },
        "trial-expiring push failed",
      );
    }
  }
}
