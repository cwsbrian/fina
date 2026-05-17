-- CreateTable
CREATE TABLE "action_intents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_intents_workspaceId_userId_expiresAt_idx" ON "action_intents"("workspaceId", "userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "action_intents" ADD CONSTRAINT "action_intents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_intents" ADD CONSTRAINT "action_intents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
