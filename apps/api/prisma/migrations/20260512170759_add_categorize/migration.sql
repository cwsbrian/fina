-- CreateEnum
CREATE TYPE "MappingSource" AS ENUM ('manual', 'ai', 'auto');

-- CreateEnum
CREATE TYPE "CategorizationSource" AS ENUM ('mapping', 'ai', 'manual');

-- DropIndex
DROP INDEX "categories_workspaceId_name_key";

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "categorizationSource" "CategorizationSource";

-- CreateTable
CREATE TABLE "merchant_mappings" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "merchantNormalized" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "confidence" DECIMAL(3,2) NOT NULL DEFAULT 1.00,
    "source" "MappingSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_mappings_workspaceId_idx" ON "merchant_mappings"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_mappings_workspaceId_merchantNormalized_key" ON "merchant_mappings"("workspaceId", "merchantNormalized");

-- AddForeignKey
ALTER TABLE "merchant_mappings" ADD CONSTRAINT "merchant_mappings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_mappings" ADD CONSTRAINT "merchant_mappings_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique: case-insensitive name uniqueness scoped to ACTIVE categories.
-- Replaces the dropped @@unique([workspaceId, name]) from Prisma. Prisma can't
-- model partial indexes natively, so this is raw SQL.
CREATE UNIQUE INDEX "categories_one_active_name_per_workspace_ci"
  ON "categories" ("workspaceId", lower("name"))
  WHERE "archivedAt" IS NULL;

-- Seed 11 default English categories for every existing workspace.
-- gen_random_uuid() is a core Postgres 16 function, no extension needed.
-- WHERE NOT EXISTS is idempotent (safe to re-run).
INSERT INTO "categories" ("id", "workspaceId", "name", "createdAt")
SELECT
  gen_random_uuid()::text,
  w.id,
  c.name,
  NOW()
FROM "workspaces" w
CROSS JOIN (VALUES
  ('Groceries'),('Dining'),('Transit'),('Housing'),('Utilities'),
  ('Health'),('Shopping'),('Entertainment'),('Subscriptions'),('Income'),('Other')
) AS c(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "categories"
  WHERE "workspaceId" = w.id
    AND lower("name") = lower(c.name)
    AND "archivedAt" IS NULL
);
