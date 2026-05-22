import type { FastifyInstance } from "fastify";
import type { $Enums, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import { ACTIVE_SUBSCRIPTION_STATUSES, PatchMeBody, type MeDTO, type SubscriptionDTO } from "@fina/shared";
import { localMidnightToUtc } from "../chat/tools/periods.js";

/** Convert "YYYY-MM-DD" + tz → UTC instant at NOON in that tz. Noon (not
 *  midnight) so the row's date-portion-in-tz unambiguously reads as the
 *  user's intended date regardless of any DST quirks at midnight. */
function tzNoonUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const midnightUtc = localMidnightToUtc(y!, m!, d!, tz);
  return new Date(midnightUtc.getTime() + 12 * 60 * 60 * 1000);
}

function toMeDTO(
  user: Awaited<ReturnType<typeof prisma.user.findUnique>> & object,
  activeSubs: Array<{ tier: string; status: string; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean; source: string; pendingTier: string | null; pendingTierAt: Date | null }>,
): MeDTO {
  const t = computeEffectiveTier(user, activeSubs as unknown as Parameters<typeof computeEffectiveTier>[1]);
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
        pendingTier: primary.pendingTier as "lite" | "pro" | null,
        pendingTierAt: primary.pendingTierAt?.toISOString() ?? null,
      }
    : null;
  // snoozeUntil → "YYYY-MM-DD" string (date portion in UTC; close enough for
  // settings UI display purposes; tz conversion in cron is what matters).
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

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: user.id, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      return toMeDTO(user, activeSubs);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = PatchMeBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const body = parsed.data;

      // Build a Prisma update payload — only fields explicitly present in
      // the body. snoozeUntil has tri-state (undefined no-op, null clear,
      // string set).
      const data: Prisma.UserUpdateInput = {};
      if (body.morningTime !== undefined) data.morningTime = body.morningTime;
      if (body.pauseEnabled !== undefined) data.pauseEnabled = body.pauseEnabled;
      if (body.tz !== undefined) data.tz = body.tz;
      if (body.snoozeUntil !== undefined) {
        // null clears; "YYYY-MM-DD" sets to UTC noon in user's tz.
        if (body.snoozeUntil === null) {
          data.snoozeUntil = null;
        } else {
          // Need the user's tz BEFORE the update applies — if the PATCH
          // body includes a new tz, that's the tz to interpret snoozeUntil
          // against. Else use existing User.tz.
          const tzForSnooze = body.tz ?? (await prisma.user.findUniqueOrThrow({
            where: { id: session.userId },
            select: { tz: true },
          })).tz;
          data.snoozeUntil = tzNoonUtc(body.snoozeUntil, tzForSnooze);
        }
      }

      const updated = await prisma.user.update({
        where: { id: session.userId },
        data,
      });
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: updated.id, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      return toMeDTO(updated, activeSubs);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
