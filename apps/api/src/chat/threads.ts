import type { ChatThread } from "@prisma/client";
import { prisma } from "../db.js";

// User-scoped CRUD. Lazy workspace binding is the route layer's
// responsibility — see routes/chat.ts POST /chat/threads/:tid/messages.
export const threadsService = {
  async create(input: { userId: string; title?: string | null }): Promise<ChatThread> {
    return prisma.chatThread.create({
      data: {
        userId: input.userId,
        workspaceId: null,
        title: input.title ?? null,
      },
    });
  },

  async list(input: {
    userId: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<ChatThread[]> {
    return prisma.chatThread.findMany({
      where: {
        userId: input.userId,
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: input.limit,
    });
  },

  async findOwned(input: { threadId: string; userId: string }): Promise<ChatThread | null> {
    return prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
    });
  },

  async patch(input: {
    threadId: string;
    userId: string;
    title: string | null;
  }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
      select: { id: true },
    });
    if (!existing) return null;
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { title: input.title },
    });
  },

  async archive(input: { threadId: string; userId: string }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) return null;
    if (existing.archivedAt) {
      return prisma.chatThread.findFirstOrThrow({ where: { id: existing.id } });
    }
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  },
};
