# Plan 1E-time — Plaid date anchor + user-timezone correctness

**Date:** 2026-05-16
**Status:** Spec
**Sub-plan of:** 1E (chat assistant)

---

## 1. Goal

Fix the Plaid date-only storage policy so user-timezone period filters classify
transactions into their intended local day. Backfill existing rows in a single
migration. No schema changes; no per-tool code changes — the fix is concentrated
in the sync layer and inherited by every downstream consumer.

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
`comparisonRanges`, `lookbackMonthStart`, and `dateKeyInTz` — i.e. all of
listTransactions, getSpendingSummary, getCategoryBreakdown,
compareSpendingPeriods, detectRecurringMerchants, getCashflowSummary,
findTransactions, findUncategorizedTransactions.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| Storage anchor for Plaid date-only | UTC noon (`2026-05-01T12:00:00.000Z`) |
| Schema | No new columns. No DDL. |
| Existing data | Backfill in a single Prisma migration |
| Backfill heuristic | `source='plaid' AND time component = 00:00:00 UTC` |
| Plaid ISO timestamps (with `T`) | Trust as-is, no shift |
| Workspace-level tz | Out of scope — `User.tz` stays per-user |
| Plaid `datetime` always preferred | Out of scope — keep current fallback chain |
| Web list route `/transactions` `from`/`to` query parsing | Out of scope — UI concern |
| UTC+14 zones (Kiribati Line Islands) | Known limitation, not addressed |

---

## 4. Architecture

A single helper, `parsePlaidInstant(s: string): Date`, encapsulates the policy:

- Input contains `T` → ISO 8601 with time component → `new Date(s)` (unchanged).
- Input is pure date-only (`"YYYY-MM-DD"`) → `new Date(\`${s}T12:00:00.000Z\`)`.

Both `plaidOccurredAt` and `plaidPostedAt` route through it. Every existing
transaction-querying code path inherits the fix without modification:

- All 14 chat tools (via `periods.ts` helpers).
- The web list route `GET /workspaces/:id/transactions` (uses raw `occurredAt`).
- The categorize backfill (uses `occurredAt` for sibling match).

A one-step Prisma migration shifts pre-existing Plaid rows by `INTERVAL '12 hours'`,
gated on `source='plaid'` + zero time component (= came from date-only path).
The shift is idempotent on rerun (a row at `12:00` no longer matches the
`HOUR = 0` predicate).

---

## 5. Known limitation: UTC+14 zones

UTC noon is safe for all zones in `[UTC-12, UTC+13]`. For UTC+14 (Kiribati Line
Islands, Christmas Island) and certain DST-shifted Pacific zones, a date-only
Plaid transaction may be classified one local day later than intended.

Mitigation: not applied. Real-world Fina user base is in Canada (default
`America/Toronto`). If a UTC+14 user ever lands, a follow-up plan can switch
the anchor to a user-tz-derived local-noon (requires `User.tz` lookup at sync
time, which today's sync does not do).

---

## 6. File location

- **Modify** `apps/api/src/plaid/sync.ts` — extract `parsePlaidInstant`; route
  `plaidOccurredAt` + `plaidPostedAt` through it.
- **Create** `apps/api/prisma/migrations/<timestamp>_plaid_date_to_utc_noon/migration.sql`
  — backfill UPDATE.
- **Create** `apps/api/tests/plaid.sync.date-anchor.test.ts` — unit tests for
  `parsePlaidInstant`, `plaidOccurredAt`, `plaidPostedAt`.
- **Create** `apps/api/tests/chat.tools.tz-anchor.test.ts` — integration:
  Plaid `"2026-05-01"` + Toronto user + `this_month` filter → 1 hit.

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
-- correctly. Heuristic: source='plaid' AND occurredAt has no time component
-- (= came from a date-only Plaid field). Idempotent on rerun.

UPDATE "transactions"
SET "occurredAt" = "occurredAt" + INTERVAL '12 hours'
WHERE "source" = 'plaid'
  AND EXTRACT(HOUR   FROM "occurredAt") = 0
  AND EXTRACT(MINUTE FROM "occurredAt") = 0
  AND EXTRACT(SECOND FROM "occurredAt") = 0;

UPDATE "transactions"
SET "postedAt" = "postedAt" + INTERVAL '12 hours'
WHERE "source" = 'plaid'
  AND "postedAt" IS NOT NULL
  AND EXTRACT(HOUR   FROM "postedAt") = 0
  AND EXTRACT(MINUTE FROM "postedAt") = 0
  AND EXTRACT(SECOND FROM "postedAt") = 0;
```

The two UPDATEs run in the migration's implicit transaction; if one fails the
other is rolled back. `postedAt` is nullable; the `IS NOT NULL` guard is for
clarity (Postgres would skip nulls in the EXTRACT predicate regardless).

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

Integration: prove a Plaid date-only `"2026-05-01"` transaction is included
in a Toronto user's `this_month=May 2026` filter, which the pre-fix storage
would have mis-classified into April.

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listTransactionsTool } from "../src/chat/tools/list-transactions.js";
// ...standard test helpers, see existing chat.tools.list-transactions.test.ts pattern

describe("[plan 1e-time] tz anchor", () => {
  // Seed a user with tz="America/Toronto", a workspace, an account, and
  // exactly one transaction with occurredAt = parsePlaidInstant("2026-05-01")
  // = 2026-05-01T12:00:00Z. Pin "now" to mid-May 2026 so this_month means May.

  it("includes a May 1 Plaid transaction in this_month for Toronto user", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    // ...seed user (tz=America/Toronto), workspace, account, transaction
    // at occurredAt=2026-05-01T12:00:00Z

    const result = await listTransactionsTool.run(
      { env, workspaceId, userId, role: "owner" },
      { period: "this_month", limit: 50 },
    );
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0]!.occurredAt).toBe("2026-05-01T12:00:00.000Z");
  });
});
```

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
- New unit test file 9.1 passes (10 cases).
- New integration test file 9.2 passes (1 case).
- Migration `<timestamp>_plaid_date_to_utc_noon` applied on dev DB:
  - All `source='plaid'` rows that had time `00:00:00` now have `12:00:00`.
  - Other rows unchanged.
- All 60+ existing API test files still pass (502+ tests).
- The smoke doc (Section 11) records a manual before/after row check.

---

## 11. Smoke / manual verification

Document in the plan (not the spec). Outline:

1. Capture pre-migration row state: `SELECT COUNT(*), MIN("occurredAt"), MAX("occurredAt") FROM transactions WHERE source='plaid' AND EXTRACT(HOUR FROM "occurredAt")=0;`
2. Apply migration.
3. Capture post-migration: same query → expect count drop to 0.
4. Run one chat turn: "이번 달 May 1일 거래 보여줘" with a Toronto user → expect the May 1 Plaid row to appear.

---

## 12. Excluded scope

The following are explicitly NOT in this plan:

- New columns (e.g. `occurredOn DATE`) or schema changes.
- Plaid `datetime` always preferred over `date` (current fallback chain stays).
- Web list route `/workspaces/:id/transactions` query parameter parsing for
  `from`/`to` (UI concern; user is iterating on UI separately).
- Per-workspace timezone (User.tz remains per-user).
- UTC+14 Pacific zone correction.
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
