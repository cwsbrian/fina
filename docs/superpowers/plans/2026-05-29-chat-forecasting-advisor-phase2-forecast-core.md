# Chat Forecasting Advisor — Phase 2 (Forecast Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `compareSpendingVsBudget` answer "am I okay this month?" with a real per-category **month-end forecast** (projected total, overspend, runway, 3-tier severity), replacing the `todayPct*1.05` pace heuristic.

**Architecture:** A new I/O-bound `apps/api/src/analysis/forecast.ts` composes existing budget-plans data + three new per-category aggregates into `projectMonthEnd()`. The chat tool consumes it; the recap block gains optional projection fields (non-breaking). All month/day/runway math is computed in the user's timezone via `periods.ts`.

**Tech Stack:** Fastify + Prisma (Postgres), Zod, Vitest (real DB, no Prisma mocks), `@fina/shared` for cross-app shapes, Gemini chat tools.

**Scope:** This plan covers the shared foundation + Phase #2 only. Phase #3 (`addScheduledSpendBatch` + plan proposals) and Phase #4 (daily-brief surfacing + `BudgetRiskState` + push) get their own plans once this lands and `CategoryForecast`/`projectMonthEnd` are concrete.

**Spec:** `docs/superpowers/specs/2026-05-29-chat-forecasting-advisor-design.md`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `libs/shared/src/enums.ts` | Modify | Add `RISK_TIERS` const + `RiskTier` type |
| `libs/shared/src/index.ts` | Modify (verify) | Re-export already covers `enums.ts` |
| `libs/shared/src/dto/chat.ts` | Modify | Add optional `projected` + `severity` to `recap` rows; optional `projected` on headline |
| `apps/api/src/budget-plans/service.ts` | Modify | Export 3 new aggregates: `recentDiscretionaryDailyByCategory`, `monthlySubscriptionByCategory`, `monthlyScheduledSpendByCategory`; refactor `subscriptionOccurrencesByCategory` to be reusable |
| `apps/api/src/analysis/forecast.ts` | Create | `projectMonthEnd()` + `CategoryForecast`/`MonthEndForecast` types + severity/runway math |
| `apps/api/src/chat/tools/compare-spending-vs-budget.ts` | Modify | Consume forecast; add `projected/projectedOverspend/runwayDay/severity` to items + recap rows |
| `apps/api/src/chat/turn.ts` | Modify | Update the routing/copy block (lines ~141-154) to instruct forecast-style judgment |
| `apps/api/tests/analysis.forecast.test.ts` | Create | Forecast math: rent-only≈cap, mixed, cold-start, runway nulls, refund/pending, tz boundary |
| `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts` | Modify | Extend with projection assertions; keep existing recap/headline tests green |
| `apps/mobile/src/chat/PresentationBlock.tsx` | Modify | Render optional `projected` line on recap rows (non-breaking) |

**Math reference (from spec, as implemented here):**
```
daysLeft_c    = daysInMonth - todayLocalDay + 1            // user tz, inclusive
spent_c       = snapshot spent this month                  // snapshot convention (card parity)
fixedBills_c  = remaining subscription occurrences, today-forward
plannedOneOffs_c = unmatched ScheduledSpend, scheduledDate >= monthStart
discRate_c    = max(0, winsorized 90d discretionary actuals - recurring 3-mo equiv) / 90
                // 90d input EXCLUDES pending, NETS refunds; "discretionary" subtracts recurring
projectedTotal_c = spent_c + fixedBills_c + max(plannedOneOffs_c, discRate_c * daysLeft_c)
severity: on_track (proj<=cap) / watch (cap<proj<=cap*1.10) / at_risk (proj>cap*1.10)
          / insufficient_history (discRate_c <= 0 AND fixedBills_c+plannedOneOffs_c == 0 AND spent_c == 0)
runwayDay_c: null unless discRate_c>0 AND spent_c<cap_c AND day in [today, monthEnd]
```

---

## Task 1: `RiskTier` shared enum

**Files:**
- Modify: `libs/shared/src/enums.ts`
- Test: `libs/shared/src/enums.test.ts` (create if absent; else append)

- [ ] **Step 1: Write the failing test**

