-- Sanity guard: every tx still must have at least one allocation summing to tx.amount
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
    RAISE EXCEPTION 'Allocation invariant broken: % rows have sum(allocations.amount) != tx.amount. Aborting migration B.', bad_count;
  END IF;
END $$;

-- Drop the column FK first (Prisma created it as transactions_categoryId_fkey)
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_categoryId_fkey";
DROP INDEX IF EXISTS "transactions_workspaceId_categoryId_idx";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "categoryId";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "categorizationSource";
