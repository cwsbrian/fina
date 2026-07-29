-- Distinguish billing-driven Plaid removal from an intentional disconnect.
-- The UI uses this durable marker after the billable plaid_items row and its
-- encrypted access token have been deleted.
ALTER TABLE "bank_accounts"
ADD COLUMN "plaidReconnectRequired" BOOLEAN NOT NULL DEFAULT false;

-- Old billing cleanup kept plaid_items rows with status='disconnected'.
-- Preserve that reconnect intent before the runtime cleanup sweep deletes
-- those legacy rows.
UPDATE "bank_accounts" AS account
SET "plaidReconnectRequired" = true
FROM "plaid_items" AS item
WHERE account."plaidItemId" = item."id"
  AND item."status" = 'disconnected'
  AND account."archivedAt" IS NOT NULL;

CREATE INDEX "bank_accounts_workspaceId_plaidReconnectRequired_archivedAt_idx"
ON "bank_accounts"("workspaceId", "plaidReconnectRequired", "archivedAt");
