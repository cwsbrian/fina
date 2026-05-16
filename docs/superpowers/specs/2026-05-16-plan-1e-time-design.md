# Plan 1E-time — Plaid date anchor + user-timezone correctness

**Date:** 2026-05-16
**Status:** Spec
**Sub-plan of:** 1E (chat assistant)

---

## 1. Goal

Fix user-timezone correctness in the transaction APIs end-to-end:

1. **Sync layer:** Plaid date-only values land at UTC noon (not UTC midnight)
   so user-tz day-boundary filters classify them into the intended local day.
2. **Backfill:** existing date-only-origin Plaid rows shift forward 12 hours
   via a single migration. The migration gate uses `rawData` JSONB so real
   ISO Plaid timestamps that happen to land at `00:00:00Z` are not touched.
3. **Query layer:** the two oldest chat tools, `listTransactions` and
   `getSpendingSummary`, currently compute period bounds with server-local
   `new Date(y, m, d)` and bypass `periods.ts`. Migrate them onto the shared
   user-tz-aware helpers, and use `dateKeyInTz` for `getSpendingSummary`'s
   per-day bucket key.

No schema changes. The other 12 chat tools already route through `periods.ts`
and inherit the fix without modification.

---

## 2. Background

Plaid `transactions/sync` returns each transaction with two kinds of timing fields:

- **Date-only** strings (always present): `date`, `authorized_date` — `"2026-05-01"`.
- **ISO timestamps** (sometimes present, e.g. card swipes): `datetime`, `authorized_datetime` — `"2026-05-01T14:30:00-04:00"`.

Today, `apps/api/src/plaid/sync.ts`'s `plaidOccurredAt` / `plaidPostedAt` do
`new Date(v)` on whichever field it chooses (preferring `authorized_datetime`
first). For an ISO timestamp this is correct. For a **date-only** string,
`new Date("2026-05-01")` is parsed as **UTC midnight** (`2026-05-01T00:00:00.000Z`).

The user-timezone-aware period helpers in `apps/api/src/chat/tools/periods.ts`
compute UTC instants that correspond to the user's **local** midnight boundary.
For `America/Toronto` (UTC-4 DST), May 1 local midnight = `2026-05-01T04:00:00Z`.

Result: a Plaid transaction with `date = "2026-05-01"` is stored at `00:00Z`
which is **April 30, 8:00 PM local** in Toronto. A `this_month` (May) filter
running `gte: 2026-05-01T04:00:00Z` **excludes** it, mis-binning it to April.

This affects every chat tool that uses `basicPeriodRange`, `reviewPeriodRange`,
`comparisonRanges`, `lookbackMonthStart`, or `dateKeyInTz` — i.e.
findUncategorizedTransactions, getCategoryBreakdown, compareSpendingPeriods,
detectRecurringMerchants, getCashflowSummary, findTransactions, and the
review-period read tools.

Separately, two chat tools never adopted `periods.ts` at all and still rely on
server-local `new Date(y, m, d)` math — `listTransactions` and
`getSpendingSummary`. For these the user-tz bug exists on a second axis: even
if the storage anchor were perfect, the period boundary itself is computed
against the **server's** wall clock instead of the user's. Both tools must
migrate onto the shared helpers; `getSpendingSummary` additionally uses
`occurredAt.toISOString().slice(0, 10)` for its day-bucket key, which renders
in UTC — replace with `dateKeyInTz`.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| Storage anchor for Plaid date-only | UTC noon (`2026-05-01T12:00:00.000Z`) |
| Schema | No new columns. No DDL. |
| Existing data | Backfill in a single Prisma migration |
| Backfill gate | `source='plaid'` AND `rawData` JSONB indicates the chosen field was date-only (mirrors the sync fallback chain), AND `occurredAt`/`postedAt` time component = `00:00:00` (defensive idempotence) |
| Plaid ISO timestamps (with `T`) | Trust as-is, no shift |
| `listTransactions` and `getSpendingSummary` | Migrate onto `periods.ts` (today/this_week/this_month/last_month) and `dateKeyInTz` |
| Add `"today"` to `BasicPeriod` | Yes — extend `periods.ts` to handle it via `localMidnightToUtc(y, m, d) … addDaysLocal(+1)` |
| Workspace-level tz | Out of scope — `User.tz` stays per-user |
| Plaid `datetime` always preferred | Out of scope — keep current fallback chain |
| Web list route `/transactions` `from`/`to` query parsing | Out of scope — UI concern |
| UTC±12 and beyond | Known limitation, not addressed |

