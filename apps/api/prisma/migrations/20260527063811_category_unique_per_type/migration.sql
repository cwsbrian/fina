-- Widen the active-name uniqueness to also key on type, so "Other" can
-- exist independently as both expense and income (and any other name
-- the user wants to reuse across the two type buckets).

DROP INDEX IF EXISTS "categories_one_active_name_per_workspace_ci";

CREATE UNIQUE INDEX "categories_one_active_name_per_workspace_per_type_ci"
ON "categories" ("workspaceId", lower(name), "type")
WHERE "archivedAt" IS NULL;
