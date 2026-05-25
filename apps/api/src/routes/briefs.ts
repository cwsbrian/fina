import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";

export async function briefsRoutes(app: FastifyInstance): Promise<void> {
  // GET /briefs/latest — the most recent brief for the authenticated
  // user (by date string desc, which is lexicographically chronological
  // because we store YYYY-MM-DD). Includes the underlying message's
  // PresentationBlock[] for direct rendering on the Morning Brief
  // screen, plus the threadId so the UI can deep-link the user into the
  // chat thread for follow-up.
  app.get("/briefs/latest", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const row = await prisma.brief.findFirst({
        where: { userId: session.userId },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        include: {
          message: { select: { id: true, threadId: true, blocks: true, createdAt: true } },
        },
      });
      if (!row) return { brief: null };
      return {
        brief: {
          id: row.id,
          type: row.type,
          date: row.date,
          createdAt: row.createdAt.toISOString(),
          threadId: row.message.threadId,
          messageId: row.message.id,
          messageCreatedAt: row.message.createdAt.toISOString(),
          blocks: row.message.blocks,
        },
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