---

## 4. Architecture

Three coordinated changes:

**(a) Sync anchor.** A single helper, `parsePlaidInstant(s: string): Date`,
encapsulates the policy:

- Input contains `T` → ISO 8601 with time component → `new Date(s)` (unchanged).
- Input is pure date-only (`"YYYY-MM-DD"`) → `new Date(\`${s}T12:00:00.000Z\`)`.

Both `plaidOccurredAt` and `plaidPostedAt` route through it.

**(b) Migration.** A Prisma migration shifts pre-existing Plaid rows whose
stored timestamp came from a date-only Plaid field. The gate uses `rawData`
JSONB to mirror the sync fallback chain — only rows where the chosen Plaid
field was actually `date` or `authorized_date` (not `datetime` or
`authorized_datetime`) are eligible. A defensive `time = 00:00:00` predicate
makes the migration idempotent on rerun.

**(c) Query layer.** `listTransactions` and `getSpendingSummary` migrate to
`periods.ts`:

- Add `"today"` to `BasicPeriod`; extend `basicPeriodRange` to handle it.
- Both tools call `basicPeriodRange(userId, period)` instead of local `periodRange()`.
- `getSpendingSummary`'s day-bucket key replaces
  `r.occurredAt.toISOString().slice(0, 10)` with `dateKeyInTz(r.occurredAt, tz)`,
  using the user's resolved timezone.

After these changes, every transaction-querying code path is timezone-aware:

- All 14 chat tools (via `periods.ts` helpers).
- The web list route `GET /workspaces/:id/transactions` consumes UI-supplied
  date strings unchanged — it is the UI's responsibility to format them. Out
  of scope.
- The categorize backfill uses `occurredAt` for sibling match only (no period
  filtering).

---

## 5. Known limitation: far-east and far-west zones

A fixed UTC-noon anchor preserves the intended local date only for zones in
the half-open interval `(UTC-12, UTC+12)` — i.e. UTC-11 through UTC+11
inclusive. At and beyond ±12 hours, `12:00 UTC` already crosses into the
neighboring local day:

- **UTC+12 (e.g. Pacific/Auckland NZST):** `2026-05-01T12:00Z` =
  `2026-05-02T00:00 local`. A Plaid `date = "2026-05-01"` is read as May 2.
- **UTC+13 / UTC+14 (NZDT, Kiribati Line Islands):** worse — `12:00 UTC` is
  already 1 AM / 2 AM the next local day.
- **UTC-12 (Baker Island, uninhabited):** symmetric problem on the other side.

