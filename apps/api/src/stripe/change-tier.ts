import type { PaidTier } from "@fina/shared";
import type { Env } from "../env.js";
import { stripeClient } from "./client.js";
import { priceIdForTier } from "./pricing-map.js";

const TIER_RANK: Record<PaidTier, number> = { lite: 1, pro: 2 };

type Logger = {
  error: (obj: object, msg: string) => void;
  info?: (obj: object, msg: string) => void;
};
const consoleLogger: Logger = {
  error: (obj, msg) => console.error(JSON.stringify({ ...obj, msg })),
};

/** Change a Stripe subscription's tier. Direction-aware:
 *  - Upgrade (Lite → Pro): immediate switch with proration invoiced
 *    on the spot via `proration_behavior: "always_invoice"`.
 *  - Downgrade (Pro → Lite): schedule the switch at the current
 *    period end via stripe.subscriptionSchedules — the user keeps
 *    paid Pro until then, no charge now.
 *
 *  Stripe fires `customer.subscription.updated` for both paths; the
 *  existing webhook handler picks it up and upserts the local row
 *  via syncSubscriptionFromStripe — no DB writes needed here.
 *
 *  Returns the direction so callers can adjust UI copy. */
export async function changeSubscriptionTier(
  env: Env,
  stripeSubId: string,
  currentTier: PaidTier,
  targetTier: PaidTier,
  log: Logger = consoleLogger,
): Promise<{ direction: "upgrade" | "downgrade" }> {
  const stripe = stripeClient(env);
  const targetPriceId = priceIdForTier(env, targetTier);
  const isUpgrade = TIER_RANK[targetTier] > TIER_RANK[currentTier];

  const sub = await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ["items.data.price"],
  });
  const itemId = sub.items.data[0]?.id;
  if (!itemId) {
    log.error({ stripeSubId }, "subscription has no items");
    throw new Error("subscription_no_items");
  }

  if (isUpgrade) {
    // Immediate switch + invoice the proration now.
    await stripe.subscriptions.update(stripeSubId, {
      items: [{ id: itemId, price: targetPriceId }],
      proration_behavior: "always_invoice",
    });
    return { direction: "upgrade" };
  }

  // Downgrade — schedule at current_period_end so the user keeps
  // Pro features for the remainder of the cycle they already paid for.
  const schedule = await stripe.subscriptionSchedules.create({
    from_subscription: stripeSubId,
  });
  const currentPhase = schedule.phases[0];
  if (!currentPhase) {
    log.error({ stripeSubId, scheduleId: schedule.id }, "schedule created without current phase");
    throw new Error("schedule_missing_phase");
  }
  await stripe.subscriptionSchedules.update(schedule.id, {
    end_behavior: "release",
    phases: [
      {
        // Carry the current phase forward, ending it at the natural period boundary.
        items: currentPhase.items.map((i) => ({
          price: typeof i.price === "string" ? i.price : i.price.id,
          quantity: i.quantity ?? 1,
        })),
        start_date: currentPhase.start_date,
        end_date: currentPhase.end_date ?? sub.current_period_end,
      },
      {
        // New phase opens at the boundary, no proration needed (full cycle).
        items: [{ price: targetPriceId, quantity: 1 }],
      },
    ],
  });
  return { direction: "downgrade" };
}
