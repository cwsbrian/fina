-- CreateTable
CREATE TABLE "budget_plans" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "categoryAllocations" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budget_plans_workspaceId_idx" ON "budget_plans"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "budget_plans_workspaceId_periodStart_key" ON "budget_plans"("workspaceId", "periodStart");

-- AddForeignKey
ALTER TABLE "budget_plans" ADD CONSTRAINT "budget_plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
