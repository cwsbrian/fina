-- AlterTable
ALTER TABLE "plaid_items" ADD COLUMN     "webhookUrl" TEXT;

-- CreateTable
CREATE TABLE "plaid_webhook_events" (
    "id" TEXT NOT NULL,
    "plaidItemId" TEXT,
    "webhookType" TEXT NOT NULL,
    "webhookCode" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processError" TEXT,

    CONSTRAINT "plaid_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plaid_webhook_events_plaidItemId_receivedAt_idx" ON "plaid_webhook_events"("plaidItemId", "receivedAt");

-- CreateIndex
CREATE INDEX "plaid_webhook_events_webhookType_webhookCode_idx" ON "plaid_webhook_events"("webhookType", "webhookCode");

-- AddForeignKey
ALTER TABLE "plaid_webhook_events" ADD CONSTRAINT "plaid_webhook_events_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "plaid_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
