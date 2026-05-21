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

  // Item routes (GET/PATCH/DELETE /chat/threads/:tid) added in Task 5.
  // Messages route (POST /chat/threads/:tid/messages) added in Task 6.
}
