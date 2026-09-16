ALTER TABLE "merchant_mappings" ADD COLUMN "type" "CategoryType" NOT NULL DEFAULT 'expense';

UPDATE "merchant_mappings" m
SET "type" = c."type"
FROM "categories" c
WHERE c."id" = m."categoryId";

DROP INDEX "merchant_mappings_workspaceId_merchantNormalized_key";
CREATE UNIQUE INDEX "merchant_mappings_workspaceId_merchantNormalized_type_key"
ON "merchant_mappings"("workspaceId", "merchantNormalized", "type");
