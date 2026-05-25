-- Plan 1K-cleanup-chat-index: schema-side @@index addition is idempotent
-- on DBs that already have the index, restorative on DBs that don't (e.g.,
-- those affected by the billing-pending-tier auto-DROP). IF NOT EXISTS
-- keeps it safe in both cases.
CREATE INDEX IF NOT EXISTS "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
