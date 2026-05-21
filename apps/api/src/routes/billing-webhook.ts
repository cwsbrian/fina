import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { prisma } from "../db.js";
import { syncSubscriptionFromStripe } from "../stripe/sync-sub.js";

export async function billingWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Override the JSON parser to give us the raw buffer for signature
  // verification. Stripe.webhooks.constructEvent needs the exact bytes
  // that were signed — re-stringifying a parsed object breaks the check.
  // Scoped to this plugin's encapsulation context — does NOT affect other routes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/stripe", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    const rawBody = req.body as Buffer | undefined;
    if (!sig || typeof sig !== "string" || !rawBody) {
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(
        rawBody,
        sig,
        app.fina.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (e) {
      app.log.warn({ err: e }, "webhook signature verification failed");
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    // Idempotency: if we've already processed this event.id, short-circuit.
    const existing = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    if (existing) {
      return { ok: true };
    }

    // Dispatch the event, then record it for idempotency. These two operations
    // are intentionally NOT wrapped in a single interactive transaction:
    // handleEvent uses the global prisma client (via syncSubscriptionFromStripe),
    // and nesting global-prisma writes inside an interactive tx causes deadlocks
    // in Prisma 5. Instead: run the handler first, then record the event.
    // If handleEvent throws, we return 500 and Stripe retries — idempotency
    // in resolveUserIdByCustomer / upsert makes re-delivery safe.
    try {
      await handleEvent(app, event);
      await prisma.webhookEvent.create({
        data: { id: event.id, source: "stripe", type: event.type },
      });
    } catch (e) {
      app.log.error({ err: e, eventId: event.id, type: event.type }, "webhook handler failed");
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }

    return { ok: true };
  });
}

async function resolveUserIdByCustomer(customerId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
  return user?.id ?? null;
}

async function handleEvent(app: FastifyInstance, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      const userId = sess.client_reference_id;
      if (!userId) {
        app.log.warn({ eventId: event.id }, "checkout.session.completed without client_reference_id");
        return;
      }
      if (sess.customer) {
        const customerId = typeof sess.customer === "string" ? sess.customer : sess.customer.id;
        await prisma.user.updateMany({
          where: { id: userId, OR: [{ stripeCustomerId: null }, { stripeCustomerId: customerId }] },
          data: { stripeCustomerId: customerId },
        });
      }
      if (sess.subscription) {
        const subId = typeof sess.subscription === "string" ? sess.subscription : sess.subscription.id;
        await syncSubscriptionFromStripe(app.fina.env, subId, userId);
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const userId = await resolveUserIdByCustomer(customerId);
      if (!userId) {
        app.log.info({ eventId: event.id, customerId }, "no local user for customer; skipping");
        return;
      }
      await syncSubscriptionFromStripe(app.fina.env, sub.id, userId);
      return;
    }
    case "invoice.payment_failed":
      // No-op — the subsequent customer.subscription.updated with
      // status=past_due carries the new state.
      return;
    default:
      app.log.debug({ type: event.type }, "ignoring unhandled stripe event");
      return;
  }
}
