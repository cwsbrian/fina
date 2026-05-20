# Review: Plan 1E-next Implementation Plan

Date: 2026-05-15

Reviewed document: `docs/superpowers/plans/2026-05-15-plan-1e-next.md`

Reference spec: `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md`

## Latest Verdict

Status after second review: still blocked, but much closer.

The first review's major blockers around command paths, `localMidnightToUtc()`, category totals, recurring lookback boundaries, and cashflow day grouping have been addressed in the current plan.

Two timezone/DST issues remain:

1. `addDaysLocal()` still uses absolute 24-hour arithmetic, which breaks local calendar-day math across DST.
2. The new DST spring-forward test has the wrong expected week for the chosen `now` date.

Fix those two items before executing the plan.

## Pass 1 Verdict

Do not execute this plan as-is.

The plan is close in shape, but it has two execution blockers:

1. The shared timezone helper implementation is incorrect and fails the plan's own expected boundary values.
2. The documented `pnpm --filter @fina/api exec ...` commands use repo-root paths even though filtered `exec` runs from `apps/api`.

These findings are retained for history. They were rechecked in Pass 2, and the current plan has addressed them except for the remaining local-day arithmetic issue described below.

## Pass 1 Findings

### HIGH: `localMidnightToUtc()` computes the wrong UTC instant

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:232`

The proposed implementation compares only the local year/month/day produced by `Intl.DateTimeFormat`, then shifts by whole days. It never computes the actual timezone offset at local midnight.

For `America/Toronto`, the plan's own expected value is:

```text
local 2026-03-01 00:00 -> 2026-03-01T05:00:00.000Z
```

But the proposed helper returns:

```text
2026-03-02T00:00:00.000Z
```

Impact:

- Task 1 fails its own tests.
- `this_week`, `this_month`, `last_month`, and comparison period filters are wrong.
- Every period-based tool can include/exclude the wrong transactions.

Recommended fix:

- Prefer using a timezone-aware date library already available in the workspace if it is in the app dependency graph, or add a small explicit dependency such as Luxon/date-fns-tz if acceptable.
- If avoiding a dependency, compute timezone offset using formatted hour/minute/second as well as date, then iteratively correct the UTC instant.
- Keep the existing boundary tests and add at least one DST-transition case.

### HIGH: Plan commands use the wrong working directory assumptions

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:59`

The plan repeatedly recommends commands like:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts apps/api/tests/<file>.test.ts
pnpm --filter @fina/api exec tsc --noEmit -p apps/api/tsconfig.app.json
```

Verified behavior:

```text
pnpm --filter @fina/api exec pwd
/home/cwsbr/personal/fina/apps/api
```

Because filtered `exec` runs from `apps/api`, the paths should be package-relative:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>.test.ts
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```

Impact:

- The red/green test loop will fail for the wrong reason.
- Engineers may waste time debugging path errors instead of implementation failures.

Recommended fix:

- Update all repeated test commands in the plan.
- Update the final verification block at the bottom of the plan.

### MEDIUM: `getCategoryBreakdown` excludes uncategorized buckets too late

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:1176`

The implementation accumulates `total` across all CAD spending rows first, then filters out uncategorized buckets when `include_uncategorized === false`.

That means uncategorized spend still affects:

- returned `total`
- each category's `share`

This conflicts with the final spec:

- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:401`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:402`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:403`

Impact:

- A user asking to exclude uncategorized spending sees category percentages that do not add up against the visible returned buckets.
- The current planned tests do not catch this.

Recommended fix:

- Apply the uncategorized exclusion before bucket and total aggregation, or use separate denominators intentionally and document that behavior.
- Add a test where categorized spend is 30 and uncategorized spend is 5. With `include_uncategorized: false`, returned `total` should be `30.00`, not `35.00`.

### MEDIUM: `detectRecurringMerchants` does not reuse the shared timezone contract

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:1837`

The plan reimplements timezone lookup inside `detectRecurringMerchants`, does not validate invalid `User.tz`, and then uses UTC midnight as the lower bound:

```text
first of (y, m) at UTC midnight is good enough as a lower bound
```

The final spec requires:

- `User.tz` lookup with invalid-value fallback to `America/Toronto`
- calendar month start in the user's timezone
- conversion to a UTC instant for Prisma comparison

Spec location: `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:535`

Impact:

- Invalid timezone values can throw at runtime.
- Lookback windows behave differently from the rest of the period-aware tools.
- Boundary transactions near local midnight can be misclassified.

Recommended fix:

- Export a helper from `periods.ts` for timezone resolution and local month-start conversion.
- Reuse that helper in `detectRecurringMerchants`.
- Add tests for invalid `User.tz` fallback and a Toronto month-boundary lookback.

### MEDIUM: `getCashflowSummary` groups by UTC day, not user-local day

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:2168`

The planned implementation uses:

```ts
key = r.occurredAt.toISOString().slice(0, 10);
```

This creates a UTC date label. The final spec makes period boundaries user-timezone-aware, and `YYYY-MM-DD` day labels should be interpreted consistently with that same user-local calendar.

Relevant spec locations:

- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:106`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:110`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-final-design.md:614`

Impact:

- A transaction late in the evening in Toronto can be included in the correct local period but displayed under the wrong day label.
- Daily cashflow charts or summaries can look off by one day near midnight.

Recommended fix:

- Add a `dateKeyInUserTz(date, userId)` or `dateKeyInTz(date, tz)` helper in `periods.ts`.
- Use it for `group_by: "day"`.
- Add a test with a UTC instant that maps to a different local date in `America/Toronto`.

## Suggested Patch Order

1. Fix the command paths throughout the plan.
2. Replace or repair `localMidnightToUtc()`.
3. Export shared timezone utilities from `periods.ts`.
4. Update `detectRecurringMerchants` to use the shared timezone utilities.
5. Update `getCashflowSummary` day grouping to use user-local date keys.
6. Fix `getCategoryBreakdown` totals when `include_uncategorized === false`.
7. Add regression tests for each bug above.
8. Run the corrected package-relative verification commands.

## Pass 2 Findings

Date: 2026-05-15

Reviewed document: `docs/superpowers/plans/2026-05-15-plan-1e-next.md`

### HIGH: `addDaysLocal()` uses absolute 24-hour math across DST

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:300`

The updated timezone helper fixed `localMidnightToUtc()`, but `addDaysLocal()` still shifts by `n * 24 * 60 * 60 * 1000` before converting back to local Y/M/D:

```ts
function addDaysLocal(d: Date, n: number, tz: string): Date {
  const shifted = new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
  const p = partsInTz(shifted, tz);
  return localMidnightToUtc(p.year, p.month, p.day, tz);
}
```

That is elapsed-time arithmetic, not local calendar-day arithmetic. It fails across DST transitions.

Concrete failure:

```text
current.gte = 2026-03-09T04:00:00.000Z
Toronto wall time = 2026-03-09 00:00 EDT

addDaysLocal(current.gte, -7, "America/Toronto")
actual   = 2026-03-01T05:00:00.000Z
expected = 2026-03-02T05:00:00.000Z
```

Impact:

- `comparisonRanges(ctx.userId, "this_week", "previous_week")` can produce a previous-week range that starts on Sunday instead of Monday.
- `basicPeriodRange(..., "this_week")` can also compute the end boundary incorrectly when the 7-day window crosses a DST transition.
- Downstream compare/cashflow/category tools can include the wrong records at week boundaries.

Recommended fix:

- Implement local-day addition by adding to local calendar Y/M/D fields, not by shifting the UTC instant by 24 hours.
- A dependency-free option is:

```ts
function addDaysLocal(d: Date, n: number, tz: string): Date {
  const p = partsInTz(d, tz);
  const localNoon = new Date(Date.UTC(p.year, p.month - 1, p.day + n, 12, 0, 0));
  const target = partsInTz(localNoon, tz);
  return localMidnightToUtc(target.year, target.month, target.day, tz);
}
```

The noon anchor avoids most midnight/DST edge cases while still deriving the final boundary through `localMidnightToUtc()`.

Add regression tests for:

- `addDaysLocal(2026-03-09 Toronto midnight, -7)` returns `2026-03-02T05:00:00.000Z`.
- `basicPeriodRange(..., "this_week")` for a week crossing spring-forward returns a 7-local-day window with correct UTC endpoints.

### HIGH: The new DST test uses the wrong expected week

Location: `docs/superpowers/plans/2026-05-15-plan-1e-next.md:166`

The test says:

```ts
const now = new Date("2026-03-10T12:00:00Z");
const r = await basicPeriodRange(userId, "this_week", now);
expect(r.gte.toISOString()).toBe("2026-03-02T05:00:00.000Z");
expect(r.lt.toISOString()).toBe("2026-03-09T04:00:00.000Z");
```

But `2026-03-10T12:00:00Z` is Tuesday, March 10 in Toronto. The current week starts Monday, March 9:

```text
expected gte = 2026-03-09T04:00:00.000Z
expected lt  = 2026-03-16T04:00:00.000Z
```

If the intent is to test the week containing DST spring-forward Sunday, use a `now` instant on Sunday, March 8:

```ts
const now = new Date("2026-03-08T12:00:00Z");
expect(r.gte.toISOString()).toBe("2026-03-02T05:00:00.000Z");
expect(r.lt.toISOString()).toBe("2026-03-09T04:00:00.000Z");
```

Impact:

- The test currently rejects correct behavior.
- It can mask the real `addDaysLocal()` bug by encoding the wrong expected week.

Recommended fix:

- Either change `now` to March 8 and keep the March 2-9 expected range, or keep March 10 and update the expected range to March 9-16.

## Pass 2 Resolved Items

These items from Pass 1 were rechecked and appear addressed in the current plan:

- Command paths now use package-relative `tests/...` and `tsconfig.app.json`.
- `localMidnightToUtc()` now compares hour/minute/second and produced the expected Toronto month boundary values in a trace.
- `getCategoryBreakdown` now applies `categoryId: { not: null }` before aggregation when `include_uncategorized === false`.
- `detectRecurringMerchants` now reuses `lookbackMonthStart()`.
- `getCashflowSummary` now uses `dateKeyInTz()` for day grouping.

## Updated Patch Order

1. Replace `addDaysLocal()` with local calendar-day arithmetic.
2. Correct the DST spring-forward test date or expected range.
3. Add regression coverage for previous-week comparison across DST.
4. Run the corrected verification commands below.

## Corrected Verification Commands

From repo root:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.periods.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.list-accounts.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.get-transaction-details.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.find-uncategorized-transactions.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.get-category-breakdown.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.compare-spending-periods.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.detect-recurring-merchants.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.get-cashflow-summary.test.ts
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
pnpm --filter @fina/api test
```

## Execution Recommendation

After the Pass 2 fixes above, the plan is a reasonable implementation blueprint for the final design spec. Until then, the plan should still be treated as blocked because week boundaries can be wrong across DST.
