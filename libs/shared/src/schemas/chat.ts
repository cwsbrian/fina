import { z } from "zod";

// Plan 2-chat-user-scope route bodies. Shape mirrors apps/api/src/routes/chat.ts.
// Frontend forms can validate against these before POSTing.

export const CreateChatThreadBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

export const PatchChatThreadBody = z.object({
  title: z.union([z.string().min(1).max(200), z.null()]),
});

export const ChatMessageBody = z.object({
  text: z.string().min(1).max(4000),
  // Legacy clients may still send workspaceId. New clients derive the
  // workspace from the canonical thread and never ask the user to choose.
  workspaceId: z.string().min(1).max(64).optional(),
});

export const ListChatThreadsQuery = z.object({
  include_archived: z.union([z.literal("true"), z.literal("false")]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type CreateChatThreadInput = z.infer<typeof CreateChatThreadBody>;
export type PatchChatThreadInput = z.infer<typeof PatchChatThreadBody>;
export type ChatMessageInput = z.infer<typeof ChatMessageBody>;
export type ListChatThreadsInput = z.infer<typeof ListChatThreadsQuery>;
