import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireSession } from "../auth/context.js";
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

const PatchBody = z.object({
  title: z.union([z.string().min(1).max(200), z.null()]),
});

function serializeThread(t: {
  id: string; userId: string; workspaceId: string | null; title: string | null;
  lastMessageAt: Date | null; archivedAt: Date | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: t.id,
    userId: t.userId,
    workspaceId: t.workspaceId,
    title: t.title,
    lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat/threads", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const thread = await threadsService.create({
        userId: session.userId,
        title: parsed.data.title ?? null,
      });
      return reply.code(201).send({ thread: serializeThread(thread) });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/chat/threads", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    try {
      const session = await requireSession(req, app);
      const includeArchived = parsed.data.include_archived === "true";
      const limit = parsed.data.limit ?? 50;
      const threads = await threadsService.list({
        userId: session.userId, includeArchived, limit,
      });

      // Hydrate per-thread aggregates: messageCount + firstMessagePreview
      // (the listing UI needs both — see existing chat.routes.test.ts).
      const threadIds = threads.map((t) => t.id);
      const counts = threadIds.length === 0 ? [] : await prisma.chatMessage.groupBy({
        by: ["threadId"],
        where: { threadId: { in: threadIds } },
        _count: { _all: true },
      });
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

  app.get("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    try {
      const session = await requireSession(req, app);
      const thread = await threadsService.findOwned({
        threadId: params.tid, userId: session.userId,
      });
      if (!thread) {
        // Distinguish "row exists but wrong owner" (403) from "row doesn't
        // exist at all" (404). One direct lookup decides which.
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }

      const recent = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const messages = recent.reverse();

      return {
        thread: serializeThread(thread),
        messages: messages.map((m) => ({
          id: m.id, role: m.role, blocks: m.blocks,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const updated = await threadsService.patch({
        threadId: params.tid, userId: session.userId, title: parsed.data.title,
      });
      if (!updated) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }
      return { thread: serializeThread(updated) };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const archived = await threadsService.archive({
        threadId: params.tid, userId: session.userId,
      });
      if (!archived) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  // Messages route (POST /chat/threads/:tid/messages) added in Task 6.
}
