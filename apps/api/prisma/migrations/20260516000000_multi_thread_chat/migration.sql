-- DropIndex (Prisma's @@unique creates a unique INDEX, not a CONSTRAINT — DROP CONSTRAINT would fail)
DROP INDEX "chat_threads_workspaceId_type_key";

-- DropColumn + DropEnum
ALTER TABLE "chat_threads" DROP COLUMN "type";
DROP TYPE "ChatThreadType";

-- AddColumn
ALTER TABLE "chat_threads" ADD COLUMN "title" TEXT;
ALTER TABLE "chat_threads" ADD COLUMN "lastMessageAt" TIMESTAMP(3);
ALTER TABLE "chat_threads" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Backfill lastMessageAt from the most recent message per thread (NULL when the thread has no messages yet)
UPDATE "chat_threads" ct
SET "lastMessageAt" = (
  SELECT MAX("createdAt") FROM "chat_messages" WHERE "threadId" = ct.id
);

-- CreateIndex (compound key for list-by-recency, excluding archived).
-- NULLS LAST matches the list-route query (`lastMessageAt DESC NULLS LAST`);
-- the default for `DESC` would be NULLS FIRST and the planner would skip the index.
CREATE INDEX "chat_threads_workspaceId_archivedAt_lastMessageAt_idx"
  ON "chat_threads"("workspaceId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