Mitigation: not applied. Real-world Fina user base is in Canada (default
`America/Toronto`, UTC-4/-5). If a Pacific user ever lands, a follow-up plan
can switch the anchor to a user-tz-derived local-noon (requires `User.tz`
lookup at sync time, which today's sync does not do).

---

## 6. File location

- **Modify** `apps/api/src/plaid/sync.ts` — extract `parsePlaidInstant`; route
  `plaidOccurredAt` + `plaidPostedAt` through it.
- **Modify** `apps/api/src/chat/tools/periods.ts` — extend `BasicPeriod` with
  `"today"`; extend `basicPeriodRange` to handle it.
- **Modify** `apps/api/src/chat/tools/list-transactions.ts` — drop local
  `periodRange()`; use `basicPeriodRange(userId, period)`. `ToolDef.run`
  receives `userId` via `ctx`.
- **Modify** `apps/api/src/chat/tools/get-spending-summary.ts` — drop local
  `periodRange()`; use `basicPeriodRange(userId, period)`; replace day-bucket
  key with `dateKeyInTz(r.occurredAt, tz)` where `tz = await resolveUserTz(userId)`.
- **Create** `apps/api/prisma/migrations/<timestamp>_plaid_date_to_utc_noon/migration.sql`
  — backfill UPDATEs gated by `rawData` JSONB.
- **Create** `apps/api/tests/plaid.sync.date-anchor.test.ts` — unit tests for
  `parsePlaidInstant`, `plaidOccurredAt`, `plaidPostedAt`.
- **Create** `apps/api/tests/chat.tools.tz-anchor.test.ts` — integration:
  Plaid `"2026-05-01"` + Toronto user + `this_month` filter on
  `listTransactions` and `getSpendingSummary` → 1 hit each, day-bucket key
  reads `2026-05-01` (not `2026-04-30` which would result if grouping in UTC).
- **Modify** `apps/api/tests/chat.tools.list-transactions.test.ts` and
  `apps/api/tests/chat.tools.get-spending-summary.test.ts` — adjust any
  assertions that hardcoded server-local boundaries.

No file is renamed; no existing test is deleted. Existing tests that hardcode
UTC midnight assertions on Plaid date input get adjusted to UTC noon.

---

## 7. Sync code

In `apps/api/src/plaid/sync.ts`:

```typescript
// Exported for unit testing. Anchors date-only Plaid input at UTC noon so
// user-timezone day-boundary filters classify the row into the intended
// local day across UTC-12..+13 zones. ISO-8601 inputs with a time component
// (e.g. authorized_datetime) are trusted as-is.
export function parsePlaidInstant(s: string): Date {
  if (s.includes("T")) return new Date(s);
  return new Date(`${s}T12:00:00.000Z`);
}

export function plaidOccurredAt(t: PlaidTxLike): Date {
  const v = t.authorized_datetime ?? t.authorized_date ?? t.datetime ?? t.date;
  if (!v) throw new Error(`Plaid transaction ${t.transaction_id} has no date field`);
  return parsePlaidInstant(v);
}

export function plaidPostedAt(t: PlaidTxLike): Date | null {
  if (t.pending) return null;
  const v = t.datetime ?? t.date;
  return parsePlaidInstant(v);
}
```

Rationale for the `T` check: ISO 8601 always uses `T` between date and time. A
length check would be fragile (timezone offsets vary in length). `T` is
unambiguous.

---

## 8. Migration

`apps/api/prisma/migrations/<timestamp>_plaid_date_to_utc_noon/migration.sql`:

```sql
-- Plan 1E-time: Plaid date-only transactions historically stored as UTC
-- midnight. Shift to UTC noon so user-tz day-boundary filters classify
-- correctly.
--
-- Gate logic mirrors the sync.ts fallback chain so real ISO Plaid timestamps
-- that happen to land at 00:00:00Z are NOT touched:
--   plaidOccurredAt prefers authorized_datetime > authorized_date > datetime > date
--   plaidPostedAt   prefers datetime > date
-- A row's stored timestamp came from a date-only Plaid field iff the first
-- non-null field in its chain is `authorized_date` or `date`. The earlier-ISO
-- precedence is encoded literally: skip when `authorized_datetime` is present
-- (occurredAt) or `datetime` is present (postedAt). Then accept either the
-- second-slot date-only (authorized_date) OR the full fall-through to `date`.
-- The trailing `EXTRACT(HOUR/MINUTE/SECOND ...)=0` clauses make the migration
-- idempotent (a row already shifted to 12:00 no longer matches).

UPDATE "transactions"
SET "occurredAt" = "occurredAt" + INTERVAL '12 hours'
WHERE "source" = 'plaid'
  AND ("rawData" ->> 'authorized_datetime') IS NULL
  AND (
    -- Case A: chain falls to authorized_date (date-only) on the second slot.
    ("rawData" ->> 'authorized_date') IS NOT NULL
    -- Case B: chain falls through to datetime (ISO, skip) — handled by NOT.
    -- Case C: chain falls all the way through to date (date-only).
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
```

The two UPDATEs run in the migration's implicit transaction; if one fails the
other is rolled back. `rawData` is non-null (the column is `Json`, not
`Json?`), so the JSONB `->>` extractors return `NULL` for absent keys and the
gate behaves correctly.

No automated test asserts the migration result (decided during brainstorm).
The smoke section (Plan execution) includes a manual before/after psql check.

---

## 9. Tests

### 9.1 `apps/api/tests/plaid.sync.date-anchor.test.ts` (new)

```typescript
import { describe, it, expect } from "vitest";
import { parsePlaidInstant, plaidOccurredAt, plaidPostedAt } from "../src/plaid/sync.js";

describe("parsePlaidInstant", () => {
  it("anchors a date-only string at UTC noon", () => {
    expect(parsePlaidInstant("2026-05-01").toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("trusts an ISO timestamp with timezone offset", () => {
    expect(parsePlaidInstant("2026-05-01T14:30:00-04:00").toISOString())
      .toBe("2026-05-01T18:30:00.000Z");
  });

  it("trusts an ISO timestamp with UTC suffix", () => {
    expect(parsePlaidInstant("2026-05-01T00:00:00Z").toISOString())
      .toBe("2026-05-01T00:00:00.000Z");
  });
});

describe("plaidOccurredAt", () => {
  const base = { transaction_id: "tx-1", account_id: "a1", amount: 10, pending: false };

  it("uses authorized_datetime when present (ISO)", () => {
    expect(plaidOccurredAt({ ...base, authorized_datetime: "2026-05-01T14:30:00-04:00", date: "2026-05-01" }).toISOString())
      .toBe("2026-05-01T18:30:00.000Z");
  });

  it("falls back to authorized_date date-only → UTC noon", () => {
    expect(plaidOccurredAt({ ...base, authorized_date: "2026-05-01", date: "2026-04-30" }).toISOString())
      .toBe("2026-05-01T12:00:00.000Z");
  });

  it("falls back to date date-only → UTC noon", () => {
    expect(plaidOccurredAt({ ...base, date: "2026-05-01" }).toISOString())
      .toBe("2026-05-01T12:00:00.000Z");
  });
});

describe("plaidPostedAt", () => {
  const base = { transaction_id: "tx-1", account_id: "a1", amount: 10, date: "2026-05-01" };

  it("returns null for pending", () => {
    expect(plaidPostedAt({ ...base, pending: true })).toBeNull();
  });

  it("anchors date-only at UTC noon when posted", () => {
    expect(plaidPostedAt({ ...base, pending: false })!.toISOString())
      .toBe("2026-05-01T12:00:00.000Z");
  });
});
```

### 9.2 `apps/api/tests/chat.tools.tz-anchor.test.ts` (new)

Integration: exercise both fixes (storage anchor AND query-layer migration)
on Toronto-boundary rows whose classification differs between server-local
and user-tz reasoning.

**Test process timezone is pinned to UTC** via `process.env.TZ = "UTC"` at the
top of the file (read by Node's `Date` constructor before the first
instantiation in the file). Without this pin, the pre-fix `new Date(y, m, d)`
math would interpret in the host's local zone (e.g. America/Vancouver on the
dev machine) and the test could accidentally pass under the old
implementation. Pinning to UTC makes the pre-fix server-local boundary
exactly `[Apr 1 00:00Z, May 1 00:00Z)` for April — predictable across CI
hosts. The seed uses a row at `2026-05-01T02:00Z`, which is **April 30 22:00
local Toronto** — server-UTC says May, user-tz Toronto says April. The test
pins "now" to mid-April so a `this_month` query asks for April. A correct
user-tz implementation includes it; the pre-fix server-local math (under
TZ=UTC) excluded it.