```ts
// libs/shared/src/enums.test.ts
import { describe, expect, it } from "vitest";
import { RISK_TIERS, type RiskTier } from "./enums.js";

describe("RISK_TIERS", () => {
  it("lists the four forecast severity tiers in increasing-risk order", () => {
    expect(RISK_TIERS).toEqual([
      "on_track",
      "watch",
      "at_risk",
      "insufficient_history",
    ]);
    const t: RiskTier = "at_risk";
    expect(RISK_TIERS).toContain(t);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm --filter @fina/shared test enums`
Expected: FAIL — `RISK_TIERS` is not exported.

- [ ] **Step 3: Implement**

Append to `libs/shared/src/enums.ts`:

```ts
/** Forecast severity tiers surfaced by the chat advisor + daily brief.
 *  Ordered by increasing risk; `insufficient_history` means "too new to
 *  forecast", not a risk level. */
export const RISK_TIERS = [
  "on_track",
  "watch",
  "at_risk",
  "insufficient_history",
] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
```

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm --filter @fina/shared test enums`
Expected: PASS.

- [ ] **Step 5: Verify the barrel re-exports it**

Run: `grep -n "enums" libs/shared/src/index.ts`
Expected: an existing `export * from "./enums.js";` (or equivalent). If missing, add `export * from "./enums.js";`.

- [ ] **Step 6: Commit**

```bash
git add libs/shared/src/enums.ts libs/shared/src/enums.test.ts libs/shared/src/index.ts
git commit -m "feat(shared): add RiskTier forecast severity union"
```

---

## Task 2: Extend the `recap` block with optional projection fields

Adding **optional** fields to the existing `recap` variant — does NOT add a union member, so `apps/mobile`'s exhaustive renderer keeps compiling.

**Files:**
- Modify: `libs/shared/src/dto/chat.ts` (the `recap` variant, ~lines 64-103)

- [ ] **Step 1: Add optional `projected` to headline and `projected`/`severity` to rows**

In the `recap` variant, extend `headline` and each `rows[]` entry:

```ts
      /** Optional headline number (large) — total / net / used. */
      headline?: {
        label?: string;
        amount: string;
        currency?: string;
        delta?: { value: string; direction: "up" | "down" };
        /** Optional projected month-end total (forecast). Stringified, no
         *  currency symbol. Present only on forecast-aware recaps. */
        projected?: string;
      };
```

```ts
      rows: Array<{
        label: string;
        amount: string;
        sub?: string;
        bar_pct?: number;
        delta?: { value: string; direction: "up" | "down" };
        /** Optional projected month-end spend for this row (forecast). */
        projected?: string;
        /** Optional forecast severity for this row. */
        severity?: RiskTier;
      }>;
