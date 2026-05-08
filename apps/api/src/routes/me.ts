import type { FastifyInstance } from "fastify";
import type { Tier } from "@fina/shared";
import { prisma } from "../db.js";

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
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const session = await app.fina.auth.api.getSession({ headers });
    if (!session?.user) return reply.code(401).send({ error: "unauthenticated" });

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: {
        memberships: { include: { workspace: true }, where: { role: "owner" }, take: 1 },
      },
    });
    if (!user) return reply.code(404).send({ error: "no_user" });
    const m = user.memberships[0];
    if (!m) return reply.code(404).send({ error: "no_workspace" });

    const { tier, trialActive, trialEndsAt } = effectiveTier(user);
    return {
      user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
      workspace: { id: m.workspace.id, name: m.workspace.name, role: m.role },
      tier,
      trial: {
        active: trialActive,
        endsAt: trialEndsAt?.toISOString() ?? null,
      },
    };
  });
}
