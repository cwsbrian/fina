import type { Env } from "../env.js";
import type { User } from "@prisma/client";
import { prisma } from "../db.js";
import { stripeClient } from "./client.js";

/** Lazy create + persist a Stripe Customer for the user. Idempotent
 * across retries via Idempotency-Key: a DB-write failure between
 * stripe.customers.create() and prisma.user.update() doesn't orphan
 * a customer — the next call returns the same Stripe Customer.
 *
 * MUST be called before stripe.checkout.sessions.create() so the
 * session uses `customer: <id>` rather than `customer_email`, which
 * would create a fresh Customer record on every concurrent Checkout. */
export async function ensureStripeCustomer(env: Env, user: User): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = stripeClient(env);
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.name ?? undefined,
      metadata: { fina_user_id: user.id },
    },
    { idempotencyKey: `customer-create-${user.id}` },
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}
