# Brief Total-First Forecast & Risk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every brief (daily/weekly/monthly) lead with the month-end forecast of the user's TOTAL budget — naming the top leaking categories and, when at risk, inviting a plan — in English.

**Architecture:** Reuse the `projectMonthEnd` forecast engine inside the brief context builder; add a pure server-internal `summarizeForecast` mapper that produces a display-formatted `BriefForecast`; attach it to each `WorkspaceContext`; rewrite all LLM-authored strings in `brief.ts` in English with total-first forecast rules. No `@fina/shared`, web, or mobile changes; no new DB columns; no engine change.

**Tech Stack:** TypeScript, Fastify/Prisma API, Vitest (real-DB integration tests, no Prisma mocks), Gemini via `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-05-30-brief-forecast-risk-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/analysis/forecast.ts` | Export `round2` for reuse. |
| `apps/api/tests/analysis.forecast.test.ts` | Modify — backfill the portfolio `Math.max(committed, monthlyAvg)` run-rate coverage the monthly brief relies on. |
| `apps/api/src/chat/brief-context.ts` | New `formatMoney` + `BriefForecast` + `summarizeForecast`; `forecast` field on `WorkspaceContext`; `buildWorkspaceContext` calls `projectMonthEnd`; remove dead `deviation`. |
| `apps/api/src/chat/brief.ts` | English rewrite of `SYSTEM_PROMPT_PER_TYPE`; extract + translate + export `USER_INSTRUCTION` and `EMPTY_BRIEF_FALLBACK`. |
| `apps/api/tests/brief.forecast-summary.test.ts` | New — `summarizeForecast` unit tests. |
| `apps/api/tests/brief.context-forecast.test.ts` | New — at_risk integration + null/budgetTotal invariant. |
| `apps/api/tests/brief.prompts-english.test.ts` | New — no-Hangul guard on the three exported string constants. |
| `apps/api/tests/chat.brief.test.ts` | Modify — anti-repetition (`recent_briefs`) test; fix the existing `WorkspaceContext` literal for the new type. |

**Test commands** (this repo): run a single api test file with
`pnpm nx test api -- <substring>`; typecheck with `pnpm nx typecheck api`
(plain `tsc` is a no-op here). If nx errors with "Failed to process project
graph", run `npx nx reset` once and retry.

---

## Task 1: `summarizeForecast` pure mapper + unit tests

**Files:**
- Modify: `apps/api/src/analysis/forecast.ts:146` (export `round2`)
- Modify: `apps/api/src/chat/brief-context.ts` (add types + mapper near the top, after imports)
- Test: `apps/api/tests/brief.forecast-summary.test.ts` (create)

- [ ] **Step 1: Export `round2`**

In `apps/api/src/analysis/forecast.ts`, change line 146 from:

```ts
function round2(n: number): number {
```

to:

```ts
export function round2(n: number): number {
```

- [ ] **Step 2: Write the failing unit test**