```

Add the import at the top of `dto/chat.ts` (it already imports from sibling modules; mirror the style):

```ts
import type { RiskTier } from "../enums.js";
```

- [ ] **Step 2: Verify shared + mobile typecheck stay green**

Run: `pnpm --filter @fina/shared build && pnpm nx typecheck mobile`
Expected: PASS (optional fields don't break the mobile `recap` renderer; `tsc --noEmit` alone is a no-op — use `nx typecheck mobile`).

- [ ] **Step 3: Commit**

```bash
git add libs/shared/src/dto/chat.ts
git commit -m "feat(shared): optional projected/severity fields on recap block"
```

---

## Task 3: Per-category discretionary 90-day daily rate aggregate

`recentMonthlyAvgSpend` is workspace-total; the forecast needs **per-category**, **discretionary** (recurring removed), **refund-netted**, **pending-excluded**, **winsorized** daily rate. New exported function.

**Files:**
- Modify: `apps/api/src/budget-plans/service.ts`
- Test: `apps/api/tests/analysis.forecast.test.ts` (create — also used by later tasks)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/analysis.forecast.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { recentDiscretionaryDailyByCategory } from "../src/budget-plans/service.js";

describe("recentDiscretionaryDailyByCategory", () => {
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `disc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function tx(amount: string, day: string, pending = false) {
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount, merchantRaw: "M", occurredAt: new Date(day), source: "manual", pending, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount } });
    return t;
  }

  it("nets refunds and excludes pending in the 90-day discretionary daily rate", async () => {
    await tx("90.00", "2026-04-20T12:00:00Z");      // counts
    await tx("-30.00", "2026-04-21T12:00:00Z");     // refund nets out
    await tx("60.00", "2026-05-01T12:00:00Z", true); // pending excluded
    // Net discretionary 90d = 90 - 30 = 60 → /90 = 0.6667/day (no recurring to subtract).
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining)).toBeCloseTo(60 / 90, 4);
  });

  it("subtracts the category's recurring monthly-equivalent (3 months) so fixed bills don't inflate the rate", async () => {
    // 3 monthly rent payments of 100 already posted in the trailing 90d = 300 actual.
    await tx("100.00", "2026-03-01T12:00:00Z");
    await tx("100.00", "2026-04-01T12:00:00Z");
    await tx("100.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Rent", nameNormalized: "rent", amount: "100.00", categoryId: dining, cadence: "monthly", nextOccurrenceDate: new Date("2026-06-01T12:00:00Z") },
    });
    // actual 300 - recurring(100/mo * 3) = 0 discretionary → rate 0.
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    expect(rates.get(dining) ?? 0).toBeCloseTo(0, 4);
  });

  it("winsorizes a single outlier to 3x the category mean so one big buy doesn't poison 90 days", async () => {
    await tx("10.00", "2026-04-10T12:00:00Z");
    await tx("10.00", "2026-04-12T12:00:00Z");
    await tx("1000.00", "2026-04-15T12:00:00Z"); // outlier, capped to 3x mean
    const rates = await recentDiscretionaryDailyByCategory(wsId, [dining]);
    // mean of [10,10,1000] = 340; cap = 3*340 = 1020 (>1000, so no cap here) — assert it is at most the uncapped rate
    const uncapped = (10 + 10 + 1000) / 90;
    expect(rates.get(dining)!).toBeLessThanOrEqual(uncapped + 1e-9);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: FAIL — `recentDiscretionaryDailyByCategory` is not exported.

- [ ] **Step 3: Implement**

Add to `apps/api/src/budget-plans/service.ts` (uses existing `monthlyEquivalent` import — add it if absent: `import { occurrencesInRange, monthlyEquivalent } from "../recurring/occurrences.js";`):

```ts
/** Per-category DISCRETIONARY daily spend rate over the trailing 90 days,
 *  for the month-end forecast. Discretionary = actual category spend with the
 *  category's recurring (subscription) monthly-equivalent removed, so fixed
 *  bills aren't double-counted against forward occurrences. Refunds are NETTED
 *  (we do NOT filter amount>0) and pending transactions are EXCLUDED to avoid
 *  double-counting the later posted row. A single outlier transaction is
 *  winsorized to 3x the category's mean so one big buy doesn't dominate 90 days.
 *  Returns a Map categoryId -> daily rate (>= 0). */
export async function recentDiscretionaryDailyByCategory(
  workspaceId: string,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (categoryIds.length === 0) return out;
  const since = new Date(Date.now() - 90 * 86_400_000);

  // Row-level so we can net refunds per-category and winsorize outliers.
  const rows = await prisma.transactionAllocation.findMany({
    where: {
      categoryId: { in: categoryIds },
      transaction: {
        workspaceId,
        removedAt: null,
        pending: false,
        occurredAt: { gte: since },
      },
    },
    select: { amount: true, categoryId: true },
  });

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.categoryId) continue;
    const arr = byCat.get(r.categoryId) ?? [];
    arr.push(Number(r.amount));
    byCat.set(r.categoryId, arr);
  }

  // Recurring monthly-equivalent per category (3 months in the 90-day window).
  const subs = await prisma.recurringExpense.findMany({
    where: { workspaceId, categoryId: { in: categoryIds } },
    select: { amount: true, cadence: true, categoryId: true },
  });
  const recurringMonthly = new Map<string, number>();
  for (const s of subs) {
    if (!s.categoryId) continue;
    recurringMonthly.set(
      s.categoryId,
      (recurringMonthly.get(s.categoryId) ?? 0) + monthlyEquivalent(Number(s.amount), s.cadence),
    );
  }

  for (const id of categoryIds) {
    const amounts = byCat.get(id) ?? [];
    if (amounts.length === 0) {
      out.set(id, 0);
      continue;
    }
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const cap = 3 * mean;
    // Winsorize positive outliers; refunds (negatives) pass through to net.
    const winsorized = amounts.map((a) => (a > cap ? cap : a));
    const net90 = winsorized.reduce((a, b) => a + b, 0);
    const discretionary90 = net90 - (recurringMonthly.get(id) ?? 0) * 3;
    out.set(id, Math.max(0, discretionary90) / 90);
  }
  return out;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budget-plans/service.ts apps/api/tests/analysis.forecast.test.ts
git commit -m "feat(api): per-category discretionary 90-day daily rate aggregate"
```

---

## Task 4: Split subscription vs scheduled-spend per category

The forecast needs `fixedBills` (subscriptions, today-forward) and `plannedOneOffs` (ScheduledSpend, from month start) **separately**. Today `monthlyScheduledByCategory` returns them combined. Export the two halves.

**Files:**
- Modify: `apps/api/src/budget-plans/service.ts` (make `subscriptionOccurrencesByCategory` exported + add `monthlyScheduledSpendByCategory`)
- Test: `apps/api/tests/analysis.forecast.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the file)**

```ts
import {
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
} from "../src/budget-plans/service.js";

describe("subscription vs scheduled split", () => {
  let wsId: string;
  let groceries: string;
  beforeEach(async () => {
    const stamp = `split-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("subscription occurrences are today-forward only", async () => {
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Box", nameNormalized: "box", amount: "40.00", categoryId: groceries, cadence: "weekly", nextOccurrenceDate: new Date("2026-05-18T12:00:00Z") },
    });
    const subs = await monthlySubscriptionByCategory(wsId, 2026, 5);
    // 5/18 and 5/25 fall in [today=5/15, 6/1) → 2 occurrences * 40 = 80.
    expect(subs.get(groceries)).toBeCloseTo(80, 2);
  });

  it("scheduled spend counts unmatched/undismissed items from month start (incl. past-dated this month)", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "50.00", scheduledDate: new Date("2026-05-10") }, // past-dated, still expected
    });
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: groceries, amount: "25.00", scheduledDate: new Date("2026-05-20") },
    });
    const sched = await monthlyScheduledSpendByCategory(wsId, 2026, 5);
    expect(sched.get(groceries)).toBeCloseTo(75, 2);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

In `service.ts`, change `async function subscriptionOccurrencesByCategory` to `export`, and add a `(year, month)` wrapper + a scheduled-only function:

```ts
/** Subscription (RecurringExpense) occurrences for the month, grouped by
 *  category, today-forward. Wraps subscriptionOccurrencesByCategory. */
export async function monthlySubscriptionByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<Map<string, number>> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(month1to12 === 12 ? year + 1 : year, month1to12 === 12 ? 1 : month1to12 + 1);
  const m = await subscriptionOccurrencesByCategory(workspaceId, from, to);
  return new Map(Array.from(m, ([id, v]) => [id, Math.round(v.spent * 100) / 100]));
}

/** Unmatched, undismissed ScheduledSpend for the month (scheduledDate from
 *  month start — past-dated-this-month items are still expected), grouped by
 *  category. Excludes subscriptions (those come from monthlySubscriptionByCategory). */
export async function monthlyScheduledSpendByCategory(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<Map<string, number>> {
  const from = firstOfMonth(year, month1to12);
  const to = firstOfMonth(month1to12 === 12 ? year + 1 : year, month1to12 === 12 ? 1 : month1to12 + 1);
  const rows = await prisma.scheduledSpend.findMany({
    where: { workspaceId, scheduledDate: { gte: from, lt: to }, matchedTxId: null, dismissedAt: null },
    select: { amount: true, categoryId: true },
  });
  const sums = new Map<string, number>();
  for (const r of rows) {
    sums.set(r.categoryId, (sums.get(r.categoryId) ?? 0) + Number(r.amount));
  }
  return new Map(Array.from(sums, ([id, v]) => [id, Math.round(v * 100) / 100]));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budget-plans/service.ts apps/api/tests/analysis.forecast.test.ts
git commit -m "feat(api): split subscription vs scheduled-spend per-category aggregates"
```

---

## Task 5: `projectMonthEnd` forecast service

**Files:**
- Create: `apps/api/src/analysis/forecast.ts`
- Test: `apps/api/tests/analysis.forecast.test.ts` (append)

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { projectMonthEnd } from "../src/analysis/forecast.js";

describe("projectMonthEnd", () => {
  let wsId: string;
  let userId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `fc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "FC", tz: "America/Toronto" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function spend(amount: string, day: string) {
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount, merchantRaw: "M", occurredAt: new Date(day), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount } });
  }
  async function plan(cap: number) {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: cap }] },
    });
  }

  it("a rent-only category projects ~cap, NOT cap+rent (no double-count)", async () => {
    await plan(2000);
    // 3 months of rent in trailing 90d (already paid) + this month's rent paid on the 1st.
    await spend("2000.00", "2026-03-01T12:00:00Z");
    await spend("2000.00", "2026-04-01T12:00:00Z");
    await spend("2000.00", "2026-05-01T12:00:00Z");
    await prisma.recurringExpense.create({
      data: { workspaceId: wsId, name: "Rent", nameNormalized: "rent", amount: "2000.00", categoryId: dining, cadence: "monthly", nextOccurrenceDate: new Date("2026-06-01T12:00:00Z") },
    });
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    // spent this month 2000, no future rent occurrence before 6/1, discRate ~0 → projected ~2000 = cap.
    expect(c.projected).toBeCloseTo(2000, 0);
    expect(c.severity).toBe("on_track");
  });

  it("flags at_risk when discretionary run-rate projects past cap*1.10", async () => {
    await plan(500);
    // $300 spent over the first ~half month, discretionary, no recurring.
    await spend("150.00", "2026-05-05T12:00:00Z");
    await spend("150.00", "2026-05-10T12:00:00Z");
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.projected).toBeGreaterThan(500 * 1.1);
    expect(c.severity).toBe("at_risk");
    expect(c.projectedOverspend).toBeGreaterThan(0);
    expect(c.runwayDay).not.toBeNull();
  });

  it("returns insufficient_history for a brand-new capped category with no data", async () => {
    await plan(500);
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.severity).toBe("insufficient_history");
    expect(c.runwayDay).toBeNull();
  });

  it("runwayDay is null when already over cap", async () => {
    await plan(100);
    await spend("150.00", "2026-05-03T12:00:00Z");
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.runwayDay).toBeNull(); // already over -> "already over", not a date
    expect(c.severity).toBe("at_risk");
  });

  it("returns empty categories + on_track portfolio when no budget plan exists", async () => {
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    expect(f.categories).toEqual([]);
    expect(f.portfolio.severity).toBe("on_track");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: FAIL — `projectMonthEnd` not found.

- [ ] **Step 3: Implement `apps/api/src/analysis/forecast.ts`**

```ts
import type { RiskTier } from "@fina/shared";
import {
  budgetPlanSnapshot,
  recentDiscretionaryDailyByCategory,
  monthlySubscriptionByCategory,
  monthlyScheduledSpendByCategory,
} from "../budget-plans/service.js";
import { partsInTz, resolveUserTz } from "../chat/tools/periods.js";

const WATCH_FACTOR = 1.1;

export type CategoryForecast = {
  categoryId: string;
  categoryName: string;
  cap: number;
  spent: number;
  fixedBills: number;
  plannedOneOffs: number;
  discRate: number;
  daysLeft: number;
  projected: number;
  projectedOverspend: number;
  projectedUnderspend: number;
  runwayDay: number | null;
  severity: RiskTier;
};

export type MonthEndForecast = {
  year: number;
  month: number;
  daysLeft: number;
  categories: CategoryForecast[];
  portfolio: { cap: number; spent: number; projected: number; severity: RiskTier };
};

function severityFor(projected: number, cap: number): RiskTier {
  if (projected <= cap) return "on_track";
  if (projected <= cap * WATCH_FACTOR) return "watch";
  return "at_risk";
}

/** Days remaining in the month (inclusive of today) in the user's tz. For a
 *  past month → 0; a future month → full month. */
function daysLeftInMonth(year: number, month: number, now: Date, tz: string): { daysLeft: number; daysInMonth: number; todayDay: number; isThisMonth: boolean } {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const p = partsInTz(now, tz);
  const cmp = p.year * 12 + (p.month - 1) - (year * 12 + (month - 1));
  if (cmp > 0) return { daysLeft: 0, daysInMonth, todayDay: daysInMonth, isThisMonth: false }; // past
  if (cmp < 0) return { daysLeft: daysInMonth, daysInMonth, todayDay: 0, isThisMonth: false }; // future
  return { daysLeft: daysInMonth - p.day + 1, daysInMonth, todayDay: p.day, isThisMonth: true };
}

export async function projectMonthEnd(
  workspaceId: string,
  userId: string,
  year: number,
  month: number,
  now: Date = new Date(),
): Promise<MonthEndForecast> {
  const tz = await resolveUserTz(userId);
  const { daysLeft, todayDay, isThisMonth } = daysLeftInMonth(year, month, now, tz);

  const snap = await budgetPlanSnapshot(workspaceId, year, month);
  if (!snap) {
    return { year, month, daysLeft, categories: [], portfolio: { cap: 0, spent: 0, projected: 0, severity: "on_track" } };
  }

  const capped = snap.categories.filter((c) => c.allocated !== null);
  const capIds = capped.map((c) => c.categoryId);

  const [discRates, subs, scheduled] = await Promise.all([
    recentDiscretionaryDailyByCategory(workspaceId, capIds),
    monthlySubscriptionByCategory(workspaceId, year, month),
    monthlyScheduledSpendByCategory(workspaceId, year, month),
  ]);

  const categories: CategoryForecast[] = capped.map((c) => {
    const cap = parseFloat(c.allocated!);
    const spent = parseFloat(c.spent);
    const fixedBills = subs.get(c.categoryId) ?? 0;
    const plannedOneOffs = scheduled.get(c.categoryId) ?? 0;
    const discRate = discRates.get(c.categoryId) ?? 0;

    const discProjection = discRate * daysLeft;
    const projected = round2(spent + fixedBills + Math.max(plannedOneOffs, discProjection));
    const projectedOverspend = Math.max(0, round2(projected - cap));
    const projectedUnderspend = Math.max(0, round2(cap - projected));

    const noActivity = spent === 0 && fixedBills === 0 && plannedOneOffs === 0;
    const severity: RiskTier =
      discRate <= 0 && noActivity ? "insufficient_history" : severityFor(projected, cap);

    // Runway: only a concrete day when discretionary spend is actively
    // consuming headroom AND the exhaustion day lands in [today, monthEnd].
    let runwayDay: number | null = null;
    if (isThisMonth && discRate > 0 && spent < cap) {
      const daysToZero = (cap - spent) / discRate;
      const day = todayDay + Math.floor(daysToZero);
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day >= todayDay && day <= daysInMonth) runwayDay = day;
    }

    return {
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      cap, spent, fixedBills, plannedOneOffs, discRate, daysLeft,
      projected, projectedOverspend, projectedUnderspend, runwayDay, severity,
    };
  });

  // Portfolio: workspace-level run-rate so an uncapped category can't keep the
  // headline green while the total goes red. Uses snapshot true totals.
  const totalCap = parseFloat(snap.totalAmount);
  const totalSpent = parseFloat(snap.totalSpent);
  const totalScheduled = parseFloat(snap.totalScheduled);
  const portfolioProjected = round2(totalSpent + totalScheduled);
  const portfolio = {
    cap: totalCap,
    spent: totalSpent,
    projected: portfolioProjected,
    severity: totalCap > 0 ? severityFor(portfolioProjected, totalCap) : "on_track" as RiskTier,
  };

  return { year, month, daysLeft, categories, portfolio };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

> Note: portfolio projection here uses known totals (`spent + scheduled`); a workspace-wide discretionary run-rate term is a deliberate Phase-4 follow-up (it needs an all-category rate, not just capped). Documented so it's a decision, not a gap.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @fina/api test analysis.forecast`
Expected: PASS (all forecast tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analysis/forecast.ts apps/api/tests/analysis.forecast.test.ts
git commit -m "feat(api): projectMonthEnd forecast service (tz-correct, runway-guarded)"
```

---

## Task 6: Upgrade `compareSpendingVsBudget` to surface the forecast

**Files:**
- Modify: `apps/api/src/chat/tools/compare-spending-vs-budget.ts`
- Modify: `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`

- [ ] **Step 1: Add a forecast assertion test (append to the existing describe)**

```ts
  it("surfaces a month-end forecast: projected + severity on over-pace categories", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    for (const day of ["2026-05-05", "2026-05-10"]) {
      const t = await prisma.transaction.create({
        data: { workspaceId: wsId, accountId: acct, amount: "150.00", merchantRaw: "Resto", occurredAt: new Date(`${day}T12:00:00Z`), source: "manual", pending: false, rawData: {} },
      });
      await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount: "150.00" } });
    }
    const r = await compareSpendingVsBudget.run(ctx, {});
    const item = r.items.find((i) => i.categoryName === "Dining")!;
    expect(item.severity).toBe("at_risk");
    expect(Number(item.projected)).toBeGreaterThan(500);
    if (r.block.type !== "recap") throw new Error("wrong block");
    const row = r.block.rows.find((x) => x.label === "Dining")!;
    expect(row.projected).toBeDefined();
    expect(row.severity).toBe("at_risk");
  });
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @fina/api test compare-spending-vs-budget`
Expected: FAIL — `item.severity` / `row.projected` undefined.

- [ ] **Step 3: Implement the upgrade**

Extend the tool's `Item` type and `run`, calling `projectMonthEnd`. The existing pace fields stay (back-compat); add forecast fields:

```ts
import { projectMonthEnd, type CategoryForecast } from "../../analysis/forecast.js";
import type { RiskTier } from "@fina/shared";
```

Add to `type Item`:

```ts
  projected: string;
  projectedOverspend: string;
  runwayDay: number | null;
  severity: RiskTier;
