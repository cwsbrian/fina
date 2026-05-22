import type Stripe from "stripe";
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
  // `app` lets the same Stripe account host multiple apps and still
  // filter customers by source (Customer search supports metadata
  // queries: `metadata['app']:'fina'`). `fina_user_id` ties back to
  // our local User row.
  const params: Stripe.CustomerCreateParams = {
    email: user.email,
    metadata: { fina_user_id: user.id, app: "fina" },
  };
  if (user.name) params.name = user.name;
  const customer = await stripe.customers.create(params, {
    idempotencyKey: `customer-create-${user.id}`,
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}
