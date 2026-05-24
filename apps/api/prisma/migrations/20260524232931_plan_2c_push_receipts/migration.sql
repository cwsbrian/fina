-- CreateTable
CREATE TABLE "push_tickets" (
    "id" TEXT NOT NULL,
    "expoTicketId" TEXT NOT NULL,
    "userDeviceId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "polledAt" TIMESTAMP(3),
    "status" TEXT,
    "errorCode" TEXT,

    CONSTRAINT "push_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_tickets_expoTicketId_key" ON "push_tickets"("expoTicketId");

-- CreateIndex
CREATE INDEX "push_tickets_polledAt_sentAt_idx" ON "push_tickets"("polledAt", "sentAt");

-- AddForeignKey
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_userDeviceId_fkey" FOREIGN KEY ("userDeviceId") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
