CREATE TABLE "merchant_exclusions" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "merchantNormalized" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_exclusions_workspaceId_merchantNormalized_key"
  ON "merchant_exclusions"("workspaceId", "merchantNormalized");

ALTER TABLE "merchant_exclusions"
  ADD CONSTRAINT "merchant_exclusions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
