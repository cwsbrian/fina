CREATE TYPE "WorkspaceKind" AS ENUM ('personal', 'business');
CREATE TYPE "TaxCountry" AS ENUM ('CA', 'US');
CREATE TYPE "ReceiptRole" AS ENUM ('payment_proof', 'itemized', 'combined');
CREATE TYPE "ReceiptStatus" AS ENUM ('uploading', 'queued', 'processing', 'ocr_review', 'reviewed', 'failed', 'superseded', 'deleted');

ALTER TABLE "workspaces"
  ADD COLUMN "kind" "WorkspaceKind" NOT NULL DEFAULT 'personal',
  ADD COLUMN "taxCountry" "TaxCountry";

ALTER TABLE "transactions"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "classificationSourceReceiptId" TEXT,
  ADD COLUMN "businessPurpose" TEXT,
  ADD COLUMN "receiptMissingReason" TEXT,
  ADD COLUMN "receiptMissingNote" TEXT;

ALTER TABLE "transaction_allocations"
  ADD COLUMN "businessAmount" DECIMAL(14,2),
  ADD COLUMN "receiptLineItemId" TEXT;

CREATE TABLE "receipt_documents" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "transactionId" TEXT,
  "role" "ReceiptRole" NOT NULL,
  "status" "ReceiptStatus" NOT NULL DEFAULT 'uploading',
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "pageCount" INTEGER,
  "storageRegion" TEXT NOT NULL,
  "storageBucket" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "sha256" TEXT,
  "uploadedById" TEXT NOT NULL,
  "merchantName" TEXT,
  "receiptDate" TIMESTAMP(3),
  "totalAmount" DECIMAL(14,2),
  "currency" TEXT,
  "ocrRawData" JSONB,
  "ocrError" TEXT,
  "supersededById" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receipt_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receipt_line_items" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" DECIMAL(12,3),
  "unitPrice" DECIMAL(14,2),
  "lineTotal" DECIMAL(14,2) NOT NULL,
  "confidence" DECIMAL(5,4),
  "page" INTEGER NOT NULL DEFAULT 1,
  "boundingBox" JSONB,
  "editedDescription" TEXT,
  "editedQuantity" DECIMAL(12,3),
  "editedUnitPrice" DECIMAL(14,2),
  "editedLineTotal" DECIMAL(14,2),
  "categoryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "receipt_line_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_documents_storageKey_key" ON "receipt_documents"("storageKey");
CREATE INDEX "receipt_documents_workspaceId_createdAt_idx" ON "receipt_documents"("workspaceId", "createdAt" DESC);
CREATE INDEX "receipt_documents_transactionId_idx" ON "receipt_documents"("transactionId");
CREATE INDEX "receipt_documents_sha256_idx" ON "receipt_documents"("sha256");
CREATE INDEX "transactions_classificationSourceReceiptId_idx" ON "transactions"("classificationSourceReceiptId");
CREATE UNIQUE INDEX "transaction_allocations_receiptLineItemId_key" ON "transaction_allocations"("receiptLineItemId");
CREATE INDEX "receipt_line_items_receiptId_page_idx" ON "receipt_line_items"("receiptId", "page");
CREATE INDEX "receipt_line_items_categoryId_idx" ON "receipt_line_items"("categoryId");

ALTER TABLE "receipt_documents" ADD CONSTRAINT "receipt_documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receipt_documents" ADD CONSTRAINT "receipt_documents_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipt_documents" ADD CONSTRAINT "receipt_documents_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "receipt_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "receipt_line_items" ADD CONSTRAINT "receipt_line_items_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "receipt_line_items" ADD CONSTRAINT "receipt_line_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transaction_allocations" ADD CONSTRAINT "transaction_allocations_receiptLineItemId_fkey" FOREIGN KEY ("receiptLineItemId") REFERENCES "receipt_line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_classificationSourceReceiptId_fkey" FOREIGN KEY ("classificationSourceReceiptId") REFERENCES "receipt_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
