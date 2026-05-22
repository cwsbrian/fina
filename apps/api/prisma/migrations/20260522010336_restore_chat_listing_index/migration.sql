-- Restore the chat_threads listing index that Plan 2B's autogen migration
-- (20260522054349_plan_2b_daily_brief) dropped. Original index was created
-- via raw SQL in 20260520130000_chat_user_scope (NULLS LAST cannot be
-- expressed in Prisma DSL @@index) and supports the chat-thread listing
-- query at apps/api/src/chat/threads.ts:
--
--   prisma.chatThread.findMany({
--     where: { userId, ... },
--     orderBy: [{ archivedAt: 'asc' }, { lastMessageAt: 'desc' /* NULLS LAST */ }],
--   })
--
-- Without this index, that listing falls back to a sequential scan as the
-- chat_threads table grows. Re-creating it as a follow-up migration keeps
-- the autogen migration immutable.

CREATE INDEX IF NOT EXISTS "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
