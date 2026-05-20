# Code Review: Plan 1E-next Implementation

Date: 2026-05-15

Reviewed worktree: `.claude/worktrees/plan-1e-next`

Reviewed branch: `worktree-plan-1e-next`

Reviewed head: `68c1702 fix(plan 1e-next): satisfy noUncheckedIndexedAccess in periods + detect-recurring-merchants`

Base branch: `main`

Reference documents:

- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md`
- `docs/superpowers/plans/2026-05-15-plan-1e-next.md`
- `docs/superpowers/plans/2026-05-15-plan-1e-next-review.md`

## Verdict

Do not merge as-is.

The seven new tools and their tests are broadly aligned with the final design spec, and the earlier review blockers were mostly fixed. However, the shared timezone helper still has one high-severity bug for valid IANA timezones far ahead of UTC.

Fix the timezone arithmetic issue before merging. After that, rerun the focused tool tests and the full API suite.

## Finding

### HIGH: Local-day arithmetic shifts dates for UTC+13/UTC+14 timezones

Location in implementation worktree:

- `.claude/worktrees/plan-1e-next/apps/api/src/chat/tools/periods.ts:95`
- `.claude/worktrees/plan-1e-next/apps/api/src/chat/tools/periods.ts:105`

The implementation uses a UTC-noon anchor, then converts that anchor back through `partsInTz()`:

```ts
const anchor = new Date(Date.UTC(year, month - 1, day - back, 12, 0, 0));
const p = partsInTz(anchor, tz);
return localMidnightToUtc(p.year, p.month, p.day, tz);
```

This works for `America/Toronto`, but it fails for valid IANA zones ahead of UTC by enough hours that UTC noon is already the next local calendar day.

Concrete reproducer:

```text
tz = Pacific/Auckland
now = 2026-03-10T12:00:00Z
local now = Wednesday 2026-03-11 01:00

Expected this_week.gte:
local Monday 2026-03-09 00:00
UTC 2026-03-08T11:00:00.000Z

Actual current code:
local Tuesday 2026-03-10 00:00
UTC 2026-03-09T11:00:00.000Z
```

Impact:

- `basicPeriodRange(..., "this_week")` can start on the wrong local day.
- `comparisonRanges(..., "previous_week")` can compare the wrong week.
- Every tool that uses `basicPeriodRange`, `reviewPeriodRange`, or `comparisonRanges` can include or exclude the wrong transactions for affected users.
- This is within the supported contract because `User.tz` accepts any valid IANA timezone and falls back only when invalid.

Recommended fix:

Perform local calendar-day overflow using UTC civil fields, but do not convert the overflow anchor through the target timezone before calling `localMidnightToUtc()`.

For `startOfWeek`:

```ts
function startOfWeek(year: number, month: number, day: number, weekday: number, tz: string): Date {
  const back = (weekday + 6) % 7;
  const civil = new Date(Date.UTC(year, month - 1, day - back));
  return localMidnightToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), tz);
}
```

For `addDaysLocal`:

```ts
function addDaysLocal(d: Date, n: number, tz: string): Date {
  const p = partsInTz(d, tz);
  const civil = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return localMidnightToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), tz);
}
```

Add regression tests for at least:

- `Pacific/Auckland` `this_week` starts on local Monday.
- `Pacific/Kiritimati` `this_week` starts on local Monday.
- Existing `America/Toronto` DST tests still pass.

## Positive Checks

The following prior review items appear resolved in the implementation:

- Corrected package-relative test command paths are used.
- `localMidnightToUtc()` now accounts for hour/minute/second and passes the Toronto boundary tests.
- `getCategoryBreakdown` applies `categoryId: { not: null }` before aggregation when `include_uncategorized === false`.
- `detectRecurringMerchants` reuses `lookbackMonthStart()`.
- `getCashflowSummary` uses `dateKeyInTz()` for day grouping.
- The seven new tools are registered in `REGISTRY`.
- Top-level Zod arg descriptions are covered by registry tests.

## Verification Run

Focused new tests:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts \
  tests/chat.tools.periods.test.ts \
  tests/chat.tools.registry.test.ts
```

Result:

```text
2 files passed
15 tests passed
```

Focused tool tests:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts \
  tests/chat.tools.list-accounts.test.ts \
  tests/chat.tools.get-transaction-details.test.ts \
  tests/chat.tools.find-uncategorized-transactions.test.ts \
  tests/chat.tools.get-category-breakdown.test.ts \
  tests/chat.tools.compare-spending-periods.test.ts \
  tests/chat.tools.detect-recurring-merchants.test.ts \
  tests/chat.tools.get-cashflow-summary.test.ts
```

Result:

```text
7 files passed
37 tests passed
```

Full API Vitest suite:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Result:

```text
51 files passed
396 tests passed
```

Typecheck:

```bash
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```

Result:

```text
FAILED
```

The typecheck failures are outside this branch's diff and reproduce on `main`:

- `apps/api/src/chat/turn.ts:60` - object possibly undefined.
- `apps/api/src/chat/turn.ts:112` - `Record<string, unknown>` is not assignable to Prisma `InputJsonValue`.

These should not block this specific code review as branch-introduced regressions, but they still block a clean typecheck gate for the API package.

## Merge Recommendation

Required before merge:

1. Fix `startOfWeek()` and `addDaysLocal()` as described above.
2. Add UTC+13/UTC+14 timezone regression tests.
3. Rerun focused period tests.
4. Rerun focused tool tests.
5. Rerun the full API Vitest suite.

Optional but recommended before merge:

1. Fix the pre-existing `chat/turn.ts` typecheck errors so this branch can pass the documented typecheck gate cleanly.
