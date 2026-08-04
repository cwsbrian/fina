CREATE TYPE "SignupEnvironment" AS ENUM ('UNKNOWN', 'TEST', 'PRODUCTION');

ALTER TABLE "users"
  ADD COLUMN "signupEnvironment" "SignupEnvironment" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "signupPlatform" TEXT,
  ADD COLUMN "signupBuildNumber" TEXT,
  ADD COLUMN "appleStoreEnvironment" TEXT,
  ADD COLUMN "environmentVerifiedAt" TIMESTAMP(3);

-- Preserve existing production reporting while making the known App Review
-- account explicit. New users retain the safer UNKNOWN default until the app
-- submits an Apple-signed AppTransaction.
UPDATE "users"
SET "signupEnvironment" = 'PRODUCTION';

UPDATE "users"
SET "signupEnvironment" = 'TEST'
WHERE lower("email") = 'tester@test.com';

CREATE INDEX "users_signupEnvironment_idx" ON "users"("signupEnvironment");
