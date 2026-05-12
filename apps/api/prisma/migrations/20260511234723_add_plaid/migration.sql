-- CreateEnum
CREATE TYPE "PlaidItemStatus" AS ENUM ('active', 'error', 'relink_required');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'closed', 'hidden');

-- CreateEnum
CREATE TYPE "TransactionSource" AS ENUM ('plaid', 'manual', 'csv');

-- CreateTable
CREATE TABLE "plaid_items" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accessTokenCiphertext" BYTEA NOT NULL,
    "accessTokenIv" BYTEA NOT NULL,
    "itemId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "institutionName" TEXT NOT NULL,
    "status" "PlaidItemStatus" NOT NULL DEFAULT 'active',
    "errorCode" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plaid_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_accounts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plaidItemId" TEXT,
    "plaidAccountId" TEXT,
    "name" TEXT NOT NULL,
    "officialName" TEXT,
    "mask" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "balanceCurrent" DECIMAL(14,2),
    "balanceAvailable" DECIMAL(14,2),
    "balanceLimit" DECIMAL(14,2),
    "lastBalanceSyncAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "plaidItemId" TEXT,
    "plaidTransactionId" TEXT,
    "plaidPendingTransactionId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "merchantRaw" TEXT NOT NULL,
    "merchantNormalized" TEXT,
    "categoryId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "postedAt" TIMESTAMP(3),
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "source" "TransactionSource" NOT NULL DEFAULT 'plaid',
    "rawData" JSONB NOT NULL,
    "note" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "icon" TEXT,
    "color" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plaid_items_itemId_key" ON "plaid_items"("itemId");

-- CreateIndex
CREATE INDEX "plaid_items_workspaceId_idx" ON "plaid_items"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_accounts_plaidAccountId_key" ON "bank_accounts"("plaidAccountId");

-- CreateIndex
CREATE INDEX "bank_accounts_workspaceId_plaidItemId_idx" ON "bank_accounts"("workspaceId", "plaidItemId");

-- CreateIndex
CREATE INDEX "transactions_workspaceId_occurredAt_idx" ON "transactions"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_workspaceId_accountId_occurredAt_idx" ON "transactions"("workspaceId", "accountId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "transactions_workspaceId_categoryId_idx" ON "transactions"("workspaceId", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "categories_workspaceId_name_key" ON "categories"("workspaceId", "name");

-- AddForeignKey
ALTER TABLE "plaid_items" ADD CONSTRAINT "plaid_items_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "plaid_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "bank_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "plaid_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial indexes — Prisma can't model these in schema.prisma.
-- 1) UNIQUE: dedupe Plaid transactions per workspace; manual transactions
--    have NULL plaidTransactionId so a single full UNIQUE doesn't work.
-- 2) Non-unique: support the categorize plan's "uncategorized list" daily
--    UX query without forcing a future migration.
CREATE UNIQUE INDEX "transactions_one_per_plaid_id_per_workspace"
  ON "transactions" ("workspaceId", "plaidTransactionId")
  WHERE "plaidTransactionId" IS NOT NULL;

CREATE INDEX "transactions_uncategorized"
  ON "transactions" ("workspaceId", "occurredAt" DESC)
  WHERE "categoryId" IS NULL AND "removedAt" IS NULL;