Create `apps/api/tests/brief.forecast-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeForecast } from "../src/chat/brief-context.js";
import type { MonthEndForecast, CategoryForecast } from "../src/analysis/forecast.js";
import type { RiskTier } from "@fina/shared";

// Build a CategoryForecast fixture; only the fields summarizeForecast reads matter.
function cat(
  categoryName: string,
  severity: RiskTier,
  projectedOverspend: number,
  projected = 0,
  cap = 0,
): CategoryForecast {
  return {
    categoryId: categoryName.toLowerCase(),
    categoryName,
    cap,
    spent: 0,
    fixedBills: 0,
    plannedOneOffs: 0,
    discRate: 0,
    daysLeft: 10,
    projected,
    projectedOverspend,
    projectedUnderspend: 0,
    runwayDay: null,
    severity,
    typicalAmount: 0,
  };
}

function forecast(
  portfolio: MonthEndForecast["portfolio"],
  categories: CategoryForecast[] = [],
  daysLeft = 10,
): MonthEndForecast {
  return { year: 2026, month: 5, daysLeft, categories, portfolio };
}

describe("summarizeForecast", () => {
  it("on_track portfolio: zero overspend, empty topRisks, hasHistory true", () => {
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 200, scheduled: 0, projected: 800, severity: "on_track" }),
      "CAD",
    );
    expect(out.portfolio).not.toBeNull();
    expect(out.portfolio!.severity).toBe("on_track");
    expect(out.portfolio!.overspend).toBe("$0.00");
    expect(out.portfolio!.cap).toBe("$1,000.00");
    expect(out.topRisks).toEqual([]);
    expect(out.hasHistory).toBe(true);
    expect(out.daysLeft).toBe(10);
  });

  it("at_risk portfolio: caps topRisks at 3, sorted by overspend desc, drops lowest qualifier", () => {
    const out = summarizeForecast(
      forecast(
        { cap: 1000, spent: 1300, scheduled: 0, projected: 1300, severity: "at_risk" },
        [
          cat("A", "at_risk", 300, 800, 500),
          cat("B", "at_risk", 500, 1000, 500),
          cat("C", "at_risk", 100, 600, 500),
          cat("D", "watch", 50, 530, 500),
          cat("E", "on_track", 0, 100, 500),
          cat("F", "insufficient_history", 0, 0, 0),
        ],
      ),
      "CAD",
    );
    expect(out.topRisks.map((r) => r.category)).toEqual(["B", "A", "C"]); // desc by overspend, top 3
    // D (lowest qualifier) dropped; on_track + insufficient_history excluded
    expect(out.topRisks.every((r) => r.severity === "watch" || r.severity === "at_risk")).toBe(true);
  });

  it("cap<=0: portfolio null but topRisks + daysLeft survive", () => {
    const out = summarizeForecast(
      forecast(
        { cap: 0, spent: 0, scheduled: 0, projected: 0, severity: "on_track" },
        [cat("Dining", "at_risk", 200, 700, 500)],
        7,
      ),
      "CAD",
    );
    expect(out.portfolio).toBeNull();
    expect(out.topRisks.map((r) => r.category)).toEqual(["Dining"]);
    expect(out.daysLeft).toBe(7);
  });

  it("cap>0 but projected 0: portfolio present, hasHistory false", () => {
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 0, scheduled: 0, projected: 0, severity: "on_track" }),
      "CAD",
    );
    expect(out.portfolio).not.toBeNull();
    expect(out.portfolio!.severity).toBe("on_track");
    expect(out.hasHistory).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm nx test api -- brief.forecast-summary`
Expected: FAIL — `summarizeForecast` is not exported / not defined.

- [ ] **Step 4: Implement `formatMoney`, `BriefForecast`, `summarizeForecast`**