```

In `run`, after computing `snap`, also fetch the forecast and index it:

```ts
    const forecast = await projectMonthEnd(ctx.workspaceId, ctx.userId, year, month);
    const fcById = new Map<string, CategoryForecast>(
      forecast.categories.map((f) => [f.categoryId, f]),
    );
```

In the `.map((c) => {...})`, pull the matching forecast and add the fields to the returned item:

```ts
        const fc = fcById.get(c.categoryId);
        return {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          amount: c.allocated!,
          spent: c.spent,
          planned: c.scheduled,
          remaining: remaining.toFixed(2),
          spentPct,
          plannedPct,
          todayPct,
          status,
          projected: (fc?.projected ?? spent).toFixed(2),
          projectedOverspend: (fc?.projectedOverspend ?? 0).toFixed(2),
          runwayDay: fc?.runwayDay ?? null,
          severity: fc?.severity ?? "insufficient_history",
        };
```

Change the attention filter in `toRecapBlock` to use forecast severity (over budget OR projected at/over risk), and add `projected`/`severity` to each emitted row. Pass `items` (now forecast-aware) through; update the row map:

```ts
  const attention = items
    .filter((i) => i.severity === "at_risk" || i.severity === "watch" || parseFloat(i.remaining) < 0)
    .sort((a, b) => b.spentPct - a.spentPct);
