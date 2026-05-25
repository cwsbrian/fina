-- CreateEnum
CREATE TYPE "CategorizationMode" AS ENUM ('flexible', 'strict', 'auto');

-- AlterEnum
ALTER TYPE "CategorizationSource" ADD VALUE 'history';

-- AlterTable
ALTER TABLE "transaction_allocations" ADD COLUMN     "dismissedUntil" TIMESTAMP(3),
ADD COLUMN     "needsConfirmation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "categorizationMode" "CategorizationMode" NOT NULL DEFAULT 'flexible';

-- CreateIndex (partial — Prisma can't express in schema)
CREATE INDEX "transactions_workspace_merchant_occurred_idx"
  ON "transactions" ("workspaceId", "merchantNormalized", "occurredAt" DESC)
  WHERE "removedAt" IS NULL;
