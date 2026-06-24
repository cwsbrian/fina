CREATE TYPE "BudgetImpact" AS ENUM ('expense', 'excluded');
CREATE TYPE "BudgetImpactSource" AS ENUM ('auto', 'user');

ALTER TABLE "transactions"
  ADD COLUMN "budgetImpact" "BudgetImpact" NOT NULL DEFAULT 'expense',
  ADD COLUMN "budgetImpactSource" "BudgetImpactSource" NOT NULL DEFAULT 'auto';

CREATE INDEX "transactions_workspaceId_budgetImpact_occurredAt_idx"
  ON "transactions"("workspaceId", "budgetImpact", "occurredAt" DESC);
