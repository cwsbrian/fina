import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      // Use the already-fetched user — avoids the extra findUniqueOrThrow that
      // effectiveTier(userId) would issue.
      const t = computeEffectiveTier(user);
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tz: user.tz,
          locale: user.locale,
        },
        tier: t.tier,
        trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
