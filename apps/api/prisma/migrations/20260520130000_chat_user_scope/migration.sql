-- Plan 2-chat-user-scope: rebind ChatThread to user, allow null workspace.
-- Pre-launch destructive migration — no chat data is preserved.

-- 1. Purge dependent state.
--    chat_messages has ON DELETE CASCADE from chat_threads, so dropping
--    threads automatically purges messages.
--    action_intents has `messageId TEXT` with NO foreign key — orphans
--    would survive a cascade. Purge explicitly.
--    audit_events is NOT chat-scoped — its rows describe tool calls and
--    are independent of chat thread lifecycle. Do NOT delete them.
DELETE FROM "action_intents";
DELETE FROM "chat_threads";

-- 2. Drop the old workspace-listing index.
DROP INDEX IF EXISTS "chat_threads_workspaceId_archivedAt_lastMessageAt_idx";

-- 3. Schema change: add userId, make workspaceId nullable.
ALTER TABLE "chat_threads" ADD COLUMN "userId" TEXT NOT NULL;
ALTER TABLE "chat_threads" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

-- 4. New user-listing index (NULLS LAST matches the §4.4 brief-cron
-- selection query and the §5.3 listing query alike).
CREATE INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
