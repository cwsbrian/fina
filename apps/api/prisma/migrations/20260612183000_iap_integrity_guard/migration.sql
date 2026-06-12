ALTER TABLE "users" ADD COLUMN "isPlanMismatch" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "user_devices"
  ADD COLUMN "clientDeviceId" TEXT,
  ADD COLUMN "lastIapIntegrityCheckedAt" TIMESTAMP(3),
  ADD COLUMN "lastIapIntegrityResult" TEXT,
  ADD COLUMN "lastIapIntegritySubscriptionUpdatedAt" TIMESTAMP(3),
  ALTER COLUMN "expoPushToken" DROP NOT NULL;

CREATE UNIQUE INDEX "user_devices_userId_clientDeviceId_key"
  ON "user_devices"("userId", "clientDeviceId");
