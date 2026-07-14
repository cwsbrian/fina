ALTER TYPE "BudgetImpact" RENAME TO "BudgetImpact_old";
CREATE TYPE "BudgetImpact" AS ENUM ('expense', 'income', 'refund', 'excluded');

ALTER TABLE "transactions" ALTER COLUMN "budgetImpact" DROP DEFAULT;
ALTER TABLE "transactions"
  ALTER COLUMN "budgetImpact" TYPE "BudgetImpact"
  USING ("budgetImpact"::text::"BudgetImpact");
ALTER TABLE "transactions" ALTER COLUMN "budgetImpact" SET DEFAULT 'expense';
DROP TYPE "BudgetImpact_old";

ALTER TABLE "transactions"
  ADD COLUMN "refundOfTransactionId" TEXT;

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_refundOfTransactionId_fkey"
  FOREIGN KEY ("refundOfTransactionId") REFERENCES "transactions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "transactions_refundOfTransactionId_idx"
  ON "transactions"("refundOfTransactionId");

-- Negative rows used to be excluded wholesale. Reclassify automatic rows while
-- preserving explicit user exclusions. Refund categories and clear provider
-- refund metadata win; person-to-person transfers remain real cashflow; known
-- internal/card/investment transfers stay excluded.
UPDATE "transactions" AS t
SET "budgetImpact" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "transaction_allocations" a
    JOIN "categories" c ON c."id" = a."categoryId"
    WHERE a."transactionId" = t."id"
      AND c."type" = 'income'
      AND LOWER(c."name") = 'refund'
  )
    OR UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE '%REFUND%'
    OR UPPER(t."merchantRaw") ~ '(^|[^A-Z0-9])(REFUND|REFUNDED|REVERSAL)([^A-Z0-9]|$)'
    THEN 'refund'::"BudgetImpact"
  WHEN UPPER(t."merchantRaw") ~ '(^|[^A-Z0-9])(E-TRANSFER|E-TFR|INTERAC|ZELLE|VENMO|CASH APP|PAYPAL)([^A-Z0-9]|$)'
    THEN 'income'::"BudgetImpact"
  WHEN UPPER(COALESCE(t."rawData" #>> '{personal_finance_category,detailed}', '')) LIKE ANY (
      ARRAY['%ACCOUNT_TRANSFER%', '%CREDIT_CARD_PAYMENT%', '%INVESTMENT%', '%RETIREMENT%']
    )
    OR UPPER(t."merchantRaw") ~ '(^|[^A-Z0-9])(TRANSFER TO|TRANSFER FROM|XFER TO|XFER FROM|XFR TO|XFR FROM|TRSF TO|TRSF FROM|TRNSFR TO|TRNSFR FROM|ONLINE TRANSFER|INTERNAL TRANSFER|ACCOUNT TRANSFER|BOOK TRANSFER|BETWEEN ACCOUNTS)([^A-Z0-9]|$)'
    THEN 'excluded'::"BudgetImpact"
  ELSE 'income'::"BudgetImpact"
END
WHERE t."amount" < 0
  AND t."budgetImpactSource" = 'auto';
