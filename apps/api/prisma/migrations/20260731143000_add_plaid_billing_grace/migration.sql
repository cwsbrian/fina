-- Preserve bank connections for 30 days after a user falls back to Free.
ALTER TABLE "plaid_items"
ADD COLUMN "billingGraceEndsAt" TIMESTAMP(3);

-- Transactions imported during grace are stored but hidden until upgrade.
ALTER TABLE "transactions"
ADD COLUMN "billingGraceHiddenAt" TIMESTAMP(3);

CREATE INDEX "plaid_items_billingGraceEndsAt_idx"
ON "plaid_items"("billingGraceEndsAt");

CREATE INDEX "transactions_plaidItemId_billingGraceHiddenAt_idx"
ON "transactions"("plaidItemId", "billingGraceHiddenAt");
