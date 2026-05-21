import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { stripeClient } from "./client.js";
import { tierForPriceId } from "./pricing-map.js";

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
): Promise<{ status: string; tier: string } | null> {
  const stripe = stripeClient(env);
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });
  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    console.error(`stripe sub ${sub.id} has no price`);
    return null;
  }
  const tier = tierForPriceId(env, priceId);
  if (!tier) {
    console.error(`stripe sub ${sub.id} has unknown price ${priceId}`);
    return null;
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
    },
    update: {
      tier,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      // Don't change userId on update — sub belongs to one user forever.
    },
  });
  return { status: upserted.status, tier: upserted.tier };
}
