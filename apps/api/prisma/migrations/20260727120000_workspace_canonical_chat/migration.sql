-- One canonical user conversation per workspace. Existing duplicate bound
-- threads are merged chronologically by moving their messages to the oldest
-- thread, then removing the empty duplicate containers.
WITH ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY "userId", "workspaceId"
      ORDER BY "createdAt" ASC, id ASC
    ) AS canonical_id,
    ROW_NUMBER() OVER (
      PARTITION BY "userId", "workspaceId"
      ORDER BY "createdAt" ASC, id ASC
    ) AS rn
  FROM "chat_threads"
  WHERE "workspaceId" IS NOT NULL
),
moved AS (
  UPDATE "chat_messages" AS message
  SET "threadId" = ranked.canonical_id
  FROM ranked
  WHERE ranked.rn > 1
    AND message."threadId" = ranked.id
  RETURNING message.id
)
DELETE FROM "chat_threads" AS thread
USING ranked
WHERE ranked.rn > 1
  AND thread.id = ranked.id;

UPDATE "chat_threads" AS thread
SET "lastMessageAt" = (
  SELECT MAX(message."createdAt")
  FROM "chat_messages" AS message
  WHERE message."threadId" = thread.id
)
WHERE thread."workspaceId" IS NOT NULL;

CREATE UNIQUE INDEX "chat_threads_userId_workspaceId_key"
  ON "chat_threads"("userId", "workspaceId");

-- Briefs now belong to the same workspace conversation they are delivered
-- into. Backfill from the message's thread first; for legacy unbound threads,
-- a user with exactly one membership has an unambiguous workspace.
ALTER TABLE "briefs" ADD COLUMN "workspaceId" TEXT;

UPDATE "briefs" AS brief
SET "workspaceId" = thread."workspaceId"
FROM "chat_messages" AS message
JOIN "chat_threads" AS thread ON thread.id = message."threadId"
WHERE brief."messageId" = message.id
  AND thread."workspaceId" IS NOT NULL;

UPDATE "briefs" AS brief
SET "workspaceId" = membership."workspaceId"
FROM (
  SELECT "userId", MIN("workspaceId") AS "workspaceId"
  FROM "memberships"
  GROUP BY "userId"
  HAVING COUNT(*) = 1
) AS membership
WHERE brief."userId" = membership."userId"
  AND brief."workspaceId" IS NULL;

DROP INDEX "briefs_userId_date_key";
DROP INDEX "briefs_userId_type_date_idx";

CREATE UNIQUE INDEX "briefs_userId_workspaceId_date_key"
  ON "briefs"("userId", "workspaceId", "date");
CREATE INDEX "briefs_userId_workspaceId_type_date_idx"
  ON "briefs"("userId", "workspaceId", "type", "date");

ALTER TABLE "briefs"
  ADD CONSTRAINT "briefs_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
