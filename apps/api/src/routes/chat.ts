import type { FastifyInstance } from "fastify";
import {
  CreateChatThreadBody,
  ListChatThreadsQuery,
  PatchChatThreadBody,
  ChatMessageBody,
} from "@fina/shared";
import { HttpError, requireSession } from "../auth/context.js";
import { withRateLimit } from "../auth/rate-limit.js";
import { effectiveTier } from "../auth/tier.js";
import { generateAndPersistThreadTitle } from "../chat/auto-title.js";
import type { PresentationBlock } from "../chat/blocks.js";
import { threadsService } from "../chat/threads.js";
import { processChatTurn } from "../chat/turn.js";
import { prisma } from "../db.js";
import { isUserChatBudgetExceeded } from "../llm/budget.js";
import { logError, logWarn } from "../logger.js";

function serializeThread(t: {
  id: string; userId: string; workspaceId: string | null; title: string | null;
  lastMessageAt: Date | null; archivedAt: Date | null;
  createdAt: Date; updatedAt: Date;
  lastReadAt: Date | null;
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
    lastReadAt: t.lastReadAt?.toISOString() ?? null,
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat/threads", async (req, reply) => {
    const parsed = CreateChatThreadBody.safeParse(req.body ?? {});
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
    const parsed = ListChatThreadsQuery.safeParse(req.query ?? {});
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

      // Unread assistant-message count per thread.
      // Single grouped raw query — uses thread.lastReadAt to filter; if NULL,
      // all assistant messages count as unread.
      const unreadRows = threadIds.length === 0 ? [] : await prisma.$queryRaw<Array<{
        threadId: string;
        cnt: bigint;
      }>>`
        SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS cnt
        FROM "chat_messages" m
        JOIN "chat_threads" t ON t.id = m."threadId"
        WHERE m."threadId" = ANY(${threadIds}::text[])
          AND m.role = 'assistant'
          AND (t."lastReadAt" IS NULL OR m."createdAt" > t."lastReadAt")
        GROUP BY m."threadId"
      `;
      const unreadByThread = new Map(unreadRows.map((r) => [r.threadId, Number(r.cnt)]));

      return {
        threads: threads.map((t) => ({
          ...serializeThread(t),
          messageCount: countByThread.get(t.id) ?? 0,
          firstMessagePreview: previewByThread.get(t.id) ?? null,
          unreadCount: unreadByThread.get(t.id) ?? 0,
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
    const parsed = PatchChatThreadBody.safeParse(req.body ?? {});
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

  app.post<{ Params: { tid: string } }>("/chat/threads/:tid/read", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const updated = await prisma.chatThread.updateMany({
        where: { id: req.params.tid, userId: session.userId },
        data: { lastReadAt: new Date() },
      });
      if (updated.count === 0) {
        return reply.code(404).send({ error: "thread_not_found" });
      }
      return reply.code(200).send({ ok: true });
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

  app.post("/chat/threads/:tid/messages", { config: withRateLimit("chatMessages") }, async (req, reply) => {
    const params = req.params as { tid: string };
    const parsed = ChatMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      // Weekly LLM spend cap (per user, rolling 7 days). Only gates the
      // user → Fina path; system-initiated features (brief, categorize)
      // keep running so Fina can still talk to the user even after the
      // cap is hit. See apps/api/src/llm/budget.ts.
      if (await isUserChatBudgetExceeded(session.userId, app.fina.env)) {
        return reply.code(429).send({ error: "llm_weekly_budget_exceeded" });
      }

      // Find the thread by id + userId first so we can detect workspace_mismatch
      // (400) before the membership check (403). Order matters: a bound thread
      // sending the wrong workspaceId should 400, not 403.
      // archivedAt IS NULL guards against POSTing to an archived thread.
      const thread = await prisma.chatThread.findFirst({
        where: { id: params.tid, userId: session.userId, archivedAt: null },
        select: { id: true, workspaceId: true, title: true },
      });
      if (!thread) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { userId: true, archivedAt: true } });
        if (!exists || exists.archivedAt) return reply.code(404).send({ error: "thread_not_found" });
        return reply.code(403).send({ error: "forbidden" });
      }

      // Early mismatch check: if thread is already bound to a different workspace,
      // return 400 before the membership check so workspace_mismatch wins over not_member.
      if (thread.workspaceId !== null && thread.workspaceId !== parsed.data.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      // Membership check uses the unique constraint @@unique([userId, workspaceId])
      // on Membership — see spec §5.2.
      const membership = await prisma.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: session.userId,
            workspaceId: parsed.data.workspaceId,
          },
        },
        select: { role: true },
      });
      if (!membership) return reply.code(403).send({ error: "not_member" });

      // Lazy bind — atomic conditional UPDATE wrapped in a transaction so a
      // concurrent archive can't slip between UPDATE and refetch (see spec §6.1).
      const boundWsId = await prisma.$transaction(async (tx) => {
        if (thread.workspaceId !== null) {
          // Mismatch was already caught above; this branch only runs when they match.
          return thread.workspaceId;
        }
        const upd = await tx.chatThread.updateMany({
          where: { id: thread.id, workspaceId: null, archivedAt: null },
          data: { workspaceId: parsed.data.workspaceId },
        });
        if (upd.count === 1) return parsed.data.workspaceId;
        // Lost the race: either someone else bound it, or it got archived.
        const refetched = await tx.chatThread.findFirstOrThrow({
          where: { id: thread.id },
          select: { workspaceId: true, archivedAt: true },
        });
        if (refetched.archivedAt !== null) throw new HttpError(404, "thread_not_found");
        if (refetched.workspaceId === null || refetched.workspaceId !== parsed.data.workspaceId) {
          throw new HttpError(400, "workspace_mismatch");
        }
        return refetched.workspaceId;
      });

      const userMessage = await prisma.$transaction(async (tx) => {
        const m = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            role: "user",
            blocks: [{ type: "text", markdown: parsed.data.text }],
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: m.createdAt },
        });
        return m;
      });

      let turn: Awaited<ReturnType<typeof processChatTurn>>;
      try {
        turn = await processChatTurn(
          app.fina.env,
          { id: thread.id, workspaceId: boundWsId },
          session.userId,
          membership.role,
        );
      } catch (e) {
        logError({ threadId: thread.id, err: e }, "chat provider failed");
        return reply.code(500).send({ error: "chat_provider_error" });
      }

      const assistantMessage = await prisma.$transaction(async (tx) => {
        // Empty text is filtered so a missing assistant reply doesn't
        // render as a hollow bubble above the card. The prompt requires
        // a one-sentence comment, but defensive filtering keeps the UI
        // clean if the model ever returns nothing.
        const trimmedText = (turn.assistantText ?? "").trim();
        const blocks: PresentationBlock[] = [
          ...(trimmedText.length > 0
            ? [{ type: "text" as const, markdown: trimmedText }]
            : []),
          ...turn.presentationBlocks,
        ];
        if (blocks.length === 0) {
          // Model returned no text AND no tool produced a block. Most
          // likely cause is a Gemini safety/recitation filter or a
          // misfire on the strict-scope prompt. Log for diagnosis so
          // we can tune prompt or model on repeated cases.
          logWarn(
            {
              threadId: thread.id,
              userId: session.userId,
              userText: parsed.data.text.slice(0, 200),
              toolCalls: turn.toolCalls.length,
            },
            "chat: assistant returned empty text + no blocks",
          );
          // Bilingual friendly retry — the user typed something, got
          // nothing back, deserves a real prompt to try again instead
          // of a debug placeholder.
          const userText = parsed.data.text;
          const looksKorean = /[ㄱ-힝]/.test(userText);
          blocks.push({
            type: "text",
            markdown: looksKorean
              ? "음, 그건 답을 정리 못 했어요. 다르게 다시 말해줄래요?"
              : "Hmm, I couldn't put that together. Want to rephrase?",
          });
        }
        const m = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            role: "assistant",
            blocks: blocks as never,
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: m.createdAt },
        });
        return m;
      });

      // Plan 1E-title: fire-and-forget auto-title on the first user message.
      // generateAndPersistThreadTitle no longer takes workspaceId — the
      // conditional update gates on (id, title IS NULL), which is sufficient
      // since threadId is a global cuid and auth is done above.
      if (thread.title === null) {
        try {
          const userMsgCount = await prisma.chatMessage.count({
            where: { threadId: thread.id, role: "user" },
          });
          if (userMsgCount === 1) {
            void generateAndPersistThreadTitle(
              app.fina.env, thread.id, session.userId, parsed.data.text,
            ).catch(() => {
              /* orchestrator logs internally */
            });
          }
        } catch (err) {
          logWarn({ threadId: thread.id, err }, "auto-title trigger gate failed");
        }
      }

      return {
        threadId: thread.id,
        userMessage: {
          id: userMessage.id,
          role: userMessage.role,
          blocks: userMessage.blocks,
          createdAt: userMessage.createdAt.toISOString(),
        },
        assistantMessage: {
          id: assistantMessage.id,
          role: assistantMessage.role,
          blocks: assistantMessage.blocks,
          createdAt: assistantMessage.createdAt.toISOString(),
        },
        toolCalls: turn.toolCalls,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
