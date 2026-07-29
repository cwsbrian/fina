-- Preserve only the non-secret institution identifier on bank accounts.
-- The billable Plaid Item and encrypted access token can still be deleted on
-- downgrade while a later re-link can identify historical account rows.
ALTER TABLE "bank_accounts"
ADD COLUMN "plaidInstitutionId" TEXT;

UPDATE "bank_accounts" AS account
SET "plaidInstitutionId" = item."institutionId"
FROM "plaid_items" AS item
WHERE account."plaidItemId" = item."id";

CREATE INDEX "bank_accounts_workspaceId_plaidInstitutionId_archivedAt_idx"
ON "bank_accounts"("workspaceId", "plaidInstitutionId", "archivedAt");