In `apps/api/src/chat/brief-context.ts`, add this import at the top (only what
the mapper uses — `projectMonthEnd` is added in Task 2, and `RiskTier` is not
needed because `BriefForecast` uses inline literal unions; importing either now
would be an unused import in this task's commit):

```ts
import { round2, type MonthEndForecast, type CategoryForecast } from "../analysis/forecast.js";
```

Then add, after the imports and before `export type WorkspaceContext`:

```ts
/** Format a number as display currency, mirroring apps/mobile/src/format/money.ts
 *  (locale "en-CA") for app-wide parity. Do NOT switch to en-US — matching the
 *  client is intentional. Falls back gracefully on an unknown ISO code. */
function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Server-internal forecast summary fed to Gemini (never a client DTO). All
 *  amounts are display-formatted so the prompt uses them verbatim. */
export type BriefForecast = {
  daysLeft: number;
  /** False when projected === 0 (brand-new workspace, no spend + no 90-day avg). */
  hasHistory: boolean;
  portfolio: {
    cap: string;
    projected: string;
    overspend: string; // "$0.00" when not over
    severity: "on_track" | "watch" | "at_risk";
  } | null; // null ⇔ no positive total cap (no plan OR totalAmount<=0)
  topRisks: Array<{
    category: string;
    projected: string;
    cap: string;
    overspend: string;
    severity: "watch" | "at_risk";
  }>;
};

/** Pure mapper: MonthEndForecast + currency → BriefForecast. No DB, no clock. */
export function summarizeForecast(f: MonthEndForecast, currency: string): BriefForecast {
  const hasHistory = f.portfolio.projected > 0;
  const portfolio =
    f.portfolio.cap > 0
      ? {
          cap: formatMoney(f.portfolio.cap, currency),
          projected: formatMoney(f.portfolio.projected, currency),
          overspend: formatMoney(Math.max(0, round2(f.portfolio.projected - f.portfolio.cap)), currency),
          severity: f.portfolio.severity as "on_track" | "watch" | "at_risk",
        }
      : null;
  const topRisks = f.categories
    .filter(
      (c): c is CategoryForecast & { severity: "watch" | "at_risk" } =>
        c.severity === "watch" || c.severity === "at_risk",
    )
    .sort((a, b) => b.projectedOverspend - a.projectedOverspend)
    .slice(0, 3)
    .map((c) => ({
      category: c.categoryName,
      projected: formatMoney(c.projected, currency),
      cap: formatMoney(c.cap, currency),
      overspend: formatMoney(c.projectedOverspend, currency),
      severity: c.severity,
    }));
  return { daysLeft: f.daysLeft, hasHistory, portfolio, topRisks };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm nx test api -- brief.forecast-summary`
Expected: PASS (4 tests). If `$1,000.00` assertions fail, confirm Node has full ICU (Node 22 default) — the value should render with the comma + `$`.

- [ ] **Step 6: Backfill the portfolio run-rate engine test (coverage the monthly brief relies on)**

The monthly brief frames the projection off `recentMonthlyAvgSpend` via
`projectMonthEnd`'s `Math.max(committedTotal, monthlyAvg)` branch, which today
has no direct test. Add one to the existing `describe("projectMonthEnd", ...)`
block in `apps/api/tests/analysis.forecast.test.ts` (it already runs under
`vi.setSystemTime("2026-05-15T12:00:00Z")` with `plan(cap)` and
`spend(amount, day)` helpers). This test characterizes already-shipped engine
behavior, so it is expected to **PASS on first run** (not fail-first):

```ts
  it("portfolio projection uses the trailing-90-day average when it exceeds committed spend", async () => {
    await plan(2000); // helper sets totalAmount "9000.00", Dining cap 2000
    // Heavy prior-90-day spend, nothing this month → monthlyAvg (~2000) > committed (~0)
    for (const day of ["2026-03-10", "2026-03-25", "2026-04-10", "2026-04-25"]) {
      await spend("1500.00", `${day}T12:00:00Z`);
    }
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    expect(f.portfolio.spent).toBeCloseTo(0, 0);
    expect(f.portfolio.projected).toBeGreaterThan(f.portfolio.spent + f.portfolio.scheduled);
    expect(f.portfolio.projected).toBeGreaterThan(0);
  });
```

Run: `pnpm nx test api -- analysis.forecast`
Expected: PASS (the new case + all existing forecast tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/analysis/forecast.ts apps/api/src/chat/brief-context.ts apps/api/tests/brief.forecast-summary.test.ts apps/api/tests/analysis.forecast.test.ts
git commit -m "feat(brief): summarizeForecast pure mapper (display-formatted BriefForecast)"
```

---

## Task 2: Wire `forecast` into the brief context + integration test

**Files:**
- Modify: `apps/api/src/chat/brief-context.ts` (`WorkspaceContext` type, `buildBriefContext`, `buildWorkspaceContext`)
- Modify: `apps/api/tests/chat.brief.test.ts` (fix existing `WorkspaceContext` literal)
- Test: `apps/api/tests/brief.context-forecast.test.ts` (create)

- [ ] **Step 1: Confirm `deviation` has no readers**

Run: `grep -rn "\.deviation" apps libs`
Expected: only the `deviation` field declaration and the `deviation: null`
literals (no real consumer). If a real reader appears, keep the field and skip
its removal below.

- [ ] **Step 2: Write the failing integration test**

Create `apps/api/tests/brief.context-forecast.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildBriefContext } from "../src/chat/brief-context.js";

beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnect();
});

// Mirror chat.brief-context.test.ts clock handling: real clock, firstOfMonth at noon UTC.
function thisMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return { y, m, firstOfMonth: new Date(Date.UTC(y, m - 1, 1, 12, 0, 0)) };
}

