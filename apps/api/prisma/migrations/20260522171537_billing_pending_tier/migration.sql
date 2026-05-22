-- DropIndex
DROP INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx";

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "pendingTier" TEXT,
ADD COLUMN     "pendingTierAt" TIMESTAMP(3);
