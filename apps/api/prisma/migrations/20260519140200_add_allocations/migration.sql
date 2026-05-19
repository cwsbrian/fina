-- 1. Create the new table
CREATE TABLE "transaction_allocations" (
  "id"             TEXT PRIMARY KEY,
  "transactionId"  TEXT NOT NULL,
  "categoryId"     TEXT,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "source"         "CategorizationSource",
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transaction_allocations_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE,
  CONSTRAINT "transaction_allocations_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT
);
CREATE INDEX "transaction_allocations_transactionId_idx" ON "transaction_allocations"("transactionId");
CREATE INDEX "transaction_allocations_categoryId_idx"    ON "transaction_allocations"("categoryId");
CREATE INDEX "transaction_allocations_categoryId_transactionId_idx"
  ON "transaction_allocations"("categoryId", "transactionId");

-- 2. Add the new flag on transactions
ALTER TABLE "transactions" ADD COLUMN "needsReclassification" BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Backfill: one allocation per existing tx (matches current categoryId + categorizationSource)
INSERT INTO "transaction_allocations"
  ("id", "transactionId", "categoryId", "amount", "source", "createdAt", "updatedAt")
SELECT
  'allo_' || replace(gen_random_uuid()::text, '-', '')  AS id,
  t."id"                                                AS "transactionId",
  t."categoryId",
  t."amount",
  t."categorizationSource"                              AS "source",
  COALESCE(t."createdAt", CURRENT_TIMESTAMP),
  COALESCE(t."updatedAt", CURRENT_TIMESTAMP)
FROM "transactions" t;

-- 4. Safety guard: invariant sum(allocations.amount) === tx.amount per tx
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM (
    SELECT t."id", t."amount" AS tx_amount, COALESCE(SUM(a."amount"), 0) AS alloc_sum
    FROM "transactions" t
    LEFT JOIN "transaction_allocations" a ON a."transactionId" = t."id"
    GROUP BY t."id", t."amount"
  ) s
  WHERE s.alloc_sum <> s.tx_amount;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Allocation backfill mismatch: % rows have sum(allocations.amount) != tx.amount. Aborting migration.', bad_count;
  END IF;
END $$;