describe("buildBriefContext forecast", () => {
  it("at_risk portfolio + topRisks via the spent path (day-independent)", async () => {
    const { firstOfMonth } = thisMonth();
    const u = await prisma.user.create({
      data: { id: `fc-${Date.now()}`, email: `fc-${Date.now()}@t.co`, name: "FC", tz: "UTC" },
    });
    const ws = await prisma.workspace.create({ data: { name: "W", currency: "CAD" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    const dining = await prisma.category.create({ data: { workspaceId: ws.id, name: "Dining" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: ws.id, name: "Chq", type: "depository", currency: "CAD" } });
    // total cap 1000, Dining cap 500; 1300 spent on Dining → 1300 > 1.1*1000 → portfolio at_risk
    await prisma.budgetPlan.create({
      data: { workspaceId: ws.id, periodStart: firstOfMonth, totalAmount: "1000.00", categoryAllocations: [{ categoryId: dining.id, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: ws.id, accountId: acct.id, amount: "1300.00", merchantRaw: "Resto", occurredAt: firstOfMonth, source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining.id, amount: "1300.00" } });

    const ctx = await buildBriefContext(u.id, "daily");
    const w = ctx.workspaces[0]!;
    expect(w.forecast.portfolio).not.toBeNull();
    expect(w.forecast.portfolio!.severity).toBe("at_risk");
    expect(w.forecast.topRisks.map((r) => r.category)).toContain("Dining");
    // Invariant: portfolio===null iff budgetTotal===null (positive-cap case → both non-null)
    expect(w.forecast.portfolio === null).toBe(w.budgetTotal === null);
  });

  it("zero total cap → forecast.portfolio null AND budgetTotal null (invariant)", async () => {
    const { firstOfMonth } = thisMonth();
    const u = await prisma.user.create({
      data: { id: `fc0-${Date.now()}`, email: `fc0-${Date.now()}@t.co`, name: "FC0", tz: "UTC" },
    });
    const ws = await prisma.workspace.create({ data: { name: "W0", currency: "CAD" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await prisma.budgetPlan.create({
      data: { workspaceId: ws.id, periodStart: firstOfMonth, totalAmount: "0.00", categoryAllocations: [] },
    });

    const ctx = await buildBriefContext(u.id, "daily");
    const w = ctx.workspaces[0]!;
    expect(w.forecast.portfolio).toBeNull();
    expect(w.budgetTotal).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm nx test api -- brief.context-forecast`
Expected: FAIL — `w.forecast` is `undefined` (field not yet on `WorkspaceContext`).

- [ ] **Step 4: Add the `forecast` field to `WorkspaceContext` and remove `deviation`**

In `apps/api/src/chat/brief-context.ts`, in the `WorkspaceContext` type, replace the trailing `deviation` field:

```ts
  /** Pace deviation summary (one sentence). */
  deviation: string | null;
```

with:

```ts
  /** Month-end forecast summary (server-internal; fed to Gemini). Always
   *  present; only `portfolio` is nullable (no positive total budget). */
  forecast: BriefForecast;
```

- [ ] **Step 5: Thread `userId` + `now` and compute `forecast` in `buildWorkspaceContext`**

In `buildWorkspaceContext`, update the signature to accept `userId` and `now`:

```ts
async function buildWorkspaceContext(
  workspaceId: string,
  ws: { id: string; name: string; currency: string },
  briefType: BriefType,
  tz: string,
  userId: string,
  now: Date,
): Promise<WorkspaceContext> {
```

Remove the local `const now = new Date();` line (now passed in). Keep
`const nowInUserTz = partsInTz(now, tz);` (it already uses `now`).

First add `projectMonthEnd` to the forecast import (Task 1 imported only
`round2` + types):

```ts
import { projectMonthEnd, round2, type MonthEndForecast, type CategoryForecast } from "../analysis/forecast.js";
```

Then, after the `budgetsFmt`/`budgetTotal` block and before the `return`, add:

```ts
  const monthEnd = await projectMonthEnd(workspaceId, userId, nowInUserTz.year, nowInUserTz.month, now);
  const forecast = summarizeForecast(monthEnd, ws.currency);
```

> Note: passing `now` aligns `year/month/daysLeft` with the brief's clock. The
> trailing-90-day window helpers inside `projectMonthEnd`
> (`recentMonthlyAvgSpend`, `recentTypicalAmountByCategory`,
> `recentDiscretionaryDailyByCategory`) still read `serverNow()` internally, not
> this `now` — in production both equal `new Date()`, and the integration test
> uses the real clock, so they agree. (Fully unifying the clock is out of scope.)

In the returned object, replace `deviation: null,` with `forecast,`.

- [ ] **Step 6: Pass `userId` + `now` from `buildBriefContext`**

In `buildBriefContext`, the loop currently calls
`buildWorkspaceContext(m.workspaceId, m.workspace, briefType, tz)`. Add a single
`now` for the whole context and thread both args:

```ts
  const now = new Date();
  const workspaces: WorkspaceContext[] = [];
  for (const m of memberships) {
    workspaces.push(
      await buildWorkspaceContext(m.workspaceId, m.workspace, briefType, tz, userId, now),
    );
  }
```

(`userId` is the function parameter; `dateIso` above can keep using its own
`new Date()` — unchanged.)

- [ ] **Step 7: Fix the existing `WorkspaceContext` literal in `chat.brief.test.ts`**

In `apps/api/tests/chat.brief.test.ts`, the first `generateBrief` test ("emits a
single text PresentationBlock") builds a workspace literal at lines 57–67. That
literal currently has fields `id, name, currency, newTransactions,
uncategorizedCount, schedule, budgets, recurring, deviation` — it does **not**
contain a `budgetTotal` field, and `budgetTotal` is a required field on
`WorkspaceContext`. Replace the single line `deviation: null,` with BOTH lines
so the literal is a complete `WorkspaceContext`:

```ts
          budgetTotal: null,
          forecast: { daysLeft: 10, hasHistory: false, portfolio: null, topRisks: [] },
```

(This is unconditional — do not skip `budgetTotal`.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm nx test api -- brief.context-forecast`
Expected: PASS (2 tests).
Run: `pnpm nx typecheck api`
Expected: PASS — no `deviation`/`forecast` type errors in `src/`. NOTE: this
target runs `tsc --noEmit -p apps/api/tsconfig.app.json`, whose `include` is
`src/**/*.ts` only — it does **not** typecheck `tests/**`. So the
`chat.brief.test.ts` literal is **not** validated here; its correctness is
verified by the test running green in the next step (Vitest/esbuild strips
types, so keeping the literal in sync with the new required fields is what
matters, confirmed by the pre-existing test still passing).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/chat/brief-context.ts apps/api/tests/brief.context-forecast.test.ts apps/api/tests/chat.brief.test.ts
git commit -m "feat(brief): attach month-end forecast to brief context (drop dead deviation)"
```

---

## Task 3: English brief prompts + anti-repetition test

**Files:**
- Modify: `apps/api/src/chat/brief.ts`
- Test: `apps/api/tests/brief.prompts-english.test.ts` (create), `apps/api/tests/chat.brief.test.ts` (add one test)

- [ ] **Step 1: Write the failing no-Hangul test**

Create `apps/api/tests/brief.prompts-english.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  SYSTEM_PROMPT_PER_TYPE,
  USER_INSTRUCTION,
  EMPTY_BRIEF_FALLBACK,
} from "../src/chat/brief.js";

// Conjoining jamo (U+1100–11FF) + compatibility jamo (U+3130–318F) +
// full syllable block (U+AC00–D7A3, through 힣). The old ㄱ-힝 range stopped
// 6 codepoints short.
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;

describe("brief LLM strings are English (no Hangul)", () => {
  it("system prompts contain no Hangul", () => {
    for (const v of Object.values(SYSTEM_PROMPT_PER_TYPE)) {
      expect(HANGUL.test(v)).toBe(false);
    }
  });
  it("user instruction + fallback contain no Hangul", () => {
    expect(HANGUL.test(USER_INSTRUCTION)).toBe(false);
    expect(HANGUL.test(EMPTY_BRIEF_FALLBACK)).toBe(false);
  });

  // Contract anchors: every per-type prompt carries the RULES block, so each
  // must mention the forecast-first contract. A deleted RULES paragraph fails
  // here (the only deterministic guard on the prompt contract below the LLM).
  it("system prompts state the forecast-first contract anchors", () => {
    for (const v of Object.values(SYSTEM_PROMPT_PER_TYPE)) {
      expect(v).toContain("forecast.portfolio");
      expect(v).toContain("forecast.topRisks");
      expect(v).toContain("hasHistory");
      expect(v).toContain("at_risk");
      expect(v).toContain("highest-risk workspace");
      expect(v).toContain("ask me for a plan to stay on track");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm nx test api -- brief.prompts-english`
Expected: FAIL — `USER_INSTRUCTION`/`EMPTY_BRIEF_FALLBACK` not exported (and
current strings contain Hangul).

- [ ] **Step 3: Rewrite `SYSTEM_PROMPT_PER_TYPE` in English**

In `apps/api/src/chat/brief.ts`, replace the entire `SYSTEM_PROMPT_PER_TYPE`
constant with:

```ts
const RULES = `You are Fina, a warm, proactive personal-finance assistant. Write the brief in English.

Money: Amounts in forecast (forecast.portfolio.* and forecast.topRisks[].*) are already display-formatted (e.g. "$1,000.00"). Use them verbatim. Never prepend a currency code or invent a symbol.

Headline = the month-end forecast of the TOTAL budget. forecast.portfolio tells you whether, at the current pace, the user will finish the month over or under their overall budget. Lead with this, NOT with spend-so-far.
- portfolio.severity "on_track": reassure in ONE short clause (e.g. "On pace to finish the month comfortably under budget"). On days with notable activity, fold it into the activity sentence rather than leading with it — keep it light so a daily reader never feels nagged.
- "watch": a gentle heads-up that you're trending close to the limit.
- "at_risk": lead with the warning sign and the projected overspend (forecast.portfolio.overspend), then name the top 1-3 categories from forecast.topRisks as where it's leaking. End with ONE short offer for a plan, phrased in second person and referring to Fina by behavior, not by UI (the line also appears on a lock-screen push with no buttons) — e.g. "Open Fina and ask me for a plan to stay on track." Do not write the plan yourself, promise a button or link, or invent schedule dates.

Top-risk categories are computed independently of the total: a single category can be over its own cap while the TOTAL stays on_track or watch. If forecast.topRisks is non-empty even when the portfolio is on_track or watch, mention the worst 1-2 in a brief "keep an eye on ..." aside, but keep the total-budget verdict as the headline.

No history: if forecast.portfolio is present but forecast.hasHistory is false (brand-new workspace, no spend and no typical-month average yet), do NOT claim "on track to finish under budget". Instead note you're still learning their pace and state the budget (e.g. "You're just getting started — your budget this month is {cap}.").

No budget: if forecast.portfolio is null, skip the forecast line entirely and just cover activity + encouragement.

One workspace (the common case): do NOT name the workspace or use any ranking/comparison language — write the forecast as a direct personal statement ("You're on pace ..."). Multiple workspaces: lead with the highest-risk workspace (rank by severity at_risk > watch > on_track, ties broken by larger overspend) and mention the others in one brief clause.

Always include the total-budget verdict (unless no budget), but vary the wording from recent_briefs — never reuse a sentence shape two days running.`;

const SYSTEM_PROMPT_PER_TYPE: Record<BriefType, string> = {
  daily: `${RULES}

This is the DAILY brief (3-5 sentences). Weave in yesterday's activity and anything scheduled today. If a transaction needs categorizing, mention it in one line. Close with brief encouragement. Markdown allowed.`,
  weekly: `${RULES}

This is the WEEKLY brief (5-7 sentences, Monday morning). It's the start of a new week. Recap last week, note this week's schedule, and frame the forecast for the rest of the month. Encourage naturally.`,
  monthly: `${RULES}

This is the MONTHLY brief (6-8 sentences, 1st of the month). It's a new month — spend is near zero, so frame forecast.portfolio.projected as "based on your typical months, here's how this budget is likely to go" (respect the No history rule for new workspaces). If the projection already exceeds the cap, give an early, calm heads-up to trim. Cover this month's schedule and the next 30 days of recurring bills. Encourage.`,
};
```

- [ ] **Step 4: Extract + translate + export `USER_INSTRUCTION` and `EMPTY_BRIEF_FALLBACK`**

In `apps/api/src/chat/brief.ts`, add two exported constants near the top
(after `SYSTEM_PROMPT_PER_TYPE`):

```ts
export const USER_INSTRUCTION =
  "Using the context above, write the brief as markdown text only. Emit exactly one text presentation block.";

export const EMPTY_BRIEF_FALLBACK = "Good morning ☀️ Have a great day!";
```

Also export the prompt map so the test can read it — change
`const SYSTEM_PROMPT_PER_TYPE` to `export const SYSTEM_PROMPT_PER_TYPE`.

In `buildUserMessage`, replace the inline Korean instruction:

```ts
    instruction: "위 context를 보고 brief를 markdown text로만 작성해. presentation block은 text 한 개만 emit해.",
```

with:

```ts
    instruction: USER_INSTRUCTION,
```

In `generateBrief`, replace the Korean fallback block:

```ts
    return [{ type: "text", markdown: "좋은 아침이야 ☀️ 오늘도 잘 보내!" }];
```

with:

```ts
    return [{ type: "text", markdown: EMPTY_BRIEF_FALLBACK }];
```

- [ ] **Step 5: Run the no-Hangul test to verify it passes**

Run: `pnpm nx test api -- brief.prompts-english`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the anti-repetition test (no change to the top-level mock)**

In `apps/api/tests/chat.brief.test.ts`, add a test inside the
`describe("generateBrief (mocked LLM)", ...)` block that asserts `recent_briefs`
reaches Gemini. **Do NOT touch the top-level `vi.mock` (lines 5–13)** — instead
override it for this one call with a local capture fn, exactly like the existing
"falls back to encouragement" test does (`mockImplementationOnce`). This keeps
the other tests' default mock intact. Pass `workspaces: []` so the test needs no
`WorkspaceContext` literal:

```ts
  it("passes recent_briefs through to Gemini (anti-repetition input)", async () => {
    const mod = await import("@google/genai");
    const captureGenerate = vi.fn().mockResolvedValue({ text: "Brief body." });
    vi.mocked(mod.GoogleGenAI).mockImplementationOnce(() => ({
      models: { generateContent: captureGenerate },
    }) as unknown as InstanceType<typeof mod.GoogleGenAI>);

    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");

    await generateBrief(
      testEnv(),
      { user: { id: "u1", name: "Brian", tz: "America/Toronto", morningTime: "08:00" }, briefType: "daily", date: "2026-05-22", workspaces: [] },
      ["BRIEF_FROM_YESTERDAY_MARKER"],
      "daily",
    );

    const sentJson = JSON.stringify(captureGenerate.mock.calls[0]?.[0]);
    expect(sentJson).toContain("BRIEF_FROM_YESTERDAY_MARKER");
  });
```

- [ ] **Step 6b: Update the pre-existing fallback assertion to the English string**

Task 3 Step 4 changed `EMPTY_BRIEF_FALLBACK` to English, so the existing "falls
back to encouragement when LLM returns empty" test — which asserts the Korean
`좋은 아침` — now fails for a real reason. Update it to track the constant:

- Change the import on line 2 of `apps/api/tests/chat.brief.test.ts` to also
  import the constant:
  ```ts
  import { briefBlocksToText, EMPTY_BRIEF_FALLBACK } from "../src/chat/brief.js";
  ```
- In that test, replace the assertion:
  ```ts
  expect((blocks[0] as { markdown: string }).markdown).toContain("좋은 아침");
  ```
  with:
  ```ts
  expect((blocks[0] as { markdown: string }).markdown).toBe(EMPTY_BRIEF_FALLBACK);
  ```

The first "emits a single text PresentationBlock" test is **NOT** affected — the
top-level mock is unchanged, so its `toContain("Starbucks")` still holds.

- [ ] **Step 7: Run the brief test file**

Run: `pnpm nx test api -- chat.brief`
Expected: PASS — every test in the file: the new anti-repetition test, the
updated fallback test (now asserting the English `EMPTY_BRIEF_FALLBACK`), and the
unchanged "Starbucks" test (its top-level mock was left intact).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/chat/brief.ts apps/api/tests/brief.prompts-english.test.ts apps/api/tests/chat.brief.test.ts
git commit -m "feat(brief): English forecast-first prompts + anti-repetition test"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the API**

Run: `pnpm nx typecheck api`
Expected: PASS. (Pre-existing unrelated errors, if any, are out of scope — but
nothing in `brief*.ts`/`forecast.ts`/`brief*` tests.)

- [ ] **Step 2: Run the whole brief + forecast test surface**

Run: `pnpm nx test api -- brief forecast cron.daily-brief`
Expected: PASS. The `cron.daily-brief.*` tests stay green: they mock the LLM
(English text, or stub `generateBrief` entirely) so the prompt-language change
doesn't touch them, and `buildBriefContext` only gained a field. (Note:
`cron.daily-brief.e2e.test.ts` mocks the LLM with a Korean string and asserts
`/Starbucks/` on it — that's mock *input*, unaffected by our prompt rewrite, and
not subject to the no-Hangul guard which only checks the source prompt
constants. Leave it.) These tests also now exercise the new `projectMonthEnd`
call inside `buildWorkspaceContext` against their seeds — confirm none throws.

- [ ] **Step 3: Manual on-demand smoke (optional, dev DB)**

With the dev API running, generate a brief immediately for the dev user via a
throwaway script (no code added to the repo) to eyeball the English,
total-first output:

```bash
cat > apps/api/_brief_smoke.ts <<'EOF'
import { buildBriefContext } from "./src/chat/brief-context.js";
import { generateBrief, briefBlocksToText } from "./src/chat/brief.js";
import { prisma } from "./src/db.js";
import { loadEnv } from "./src/env.js";
(async () => {
  const u = await prisma.user.findFirst({ where: { email: "cwsbrian@gmail.com" } });
  const ctx = await buildBriefContext(u!.id, "daily");
  console.dir(ctx.workspaces[0]?.forecast, { depth: null });
  const blocks = await generateBrief(loadEnv(), ctx, [], "daily");
  console.log("\n--- BRIEF ---\n" + briefBlocksToText(blocks));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
EOF
DATABASE_URL="postgresql://fina:fina@localhost:5433/fina" pnpm --filter @fina/api exec tsx _brief_smoke.ts
rm -f apps/api/_brief_smoke.ts
```

Expected: the `forecast` object prints with display-formatted amounts; the brief
text is English and leads with the total-budget verdict. (If `loadEnv` is not
the env accessor name, use the same import the cron uses.)

- [ ] **Step 4: Commit (if any verification tweak was needed)**

Only commit if a fix was required; otherwise nothing to do.

---

## Self-review notes (author)

- **Spec coverage:** Task 1 → `summarizeForecast` + currency formatting +
  hasHistory + narrowed severities + null portfolio. Task 2 → context wiring,
  `projectMonthEnd(..., now)` clock alignment, dead `deviation` removal,
  invariant test, at_risk seed recipe. Task 3 → English (all three strings),
  total-first/anti-nag/single-vs-multi/topRisks-independent/invite rules,
  no-Hangul guard, anti-repetition test. Task 4 → typecheck + suite + smoke.
- **No placeholders:** every code + test block is complete; commands have
  expected output.
- **Type consistency:** `BriefForecast` / `summarizeForecast(f, currency)` /
  `forecast: BriefForecast` (non-null) / `buildWorkspaceContext(..., userId,
  now)` are used identically across tasks.
- **Accepted-risk (no deterministic test):** the multi-workspace
  "highest-risk-first" ordering and the on_track/at_risk *phrasing* are pure
  LLM-prompt instructions with no seam below the model, so they are guarded only
  by the contract-anchor presence test (Task 3 Step 1), not by output
  assertions. Verified by eye in the Task 4 Step 3 smoke run.
- **Adversarial review:** this plan folds in 12 confirmed findings from a 4-lens
  plan review (the EMPTY_BRIEF_FALLBACK / Starbucks pre-existing-assertion
  breakage, the unconditional `budgetTotal` literal fix, the typecheck-scope
  correction, the prompt-anchor + run-rate coverage gaps, the intermediate-commit
  unused-import fix, and the serverNow clock note).
