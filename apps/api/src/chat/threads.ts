import type { ChatThread } from "@prisma/client";
import { prisma } from "../db.js";

export const threadsService = {
  async create(input: { workspaceId: string; title?: string | null }): Promise<ChatThread> {
    return prisma.chatThread.create({
      data: { workspaceId: input.workspaceId, title: input.title ?? null },
    });
  },

  async list(input: { workspaceId: string; includeArchived: boolean; limit: number }): Promise<ChatThread[]> {
    return prisma.chatThread.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      // Postgres' default for `DESC` is NULLS FIRST. We want empty threads (lastMessageAt is null)
      // sorted last so active conversations show up first.
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: input.limit,
    });
  },

  async findOwned(input: { threadId: string; workspaceId: string }): Promise<ChatThread | null> {
    return prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
    });
  },

  async patch(input: { threadId: string; workspaceId: string; title: string | null }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!existing) return null;
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { title: input.title },
    });
  },

  async archive(input: { threadId: string; workspaceId: string }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) return null;
    if (existing.archivedAt) {
      // Already archived — return current row unchanged.
      return prisma.chatThread.findFirstOrThrow({ where: { id: existing.id } });
    }
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  },
};