```

```ts
    rows: attention.map((i) => {
      const rem = parseFloat(i.remaining);
      return {
        label: i.categoryName,
        amount: i.spent,
        sub: `Budget ${i.amount}`,
        bar_pct: Math.min(100, Math.round(i.spentPct)),
        delta: { value: Math.abs(rem).toFixed(2), direction: (rem >= 0 ? "down" : "up") as "up" | "down" },
        projected: i.projected,
        severity: i.severity,
      };
    }),
```

(Pass `totalSpent`/`totalBudget` unchanged; the headline keeps the true-totals `Used %`. Optionally set `headline.projected` from `forecast.portfolio.projected.toFixed(2)`.)

- [ ] **Step 4: Run, verify pass — AND existing tests stay green**

Run: `pnpm --filter @fina/api test compare-spending-vs-budget`
Expected: PASS — the new test plus all 3 pre-existing tests (items/headline/attention). If an existing test broke, the back-compat fields drifted — fix before moving on.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/compare-spending-vs-budget.ts apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts
git commit -m "feat(chat): compareSpendingVsBudget surfaces month-end forecast + severity"
```

---

## Task 7: Update the chat system prompt for forecast-style judgment

**Files:**
- Modify: `apps/api/src/chat/turn.ts` (the `compareSpendingVsBudget` routing/copy block, ~lines 141-154)

