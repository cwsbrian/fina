-- CreateEnum
CREATE TYPE "BriefType" AS ENUM ('daily', 'weekly', 'monthly');

-- DropForeignKey
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_userId_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_spends" DROP CONSTRAINT "scheduled_spends_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_spends" DROP CONSTRAINT "scheduled_spends_matchedTxId_fkey";

-- DropForeignKey
ALTER TABLE "scheduled_spends" DROP CONSTRAINT "scheduled_spends_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "transaction_allocations" DROP CONSTRAINT "transaction_allocations_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "transaction_allocations" DROP CONSTRAINT "transaction_allocations_transactionId_fkey";

-- DropIndex
DROP INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "morningTime" TEXT NOT NULL DEFAULT '08:00',
ADD COLUMN     "pauseEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "snoozeUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "BriefType" NOT NULL,
    "date" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "briefs_messageId_key" ON "briefs"("messageId");

-- CreateIndex
CREATE INDEX "briefs_userId_type_date_idx" ON "briefs"("userId", "type", "date");

-- CreateIndex
CREATE UNIQUE INDEX "briefs_userId_date_key" ON "briefs"("userId", "date");

-- AddForeignKey
ALTER TABLE "transaction_allocations" ADD CONSTRAINT "transaction_allocations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_allocations" ADD CONSTRAINT "transaction_allocations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_spends" ADD CONSTRAINT "scheduled_spends_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_spends" ADD CONSTRAINT "scheduled_spends_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_spends" ADD CONSTRAINT "scheduled_spends_matchedTxId_fkey" FOREIGN KEY ("matchedTxId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
