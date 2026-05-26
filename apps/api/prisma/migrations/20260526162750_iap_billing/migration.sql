-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'Production';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "iapAppleAccountToken" TEXT,
ADD COLUMN     "iapGoogleObfuscatedId" TEXT;

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "body" JSONB;

-- CreateTable
CREATE TABLE "iap_deleted_bindings" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userIdHash" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iap_deleted_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "iap_retry_counters" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iap_retry_counters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "iap_deleted_bindings_source_idx" ON "iap_deleted_bindings"("source");

-- CreateIndex
CREATE UNIQUE INDEX "iap_deleted_bindings_source_tokenHash_key" ON "iap_deleted_bindings"("source", "tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "iap_retry_counters_source_tokenHash_key" ON "iap_retry_counters"("source", "tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "users_iapAppleAccountToken_key" ON "users"("iapAppleAccountToken");

-- CreateIndex
CREATE UNIQUE INDEX "users_iapGoogleObfuscatedId_key" ON "users"("iapGoogleObfuscatedId");

