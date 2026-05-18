-- Safety guard: refuse to drop the per-row currency columns if ANY row
-- has a currency different from its workspace's currency. The plan
-- assumes single-currency-per-workspace; this migration enforces that
-- invariant at the data level before destroying the column.
--
-- In current dev state all rows are 'CAD' (workspace default), so this
-- passes silently. In any environment that allowed mixed-currency
-- writes, the migration fails loudly and operator must reconcile
-- before retrying (manual UPDATE or workspace split).
DO $$
DECLARE
  bad_tx  INTEGER;
  bad_rec INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_tx FROM transactions t
    JOIN workspaces w ON w.id = t."workspaceId"
    WHERE t.currency <> w.currency;
  SELECT COUNT(*) INTO bad_rec FROM recurring_expenses r
    JOIN workspaces w ON w.id = r."workspaceId"
    WHERE r.currency <> w.currency;
  IF bad_tx > 0 OR bad_rec > 0 THEN
    RAISE EXCEPTION 'Cannot drop currency columns: % transactions and % recurring_expenses have currency != workspace.currency. Reconcile before re-running this migration.', bad_tx, bad_rec;
  END IF;
END$$;

-- AlterTable
ALTER TABLE "transactions" DROP COLUMN "currency";

-- AlterTable
ALTER TABLE "recurring_expenses" DROP COLUMN "currency";
