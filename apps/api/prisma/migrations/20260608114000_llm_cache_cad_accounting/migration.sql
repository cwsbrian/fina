ALTER TABLE "llm_call_logs"
  ADD COLUMN "inputCacheHitTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inputCacheMissTokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "costCad" DECIMAL(10, 6) NOT NULL DEFAULT 0,
  ADD COLUMN "usdToCadRate" DECIMAL(10, 6) NOT NULL DEFAULT 1.4;

UPDATE "llm_call_logs"
SET
  "inputCacheMissTokens" = "inputTokens",
  "costCad" = ROUND(("costUsd" * 1.4)::numeric, 6),
  "usdToCadRate" = 1.4;
