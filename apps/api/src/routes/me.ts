import type { FastifyInstance } from "fastify";
import type { Tier } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";

function effectiveTier(user: { trialEndsAt: Date | null }): {
  tier: Tier;
  trialActive: boolean;
  trialEndsAt: Date | null;
} {
  const now = new Date();
  if (user.trialEndsAt && user.trialEndsAt > now) {
    return { tier: "pro", trialActive: true, trialEndsAt: user.trialEndsAt };
  }
  return { tier: "free", trialActive: false, trialEndsAt: user.trialEndsAt };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const { tier, trialActive, trialEndsAt } = effectiveTier(user);
      return {
        user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
        tier,
        trial: { active: trialActive, endsAt: trialEndsAt?.toISOString() ?? null },
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
