import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { processChatTurn } from "../chat/turn.js";

const Body = z.object({ text: z.string().min(1).max(4000) });

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/chat/message", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = Body.safeParse(req.body);
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

      const thread = await prisma.chatThread.upsert({
        where: { workspaceId_type: { workspaceId: ctx.membership.workspaceId, type: "adhoc" } },
        create: { workspaceId: ctx.membership.workspaceId, type: "adhoc" },
        update: {},
      });

      const userMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          role: "user",
          blocks: [{ type: "text", markdown: parsed.data.text }],
        },
      });

      let turn: Awaited<ReturnType<typeof processChatTurn>>;
      try {
        turn = await processChatTurn(app.fina.env, { id: thread.id, workspaceId: thread.workspaceId }, ctx.session.userId);
      } catch (e) {
        console.error("chat provider failed", { threadId: thread.id, err: e });
        return reply.code(500).send({ error: "chat_provider_error" });
      }

      const assistantMessage = await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          role: "assistant",
          blocks: [{ type: "text", markdown: turn.assistantText }],
        },
      });

      return {
        threadId: thread.id,
        userMessage: { id: userMessage.id, role: userMessage.role, blocks: userMessage.blocks, createdAt: userMessage.createdAt.toISOString() },
        assistantMessage: { id: assistantMessage.id, role: assistantMessage.role, blocks: assistantMessage.blocks, createdAt: assistantMessage.createdAt.toISOString() },
        toolCalls: turn.toolCalls,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/workspaces/:id/chat/thread", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const thread = await prisma.chatThread.upsert({
        where: { workspaceId_type: { workspaceId: ctx.membership.workspaceId, type: "adhoc" } },
        create: { workspaceId: ctx.membership.workspaceId, type: "adhoc" },
        update: {},
      });

      const messages = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "asc" },
        take: 100,
      });

      return {
        threadId: thread.id,
        messages: messages.map((m) => ({ id: m.id, role: m.role, blocks: m.blocks, createdAt: m.createdAt.toISOString() })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