```typescript
// Pin BEFORE any Date() call in this module — Node reads TZ once per
// Date construction; setting it here makes server-local math deterministic
// across CI hosts (which may run in any zone).
process.env.TZ = "UTC";

import { describe, it, expect, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listTransactions } from "../src/chat/tools/list-transactions.js";
import { getSpendingSummary } from "../src/chat/tools/get-spending-summary.js";
// Test helpers per existing chat.tools.list-transactions.test.ts pattern:
// create user (tz='America/Toronto'), workspace, owner membership, account.

describe("[plan 1e-time] tz anchor + tool migration", () => {
  it("listTransactions: rows at the Toronto/UTC day boundary classify by user-tz", async () => {
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    // Seed two transactions:
    //   A. occurredAt = 2026-05-01T02:00:00Z = Apr 30 22:00 local Toronto
    //   B. occurredAt = 2026-04-01T03:00:00Z = Mar 31 23:00 local Toronto
    // A is locally April (in-range for this_month=April).
    // B is locally March (out-of-range).
    // Pre-fix server-local periodRange (Apr 1 00:00 UTC .. May 1 00:00 UTC)
    // would have EXCLUDED A and INCLUDED B — exactly the wrong way around.

    const result = await listTransactions.run(
      { env, workspaceId, userId, role: "owner" },
      { period: "this_month", limit: 50 },
    );
    const ids = result.transactions.map((t) => t.id);
    expect(ids).toContain("tx-A");
    expect(ids).not.toContain("tx-B");
  });

  it("getSpendingSummary: day-bucket key renders in user tz, not UTC", async () => {
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    // Seed one transaction:
    //   occurredAt = 2026-05-01T02:00:00Z = Apr 30 22:00 local Toronto
    // dateKeyInTz returns "2026-04-30".
    // toISOString().slice(0, 10) (pre-fix) returns "2026-05-01" — wrong day.

    const result = await getSpendingSummary.run(
      { env, workspaceId, userId, role: "owner" },
      { period: "this_month", group_by: "day" },
    );
    expect(result.groups.length).toBe(1);
    expect(result.groups[0]!.key).toBe("2026-04-30");
  });

  it("listTransactions: 'today' period uses user-tz day boundary", async () => {
    // Pin "now" to 2026-05-02T03:00:00Z = May 1 23:00 local Toronto.
    // 'today' in Toronto = May 1.
    vi.setSystemTime(new Date("2026-05-02T03:00:00Z"));
    // Seed:
    //   occurredAt = 2026-05-01T15:00:00Z = May 1 11:00 local — in range.
    //   occurredAt = 2026-05-02T05:00:00Z = May 2 01:00 local — out of range.

    const result = await listTransactions.run(
      { env, workspaceId, userId, role: "owner" },
      { period: "today", limit: 50 },
    );
    expect(result.transactions.map((t) => t.id)).toEqual(["tx-today"]);
  });
});
```