- [ ] **Step 1: Read the current block**

Run: `sed -n '138,158p' apps/api/src/chat/turn.ts`
Expected: the existing instruction routing "am I okay / on track" to `compareSpendingVsBudget` with the JUDGMENT-not-percent copy rule.

- [ ] **Step 2: Replace the copy rule to reference the forecast**

Update the prose so the model narrates the **projection + runway + severity** (not just current pace), and branches on late-month. Keep it bilingual, matching the surrounding style. Replace the existing rule lines with:

```
- For "am I okay / on track / 이대로 괜찮아", call compareSpendingVsBudget and give a
  FORECAST judgment from each item's `severity`, `projected`, `projectedOverspend`, and
  `runwayDay` — NOT the raw spent %. Name the 1-2 at_risk categories with the projected
  overspend and, if present, the runway day. Examples:
    EN: "Dining is heading over — at this pace you'll hit ~$580 by month-end (~$80 over),
         running out around the 24th. Everything else looks on track."
    KR: "식비가 위험해요 — 이대로면 월말에 ~$580, 약 $80 초과고 24일쯤 바닥이에요.
         나머지는 괜찮아요."
  If every category is on_track: reassure ("이번달은 예산 안에서 잘 가고 있어요." /
  "You're on track for the month."). Late in the month (small runway), phrase
  retrospectively ("you ended ~$80 over") rather than present-tense.
  `insufficient_history` categories: say it's too new to forecast, don't warn.
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fina/api typecheck` (or `pnpm nx typecheck api`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/chat/turn.ts
git commit -m "feat(chat): forecast-style judgment copy rules for compareSpendingVsBudget"
```

---

## Task 8: Mobile — render the projected line on recap rows (non-breaking)

**Files:**
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx` (the `recap` row renderer)

- [ ] **Step 1: Locate the recap row renderer**

Run: `grep -n "recap\|bar_pct\|\.rows" apps/mobile/src/chat/PresentationBlock.tsx`
Expected: the `case "recap"` branch mapping `block.rows`.

- [ ] **Step 2: Render `projected` when present**

In the recap row JSX, after the existing amount/delta, add a small muted line shown only when `row.projected` exists (mirror existing StyleSheet/muted-text conventions in the file):

```tsx
{row.projected ? (
  <Text style={styles.rowSub}>
    {row.severity === "at_risk" ? "⚠️ " : ""}projected {row.projected}
  </Text>
) : null}
```

(Use the file's existing `Text` import and a muted style; if `styles.rowSub` doesn't exist, reuse whichever muted style the `sub` line already uses.)

- [ ] **Step 3: Typecheck mobile**

Run: `pnpm nx typecheck mobile`
Expected: PASS (bare `tsc --noEmit` is a no-op in this app — use `nx typecheck mobile`).

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/chat/PresentationBlock.tsx
git commit -m "feat(mobile): show projected month-end on budget recap rows"
```

---

## Self-Review (completed by plan author)

**Spec coverage (Phase 2 slice):** forecast math (Task 5), tz-correctness (Task 5 `daysLeftInMonth` + tests), runway guards (Task 5 + tests), refund/pending + discretionary rate (Task 3), subscription/scheduled split incl. past-dated policy (Task 4), severity tiers + insufficient_history (Task 5), tool upgrade + recap parity (Task 6), prompt lockstep (Task 7), mobile non-breaking render (Task 8), portfolio guard (Task 5 portfolio). Deferred-by-design and noted: workspace-wide discretionary portfolio term, `forecast_card`, `BudgetRiskState`, brief injection, batch tool → Phases 3/4.

**Placeholder scan:** none — every code/test step carries full content.

**Type consistency:** `RiskTier` (shared) used identically in `dto/chat.ts`, `forecast.ts`, and the tool. `CategoryForecast` fields (`projected`, `projectedOverspend`, `runwayDay`, `severity`) match between Task 5 definition and Task 6 consumption. Aggregate names (`recentDiscretionaryDailyByCategory`, `monthlySubscriptionByCategory`, `monthlyScheduledSpendByCategory`) consistent across Tasks 3–5.

**Test runner note:** integration tests hit a real DB. Ensure the test Postgres is up (`docker-compose up -d`, host port 5433 per current `docker-compose.yml`) and migrations are applied before running.
