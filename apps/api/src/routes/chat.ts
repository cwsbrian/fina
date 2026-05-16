import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { threadsService } from "../chat/threads.js";

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

function serializeThread(t: { id: string; title: string | null; lastMessageAt: Date | null; archivedAt: Date | null; createdAt: Date }) {
  return {
    id: t.id,
    title: t.title,
    lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/chat/threads", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") {
        return reply.code(402).send({ error: "upgrade_required" });
      }
      const thread = await threadsService.create({
        workspaceId: ctx.membership.workspaceId,
        title: parsed.data.title ?? null,
      });
      return reply.code(201).send({ thread: serializeThread(thread) });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
