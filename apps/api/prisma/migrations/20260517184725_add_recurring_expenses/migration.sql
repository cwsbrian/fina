-- CreateEnum
CREATE TYPE "RecurringCadence" AS ENUM ('monthly', 'semimonthly', 'biweekly', 'weekly', 'yearly');

-- CreateTable
CREATE TABLE "recurring_expenses" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "categoryId" TEXT,
    "merchantNormalized" TEXT,
    "cadence" "RecurringCadence" NOT NULL,
    "nextOccurrenceDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_expenses_workspaceId_nextOccurrenceDate_idx" ON "recurring_expenses"("workspaceId", "nextOccurrenceDate");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_expenses_workspaceId_nameNormalized_key" ON "recurring_expenses"("workspaceId", "nameNormalized");

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
