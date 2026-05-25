-- CreateTable
CREATE TABLE "goal_allocations" (
    "id" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "monthlyAmount" DECIMAL(14,2) NOT NULL,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "goal_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "goal_allocations_categoryId_idx" ON "goal_allocations"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "goal_allocations_goalId_categoryId_key" ON "goal_allocations"("goalId", "categoryId");

-- AddForeignKey
ALTER TABLE "goal_allocations" ADD CONSTRAINT "goal_allocations_goalId_fkey" FOREIGN KEY ("goalId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal_allocations" ADD CONSTRAINT "goal_allocations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
