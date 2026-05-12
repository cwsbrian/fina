-- AlterTable
ALTER TABLE "plaid_items" ADD COLUMN     "connectedBy" TEXT;

-- CreateIndex
CREATE INDEX "plaid_items_connectedBy_idx" ON "plaid_items"("connectedBy");

-- AddForeignKey
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_connectedBy_fkey" FOREIGN KEY ("connectedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
