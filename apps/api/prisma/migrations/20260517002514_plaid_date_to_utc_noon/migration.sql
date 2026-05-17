-- Plan 1E-time: Plaid date-only transactions historically stored as UTC
-- midnight. Shift to UTC noon so user-tz day-boundary filters classify
-- correctly.
--
-- Gate logic mirrors the sync.ts fallback chain so real ISO Plaid timestamps
-- that happen to land at 00:00:00Z are NOT touched.
--   plaidOccurredAt prefers authorized_datetime > authorized_date > datetime > date
--   plaidPostedAt   prefers datetime > date
-- A row's stored timestamp came from a date-only Plaid field iff the first
-- non-null field in its chain is `authorized_date` or `date`. The earlier-ISO
-- precedence is encoded literally: skip when `authorized_datetime` is present
-- (occurredAt) or `datetime` is present (postedAt). Then accept either the
-- second-slot date-only (authorized_date) OR the full fall-through to `date`.
-- The trailing EXTRACT(HOUR/MINUTE/SECOND ...)=0 clauses make the migration
-- idempotent (a row already at 12:00 no longer matches).

UPDATE "transactions"
SET "occurredAt" = "occurredAt" + INTERVAL '12 hours'
WHERE "source" = 'plaid'
  AND ("rawData" ->> 'authorized_datetime') IS NULL
  AND (
    ("rawData" ->> 'authorized_date') IS NOT NULL
    OR (
          ("rawData" ->> 'authorized_date') IS NULL
      AND ("rawData" ->> 'datetime')        IS NULL
      AND ("rawData" ->> 'date')            IS NOT NULL
    )
  )
  AND EXTRACT(HOUR   FROM "occurredAt") = 0
  AND EXTRACT(MINUTE FROM "occurredAt") = 0
  AND EXTRACT(SECOND FROM "occurredAt") = 0;

UPDATE "transactions"
SET "postedAt" = "postedAt" + INTERVAL '12 hours'
WHERE "source" = 'plaid'
  AND "postedAt" IS NOT NULL
  AND ("rawData" ->> 'datetime') IS NULL
  AND ("rawData" ->> 'date')     IS NOT NULL
  AND EXTRACT(HOUR   FROM "postedAt") = 0
  AND EXTRACT(MINUTE FROM "postedAt") = 0
  AND EXTRACT(SECOND FROM "postedAt") = 0;
