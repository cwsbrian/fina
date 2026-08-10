import type { FastifyInstance } from "fastify";
import {
  CreateChatThreadBody,
  GetChatThreadQuery,
  ListChatThreadsQuery,
  PatchChatThreadBody,
  ChatMessageBody,
  isPaidFeatureTier,
} from "@fina/shared";
import { HttpError, requireSession, requireWorkspaceContext } from "../auth/context.js";
import { withRateLimit } from "../auth/rate-limit.js";
import { effectiveTier } from "../auth/tier.js";
import type { PresentationBlock } from "../chat/blocks.js";
import { threadsService } from "../chat/threads.js";
import { processChatTurn } from "../chat/turn.js";
import { prisma } from "../db.js";
import { isUserChatBudgetExceeded } from "../llm/budget.js";
import { logError, logWarn } from "../logger.js";

const DEFAULT_MESSAGE_PAGE_SIZE = 30;
type MessageCursor = { createdAt: string; id: string };

function encodeMessageCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeMessageCursor(value: string | undefined): MessageCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MessageCursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function serializeThread(t: {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
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
      if (!isPaidFeatureTier(tier.tier)) return reply.code(402).send({ error: "upgrade_required" });

      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      const thread = await threadsService.getOrCreateForWorkspace({
        userId: ctx.session.userId,
        workspaceId: ctx.membership.workspaceId,
        title: parsed.data.title ?? null,
      });
      return reply.code(200).send({ thread: serializeThread(thread) });
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
        userId: session.userId,
        includeArchived,
        limit,
      });

      // Hydrate per-thread aggregates: messageCount + firstMessagePreview
      // (the listing UI needs both — see existing chat.routes.test.ts).
      const threadIds = threads.map((t) => t.id);
      const counts =
        threadIds.length === 0
          ? []
          : await prisma.chatMessage.groupBy({
              by: ["threadId"],
              where: { threadId: { in: threadIds } },
              _count: { _all: true },
            });
      const firstUserMessages =
        threadIds.length === 0
          ? []
          : await prisma.chatMessage.findMany({
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
      const unreadRows =
        threadIds.length === 0
          ? []
          : await prisma.$queryRaw<
              Array<{
                threadId: string;
                cnt: bigint;
              }>
            >`
        SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS cnt
        FROM "chat_messages" m
        JOIN "chat_threads" t ON t.id = m."threadId"
        WHERE m."threadId" = ANY(${threadIds}::text[])
          AND m.role = 'assistant'
          AND (t."lastReadAt" IS NULL OR m."createdAt" > t."lastReadAt")
        GROUP BY m."threadId"
      `;
      const unreadByThread = new Map(unreadRows.map((r) => [r.threadId, Number(r.cnt)]));

      // Hydrate workspaceName per row so the listing UI can show which
      // workspace each thread lives in without a follow-up roundtrip.
      // Lazy threads (workspaceId === null) come back with workspaceName
      // === null and the renderer falls back to a neutral label.
      const wsIds = Array.from(
        new Set(threads.map((t) => t.workspaceId).filter((id): id is string => id !== null)),
      );
      const wsRows =
        wsIds.length === 0
          ? []
          : await prisma.workspace.findMany({
              where: { id: { in: wsIds } },
              select: { id: true, name: true },
            });
      const wsNameById = new Map(wsRows.map((w) => [w.id, w.name]));

      return {
        threads: threads.map((t) => ({
          ...serializeThread(t),
          messageCount: countByThread.get(t.id) ?? 0,
          firstMessagePreview: previewByThread.get(t.id) ?? null,
          unreadCount: unreadByThread.get(t.id) ?? 0,
          workspaceName: t.workspaceId ? (wsNameById.get(t.workspaceId) ?? null) : null,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    const parsedQuery = GetChatThreadQuery.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: "invalid_query" });
    const cursor = decodeMessageCursor(parsedQuery.data.cursor);
    if (parsedQuery.data.cursor && !cursor) {
      return reply.code(400).send({ error: "invalid_query" });
    }
    const limit = parsedQuery.data.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;
    try {
      const session = await requireSession(req, app);
      const thread = await threadsService.findOwned({
        threadId: params.tid,
        userId: session.userId,
      });
      if (!thread) {
        // Distinguish "row exists but wrong owner" (403) from "row doesn't
        // exist at all" (404). One direct lookup decides which.
        const exists = await prisma.chatThread.findUnique({
          where: { id: params.tid },
          select: { id: true },
        });
        return reply
          .code(exists ? 403 : 404)
          .send({ error: exists ? "forbidden" : "thread_not_found" });
      }

      // Skip role: "tool" rows — those carry { type: "tool", ... }
      // blocks that exist for LLM history replay (see turn.ts), not for
      // user display. Sending them surfaces an "Unsupported message
      // type" fallback in the mobile/web renderer.
      const recent = await prisma.chatMessage.findMany({
        where: {
          threadId: thread.id,
          role: { not: "tool" },
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: new Date(cursor.createdAt) } },
                  {
                    createdAt: new Date(cursor.createdAt),
                    id: { lt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = recent.slice(0, limit);
      const oldest = page.at(-1);
      const messages = page.reverse();

      // Action cards (confirm_card / *_form_card / plan_proposal_card) persist
      // an accept_intent in their block. The client's "already resolved"
      // dismissal is in-memory, so on reload a tapped/expired card would
      // re-open (and re-tapping hits intent_gone). Surface which of those
      // intents are already consumed OR expired so the client keeps the
      // resolved cards closed across re-entry.
      const intentIds = new Set<string>();
      for (const m of messages) {
        const blocks = Array.isArray(m.blocks)
          ? (m.blocks as Array<{ accept_intent?: unknown }>)
          : [];
        for (const b of blocks) {
          if (b && typeof b.accept_intent === "string") intentIds.add(b.accept_intent);
        }
      }
      const resolvedIntentIds =
        intentIds.size === 0
          ? []
          : (
              await prisma.actionIntent.findMany({
                where: {
                  id: { in: [...intentIds] },
                  OR: [{ consumedAt: { not: null } }, { expiresAt: { lte: new Date() } }],
                },
                select: { id: true },
              })
            ).map((r) => r.id);

      return {
        thread: serializeThread(thread),
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          blocks: m.blocks,
          createdAt: m.createdAt.toISOString(),
        })),
        resolvedIntentIds,
        nextCursor:
          recent.length > limit && oldest
            ? encodeMessageCursor({
                createdAt: oldest.createdAt.toISOString(),
                id: oldest.id,
              })
            : null,
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
      if (!isPaidFeatureTier(tier.tier)) return reply.code(402).send({ error: "upgrade_required" });

      const updated = await threadsService.patch({
        threadId: params.tid,
        userId: session.userId,
        title: parsed.data.title,
      });
      if (!updated) {
        const exists = await prisma.chatThread.findUnique({
          where: { id: params.tid },
          select: { id: true },
        });
        return reply
          .code(exists ? 403 : 404)
          .send({ error: exists ? "forbidden" : "thread_not_found" });
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
      if (!isPaidFeatureTier(tier.tier)) return reply.code(402).send({ error: "upgrade_required" });

      const archived = await threadsService.archive({
        threadId: params.tid,
        userId: session.userId,
      });
      if (!archived) {
        const exists = await prisma.chatThread.findUnique({
          where: { id: params.tid },
          select: { id: true },
        });
        return reply
          .code(exists ? 403 : 404)
          .send({ error: exists ? "forbidden" : "thread_not_found" });
      }
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post(
    "/chat/threads/:tid/messages",
    { config: withRateLimit("chatMessages") },
    async (req, reply) => {
      const params = req.params as { tid: string };
      const parsed = ChatMessageBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      try {
        const session = await requireSession(req, app);
        const tier = await effectiveTier(session.userId);
        if (!isPaidFeatureTier(tier.tier))
          return reply.code(402).send({ error: "upgrade_required" });

        // Weekly LLM spend cap (per user, rolling 7 days). Only gates the
        // user → Fina path; system-initiated features (brief, categorize)
        // keep running so Fina can still talk to the user even after the
        // cap is hit. See apps/api/src/llm/budget.ts.
        if (await isUserChatBudgetExceeded(session.userId, app.fina.env)) {
          return reply.code(429).send({ error: "llm_weekly_budget_exceeded" });
        }

        // New conversations are always bound at creation time. Nullable
        // workspaceId is retained only for legacy rows and cannot receive new
        // messages.
        const thread = await prisma.chatThread.findFirst({
          where: { id: params.tid, userId: session.userId, archivedAt: null },
          select: { id: true, workspaceId: true, title: true },
        });
        if (!thread) {
          const exists = await prisma.chatThread.findUnique({
            where: { id: params.tid },
            select: { userId: true, archivedAt: true },
          });
          if (!exists || exists.archivedAt)
            return reply.code(404).send({ error: "thread_not_found" });
          return reply.code(403).send({ error: "forbidden" });
        }

        if (thread.workspaceId === null) {
          return reply.code(409).send({ error: "thread_workspace_required" });
        }
        // Backward-compatible validation for clients that still send the old
        // workspaceId field. New clients omit it.
        if (
          parsed.data.workspaceId !== undefined &&
          thread.workspaceId !== parsed.data.workspaceId
        ) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }

        const membership = await prisma.membership.findUnique({
          where: {
            userId_workspaceId: {
              userId: session.userId,
              workspaceId: thread.workspaceId,
            },
          },
          select: { role: true },
        });
        if (!membership) return reply.code(403).send({ error: "not_member" });

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
            { id: thread.id, workspaceId: thread.workspaceId },
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
            ...(trimmedText.length > 0 ? [{ type: "text" as const, markdown: trimmedText }] : []),
            ...turn.presentationBlocks,
          ];
          if (blocks.length === 0) {
            // Model returned no text AND no tool produced a block. Most
            // likely cause is a model safety/recitation filter or a
            // misfire on the strict-scope prompt. Log for diagnosis so
            // we can tune prompt or model on repeated cases.
            logWarn(
              {
                threadId: thread.id,
                userId: session.userId,
                err: {
                  userText: parsed.data.text.slice(0, 200),
                  toolCalls: turn.toolCalls.length,
                },
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
    },
  );
}
