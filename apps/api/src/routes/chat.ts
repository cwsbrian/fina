import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { threadsService } from "../chat/threads.js";
import { prisma } from "../db.js";

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

const ListQuery = z.object({
  include_archived: z.union([z.literal("true"), z.literal("false")]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
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

  app.get("/workspaces/:id/chat/threads", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const includeArchived = parsed.data.include_archived === "true";
      const limit = parsed.data.limit ?? 50;
      const threads = await threadsService.list({
        workspaceId: ctx.membership.workspaceId,
        includeArchived,
        limit,
      });

      // Hydrate per-thread aggregates: messageCount + firstMessagePreview.
      const threadIds = threads.map((t) => t.id);
      const counts = threadIds.length === 0 ? [] : await prisma.chatMessage.groupBy({
        by: ["threadId"],
        where: { threadId: { in: threadIds } },
        _count: { _all: true },
      });
      // Prisma `distinct` keeps the first row per `threadId` in the supplied orderBy.
      // Ordering by threadId then createdAt asc → one row per thread, oldest first.
      const firstUserMessages = threadIds.length === 0 ? [] : await prisma.chatMessage.findMany({
        where: { threadId: { in: threadIds }, role: "user" },
        orderBy: [{ threadId: "asc" }, { createdAt: "asc" }],
        distinct: ["threadId"],
        select: { threadId: true, blocks: true },
      });
      const countByThread = new Map(counts.map((c) => [c.threadId, c._count._all]));
      const previewByThread = new Map<string, string | null>();
      for (const row of firstUserMessages) {
        const blocks = Array.isArray(row.blocks) ? row.blocks : [];
        const textBlock = (blocks as Array<{ type?: unknown; markdown?: unknown }>).find(
          (b) => b?.type === "text" && typeof b?.markdown === "string",
        );
        const md = textBlock?.markdown as string | undefined;
        previewByThread.set(row.threadId, md ? md.slice(0, 100) : null);
      }

      return {
        threads: threads.map((t) => ({
          ...serializeThread(t),
          messageCount: countByThread.get(t.id) ?? 0,
          firstMessagePreview: previewByThread.get(t.id) ?? null,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/workspaces/:id/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { id: string; tid: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const thread = await threadsService.findOwned({ threadId: params.tid, workspaceId: ctx.membership.workspaceId });
      if (!thread) return reply.code(404).send({ error: "thread_not_found" });

      // Fetch the newest 100 messages and reverse to chronological order.
      // Using orderBy asc + take 100 would return the oldest 100 — wrong for long threads.
      const recent = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const messages = recent.reverse();

      return {
        thread: serializeThread(thread),
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          blocks: m.blocks,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
