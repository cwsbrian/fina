-- Post-merge fix-up (Plan 2B): the earlier 20260522010336_restore_chat
-- _listing_index migration ran AFTER 20260522054349_plan_2b_daily_brief
-- in our local apply order, so dev/test DBs ended up with the index.
-- BUT Prisma applies migrations in LEXICAL filename order, not insertion
-- order. On a fresh DB (production deploy, fresh CI, new dev clone),
-- the lexical replay is:
--   1. _chat_user_scope          → CREATE index
--   2. _restore_chat_listing_idx → CREATE IF NOT EXISTS (no-op)
--   3. _plan_2b_daily_brief      → DROP index   ← bug
-- which leaves production WITHOUT the index. This migration sits AFTER
-- _plan_2b_daily_brief so the lexical replay restores it on every fresh
-- DB, while being a CREATE IF NOT EXISTS no-op on our already-fixed
-- dev/test DBs.
--
-- The index supports the chat-thread listing query at
-- apps/api/src/chat/threads.ts:
--   prisma.chatThread.findMany({
--     where: { userId, ... },
--     orderBy: [{ archivedAt: 'asc' }, { lastMessageAt: 'desc' /* NULLS LAST */ }],
--   })

CREATE INDEX IF NOT EXISTS "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
