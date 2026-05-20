CREATE TABLE "scheduled_spends" (
  "id"             TEXT PRIMARY KEY,
  "workspaceId"    TEXT NOT NULL,
  "categoryId"     TEXT NOT NULL,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "scheduledDate"  DATE NOT NULL,
  "note"           TEXT,
  "matchedTxId"    TEXT,
  "dismissedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scheduled_spends_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_spends_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_spends_matchedTxId_fkey"
    FOREIGN KEY ("matchedTxId") REFERENCES "transactions"("id") ON DELETE SET NULL
);

CREATE INDEX "scheduled_spends_workspaceId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "scheduledDate");
CREATE INDEX "scheduled_spends_workspaceId_categoryId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "categoryId", "scheduledDate");
CREATE INDEX "scheduled_spends_matchedTxId_idx"
  ON "scheduled_spends"("matchedTxId");
