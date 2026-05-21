-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused');

-- CreateEnum
CREATE TYPE "SubscriptionSource" AS ENUM ('stripe', 'iap_apple', 'iap_google');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "stripeCustomerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_stripeCustomerId_key" ON "users"("stripeCustomerId");

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "source" "SubscriptionSource" NOT NULL,
    "sourceSubscriptionId" TEXT NOT NULL,
    "sourceCustomerId" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "billingPeriod" TEXT NOT NULL DEFAULT 'monthly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_source_sourceSubscriptionId_key" ON "subscriptions"("source", "sourceSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_source_type_idx" ON "webhook_events"("source", "type");
