import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { stripeClient } from "./client.js";
import { tierForPriceId } from "./pricing-map.js";

// Minimal logger contract — Pino's level methods + console both satisfy.
type Logger = {
  error: (obj: object, msg: string) => void;
  warn?: (obj: object, msg: string) => void;
};

const consoleLogger: Logger = {
  error: (obj, msg) => console.error(JSON.stringify({ ...obj, msg })),
};

/** Re-fetch a subscription from Stripe and UPSERT the local row.
 *
 * Used by every subscription-touching event handler (checkout.session.
 * completed, customer.subscription.created/updated/deleted) and by
 * /billing/sync. Re-fetching is Stripe's documented best practice —
 * webhook delivery is NOT ordered, so the event payload may be stale
 * relative to current Stripe state. Reading from the API guarantees
 * we converge to the correct state regardless of arrival order.
 *
 * Returns the upserted local row, or null if the price is unknown
 * (env mismatch — handler logs + returns 200 to avoid retry storms). */
export async function syncSubscriptionFromStripe(
  env: Env,
  subscriptionId: string,
  userId: string,
  log: Logger = consoleLogger,
): Promise<{ status: string; tier: string } | null> {
  const stripe = stripeClient(env);
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });
  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    log.error({ subscriptionId: sub.id }, "stripe sub has no price");
    return null;
  }
  const tier = tierForPriceId(env, priceId);
  if (!tier) {
    log.error({ subscriptionId: sub.id, priceId }, "stripe sub has unknown price ID");
    return null;
  }

  // If the sub is bound to a Schedule, the next phase tells us a
  // tier change is queued (Portal's "switch at period end" or our
  // /billing/change-tier downgrade both use schedules). Inspect the
  // phase AFTER the current one to surface what the user is switching
  // to and when. Cleared (null) when no schedule or schedule has no
  // next phase.
  let pendingTier: "lite" | "pro" | null = null;
  let pendingTierAt: Date | null = null;
  if (sub.schedule) {
    const scheduleId = typeof sub.schedule === "string" ? sub.schedule : sub.schedule.id;
    try {
      const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
      // Current phase = the one whose [start_date, end_date) contains now.
      const nowSec = Math.floor(Date.now() / 1000);
      const currentIdx = schedule.phases.findIndex(
        (p) => p.start_date <= nowSec && (p.end_date == null || p.end_date > nowSec),
      );
      const next = currentIdx >= 0 ? schedule.phases[currentIdx + 1] : undefined;
      const nextPriceRef = next?.items[0]?.price;
      if (next && nextPriceRef) {
        const nextPriceId = typeof nextPriceRef === "string" ? nextPriceRef : nextPriceRef.id;
        const nextTier = tierForPriceId(env, nextPriceId);
        if (nextTier && next.start_date) {
          pendingTier = nextTier;
          pendingTierAt = new Date(next.start_date * 1000);
        }
      }
    } catch (e) {
      // Schedule retrieve failure is non-fatal — log and continue with
      // pending fields null. Next sync will retry.
      log.error({ subscriptionId: sub.id, scheduleId, err: String(e) }, "schedule retrieve failed");
    }
  }

  const upserted = await prisma.subscription.upsert({
    where: {
      source_sourceSubscriptionId: {
        source: "stripe",
        sourceSubscriptionId: sub.id,
      },
    },
    create: {
      userId,
      tier,
      source: "stripe",
      sourceSubscriptionId: sub.id,
      sourceCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      billingPeriod: "monthly",
      pendingTier,
      pendingTierAt,
    },
    update: {
      tier,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      pendingTier,
      pendingTierAt,
      // Don't change userId on update — sub belongs to one user forever.
    },
  });
  return { status: upserted.status, tier: upserted.tier };
}
