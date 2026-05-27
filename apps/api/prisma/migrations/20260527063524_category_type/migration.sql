-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('expense', 'income');

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "type" "CategoryType" NOT NULL DEFAULT 'expense';

-- CreateIndex
CREATE INDEX "categories_workspaceId_type_idx" ON "categories"("workspaceId", "type");


-- Backfill: legacy "Income" catch-all → type=income.
-- Existing transaction allocations stay intact (FK by id, not by name).
UPDATE "categories" SET "type" = 'income' WHERE name = 'Income';