The first two cases fail under the **pre-fix** implementation (server-local
`periodRange` includes the wrong rows; UTC day-key produces `2026-05-01`),
proving the tool migration is wired correctly. The third case exercises the
new `today` entry in `BasicPeriod`.

### 9.3 Existing test adjustments

A short search:

```bash
grep -rn "2026-..-..T00:00:00" apps/api/tests/ | grep -i plaid
```

For each match: if the test sets up Plaid input as a date-only string and then
asserts UTC midnight on `occurredAt` / `postedAt`, change the assertion to UTC
noon. Tests that simulate an explicit ISO timestamp input remain unchanged.

---

## 10. Acceptance criteria

This plan is complete when:

- `parsePlaidInstant` exists, exported, and the two existing helpers route
  through it.
- `periods.ts` `BasicPeriod` includes `"today"`; `basicPeriodRange` handles it
  via local-midnight + `addDaysLocal(+1)`.
- `listTransactions` and `getSpendingSummary` no longer define local
  `periodRange()` helpers; both call `basicPeriodRange(userId, period)`.
- `getSpendingSummary`'s day-bucket key uses `dateKeyInTz`, not
  `toISOString().slice(0, 10)`.
- New unit test file 9.1 passes (10 cases).
- New integration test file 9.2 passes (2+ cases, one per migrated tool).
- Migration `<timestamp>_plaid_date_to_utc_noon` applied on dev DB:
  - `occurredAt` shifts +12h for every `source='plaid'` row whose chosen
    Plaid field (per the fallback chain `authorized_datetime > authorized_date
    > datetime > date`) is the date-only `authorized_date` or `date`,
    AND whose stored time is `00:00:00`. Concretely: any row with
    `rawData.authorized_date` non-null and `rawData.authorized_datetime` null
    is in scope, regardless of whether `rawData.datetime` is also present.
  - `occurredAt` is unchanged when `rawData.authorized_datetime` is non-null
    (chosen-ISO case), or when the chain falls through to `datetime`
    (`authorized_date` null and `datetime` non-null) — again regardless of
    the stored time value.
  - `postedAt` shifts +12h when `rawData.datetime` is null and `rawData.date`
    is non-null and `postedAt` is `00:00:00`; unchanged otherwise.
