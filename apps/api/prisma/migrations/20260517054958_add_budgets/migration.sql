-- CreateTable
CREATE TABLE "budgets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "periodStart" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budgets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "budgets_workspaceId_periodStart_idx" ON "budgets"("workspaceId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "budgets_workspaceId_categoryId_periodStart_key" ON "budgets"("workspaceId", "categoryId", "periodStart");

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
