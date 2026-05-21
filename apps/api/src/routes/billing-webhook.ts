import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { prisma } from "../db.js";

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

    // Dispatch (handlers added in Task 9). For now: just record the event
    // so the idempotency test passes and the foundation is complete.
    await prisma.$transaction(async (tx) => {
      // dispatchEvent(tx, event); // added in Task 9
      await tx.webhookEvent.create({
        data: { id: event.id, source: "stripe", type: event.type },
      });
    });

    return { ok: true };
  });
}
