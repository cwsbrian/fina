import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import { ACTIVE_SUBSCRIPTION_STATUSES, type MeDTO, type SubscriptionDTO } from "@fina/shared";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: user.id, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const t = computeEffectiveTier(user, activeSubs);
      // Highest-tier active sub wins (pro > lite). MeDTO.subscription is
      // null when no active sub — canceled rows are retained in DB but
      // excluded here so the UI never accidentally shows Manage for a
      // dead subscription.
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
      const body: MeDTO = {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tz: user.tz,
          locale: user.locale,
        },
        tier: t.tier,
        trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
        subscription,
      };
      return body;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
