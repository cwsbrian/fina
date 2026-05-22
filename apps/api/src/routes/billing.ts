import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { CheckoutBody, SyncBody, ACTIVE_SUBSCRIPTION_STATUSES } from "@fina/shared";
import type { MeDTO, SubscriptionDTO } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { stripeClient } from "../stripe/client.js";
import { priceIdForTier } from "../stripe/pricing-map.js";
import { ensureStripeCustomer } from "../stripe/ensure-customer.js";
import { syncSubscriptionFromStripe } from "../stripe/sync-sub.js";
import { changeSubscriptionTier } from "../stripe/change-tier.js";
import { computeEffectiveTier } from "../auth/tier.js";
import type { PaidTier } from "@fina/shared";

// Stripe requires trial_end to be at least 48h in the future (codex R3).
// Trials expiring sooner than this are treated as already-expired — the
// Checkout Session charges immediately rather than inheriting a short stub.
const STRIPE_TRIAL_END_MIN_MS = 48 * 60 * 60 * 1000;

function useTrialEnd(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt.getTime() - Date.now() >= STRIPE_TRIAL_END_MIN_MS;
}

async function buildMeBody(userId: string): Promise<MeDTO> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: {
        userId,
        status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] },
      },
      orderBy: { currentPeriodEnd: "desc" },
    }),
  ]);
  const t = computeEffectiveTier(user, activeSubs);
  // Highest-tier active sub wins (pro > lite). Canceled rows are
  // already filtered out by ACTIVE_SUBSCRIPTION_STATUSES (codex R8).
  const primary = activeSubs.find((s) => s.tier === "pro") ?? activeSubs[0];
  const subscription: SubscriptionDTO | null = primary
    ? {
        tier: primary.tier as "lite" | "pro",
        status: primary.status as SubscriptionDTO["status"],
        currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
        source: primary.source as SubscriptionDTO["source"],
      }
    : null;
  // snoozeUntil → "YYYY-MM-DD" string for UI display (matches toMeDTO in me.ts).
  const snoozeUntilStr = user.snoozeUntil
    ? user.snoozeUntil.toISOString().slice(0, 10)
    : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tz: user.tz,
      locale: user.locale,
      morningTime: user.morningTime,
      snoozeUntil: snoozeUntilStr,
      pauseEnabled: user.pauseEnabled,
    },
    tier: t.tier,
    trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
    subscription,
  };
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/billing/checkout", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = CheckoutBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });

      // 409 if any active sub already exists — Stripe Portal handles tier
      // changes, not Checkout. ACTIVE_SUBSCRIPTION_STATUSES covers trialing /
      // active / past_due (Smart Retries grace period).
      const active = await prisma.subscription.count({
        where: {
          userId: user.id,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] },
        },
      });
      if (active > 0) {
        return reply.code(409).send({ error: "already_subscribed" });
      }

      // Codex R7: persist Customer BEFORE Checkout so concurrent
      // first-Checkout attempts don't create duplicate Customers.
      // Idempotency key 'customer-create-<userId>' makes this safe to retry.
      const customerId = await ensureStripeCustomer(app.fina.env, user);

      const stripe = stripeClient(app.fina.env);
      const stripeSession = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [
          { price: priceIdForTier(app.fina.env, parsed.data.tier), quantity: 1 },
        ],
        client_reference_id: user.id,
        customer: customerId,
        // success_url includes {CHECKOUT_SESSION_ID} so /billing/sync can
        // resolve the session even before stripeCustomerId is persisted (codex R2).
        success_url: `${app.fina.env.WEB_APP_URL}/settings/plan?status=success&sessionId={CHECKOUT_SESSION_ID}`,
        cancel_url: `${app.fina.env.WEB_APP_URL}/settings/plan?status=cancel`,
        allow_promotion_codes: true,
        subscription_data: useTrialEnd(user.trialEndsAt)
          ? { trial_end: Math.floor(user.trialEndsAt!.getTime() / 1000) }
          : undefined,
      });

      return { url: stripeSession.url };
    } catch (e) {
      if (e instanceof HttpError) {
        return reply.code(e.statusCode).send({ error: e.code });
      }
      app.log.error({ err: e }, "checkout_failed");
      return reply.code(500).send({ error: "checkout_failed" });
    }
  });

  app.post("/billing/portal", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      if (!user.stripeCustomerId) {
        return reply.code(404).send({ error: "portal_failed" });
      }
      const stripe = stripeClient(app.fina.env);
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${app.fina.env.WEB_APP_URL}/settings/plan`,
      });
      return { url: portal.url };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e }, "portal_failed");
      return reply.code(500).send({ error: "portal_failed" });
    }
  });

  app.post("/billing/sync", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = SyncBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      const stripe = stripeClient(app.fina.env);

      // Path A — sessionId provided (Checkout success redirect, codex R2).
      // Works even when User.stripeCustomerId is still null.
      if (parsed.data.sessionId) {
        const sess = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
        if (sess.client_reference_id !== user.id) {
          return reply.code(403).send({ error: "checkout_failed" });
        }
        if (sess.customer) {
          await prisma.user.update({
            where: { id: user.id },
            data: { stripeCustomerId: typeof sess.customer === "string" ? sess.customer : sess.customer.id },
          });
        }
        if (sess.subscription) {
          const subId = typeof sess.subscription === "string" ? sess.subscription : sess.subscription.id;
          await syncSubscriptionFromStripe(app.fina.env, subId, user.id, app.log);
        }
      }

      // Path B — pull customer's subs list (covers plain refreshes + post-A).
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (fresh.stripeCustomerId) {
        const subs = await stripe.subscriptions.list({
          customer: fresh.stripeCustomerId,
          status: "all",
          limit: 10,
        });
        for (const sub of subs.data) {
          await syncSubscriptionFromStripe(app.fina.env, sub.id, user.id, app.log);
        }
      }

      return await buildMeBody(user.id);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      // Log tag mirrors the response code so monitoring/alerting can grep
      // for a single string (sync 500s show up under checkout_failed).
      app.log.error({ err: e, route: "/billing/sync" }, "checkout_failed");
      return reply.code(500).send({ error: "checkout_failed" });
    }
  });

  // Tier change on an existing subscription. Reuses CheckoutBody's
  // { tier } shape. Direction-aware (see stripe/change-tier.ts):
  //   - upgrade (Lite → Pro): proration invoiced immediately
  //   - downgrade (Pro → Lite): scheduled at current period end
  app.post("/billing/change-tier", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = CheckoutBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });

      const activeSub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] },
        },
        orderBy: { currentPeriodEnd: "desc" },
      });
      if (!activeSub) {
        return reply.code(400).send({ error: "no_active_subscription" });
      }
      if (activeSub.tier === parsed.data.tier) {
        return reply.code(400).send({ error: "already_on_tier" });
      }

      await changeSubscriptionTier(
        app.fina.env,
        activeSub.sourceSubscriptionId,
        activeSub.tier as PaidTier,
        parsed.data.tier,
        app.log,
      );

      // Re-fetch from Stripe so /me reflects the post-update state
      // immediately. Webhook will also fire and is idempotent.
      await syncSubscriptionFromStripe(
        app.fina.env,
        activeSub.sourceSubscriptionId,
        user.id,
        app.log,
      );

      return await buildMeBody(user.id);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/change-tier" }, "change_tier_failed");
      return reply.code(500).send({ error: "change_tier_failed" });
    }
  });
}
