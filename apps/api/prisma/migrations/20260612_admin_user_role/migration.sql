CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

ALTER TABLE "users"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'user';