- All 60+ existing API test files still pass (502+ tests).
- The smoke doc (Section 11) records a manual before/after row check.

---

## 11. Smoke / manual verification

Document in the plan (not the spec). Outline:

1. Capture pre-migration state of in-scope rows (mirroring the migration's
   `occurredAt` gate):
   ```sql
   SELECT COUNT(*) FROM transactions
   WHERE source='plaid'
     AND ("rawData"->>'authorized_datetime') IS NULL
     AND (
       ("rawData"->>'authorized_date') IS NOT NULL
       OR (
             ("rawData"->>'authorized_date') IS NULL
         AND ("rawData"->>'datetime')        IS NULL
         AND ("rawData"->>'date')            IS NOT NULL
       )
     )
     AND EXTRACT(HOUR FROM "occurredAt")=0
     AND EXTRACT(MINUTE FROM "occurredAt")=0
     AND EXTRACT(SECOND FROM "occurredAt")=0;
   ```
   Also capture counts that MUST remain unchanged: rows with
   `rawData.authorized_datetime` non-null at `00:00:00Z`, AND rows where the
   chain falls through to ISO `datetime` (`authorized_datetime` and
   `authorized_date` both null, `datetime` non-null) at `00:00:00Z`.
2. Apply migration.
3. Post-migration: rerun the in-scope query → expect count drop to 0. Rerun
   the must-not-change counts → expect unchanged.
4. Run one chat turn: "이번 달 May 1일 거래 보여줘" with a Toronto user →
   expect the May 1 Plaid row to appear.

---

## 12. Excluded scope

The following are explicitly NOT in this plan:

- New columns (e.g. `occurredOn DATE`) or schema changes.
- Plaid `datetime` always preferred over `date` (current fallback chain stays).
- Web list route `/workspaces/:id/transactions` query parameter parsing for
  `from`/`to` (UI concern; user is iterating on UI separately).
- Per-workspace timezone (User.tz remains per-user).
- Far-east and far-west zone correction (UTC±12 and beyond — see §5).
- Auto thread title (separate follow-up plan).
- Backfill verification automated test (smoke check only).

---

## 13. Follow-up candidates

- **Plan 1E-title:** Auto-generated chat thread titles from first user message
  (1E-threads follow-up; user-flagged immediately after this plan).
- **Plan UI-tz-input:** Web frontend timezone-aware date input parsing for
  `/transactions` list filters.
- **Plan workspace-tz:** Per-workspace timezone (when multi-national member
  workspaces appear).
- **Plan plaid-datetime-preferred:** Always prefer Plaid `datetime` over
  `date` when both are present (current fallback only kicks in for missing
  `authorized_*` fields; this would re-order the preference chain).
