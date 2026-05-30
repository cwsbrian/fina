# Daily/Weekly/Monthly Brief — Total-First Forecast & Risk Design

**Date:** 2026-05-30
**Status:** Design (approved in brainstorming; revised after adversarial spec review — 20 confirmed findings folded in)
**Backlog:** Task #4 — "Make the daily brief proactively surface forecast/risk insights"

## Goal

The morning brief currently reports **current** budget spend (`spent / cap`,
percent-to-date). This spec makes every brief **lead with the month-end
forecast of the TOTAL budget** — "at this pace, will you finish the month
over or under your overall budget?" — name the top leaking categories as the
"where", and, when at risk, invite the user to ask Fina for a plan. The brief
is rewritten in **English** (North-America launch), and the forecast appears
in **all three** brief types (daily / weekly / monthly), with tone scaling to
risk and the line shown **every** brief (not only when at risk).

This extends the forecasting posture already shipped for the chat advisor
(Phase 2 forecasting + Phase 3 proactive planning) to the system-initiated
brief, so the push-notification body itself becomes the forecast headline.

## Decisions (from brainstorming)

1. **Proactivity** — surface the risk + a one-line invite to ask Fina for a
   plan. Do **not** auto-generate a `plan_proposal_card` inside the brief.
2. **Cadence** — **always** include the total forecast; scale tone by
   severity (calm on_track → ⚠️ at_risk). Vary wording via anti-repetition.
3. **Language** — **English** brief text (all LLM-authored strings in
   `brief.ts`, not just the system prompts).
4. **Brief types** — forecast in **daily + weekly + monthly**, framed per
   type. Monthly (the 1st) frames the projection as "based on your typical
   months" — and, for a brand-new workspace with no history, as "still
   learning your pace".

## Shared library touchpoints

**USES (existing `@fina/shared` / internal exports):**
- `RiskTier` (`@fina/shared` — `enums.ts`): severity union
  (`on_track | watch | at_risk | insufficient_history`). Already shared,
  consumed by `dto/chat.ts` (`RecapBlock` severity).
- `projectMonthEnd` + `MonthEndForecast` / `CategoryForecast`
  (`apps/api/src/analysis/forecast.ts`) — API-internal forecast engine.
- `text` `PresentationBlock` (`@fina/shared` — `dto/chat.ts`): the brief
  output stays a single `text` block.

**CREATES — No shared additions needed.** Rationale:
- The brief surfaces the forecast as **LLM-authored markdown** in the
  existing `text` block — no new presentation block (decision #1: no card).
- The new `BriefForecast` type + `forecast` field on `WorkspaceContext` are
  **server-internal**: built in `brief-context.ts`, fed to Gemini as JSON
  input, **never serialized to a client as a typed DTO**.
- Severity reuses the already-shared `RiskTier`.
- Money formatting mirrors the client's existing `Intl.NumberFormat` pattern
  (`apps/mobile/src/format/money.ts`); there is no shared money formatter
  today and this spec does not introduce one (single server-side consumer).

(Per CLAUDE.md this section is mandatory; the CREATES list is intentionally
empty with the reasons above. The adversarial review's shared-touchpoints
lens confirmed no shared addition is warranted.)

## Architecture

Reuse the Phase 2/3 forecast engine (`projectMonthEnd`) inside the brief
context builder; add a compact server-internal `forecast` summary to the
context; rewrite **all** LLM-authored strings in `brief.ts` in English so the
brief leads with the total forecast, scales tone, surfaces top-risk
categories, and (at risk) invites a plan. No new shared types, no new DB
columns, no new presentation block, no engine change.

### Data flow

```
runDailyBrief (cron, unchanged)
  └─ buildBriefContext(userId, briefType)
       └─ buildWorkspaceContext(workspaceId, ws, briefType, tz, userId, now)   ← userId + now threaded
            ├─ budgetPlanSnapshot(...)                       (existing — current spend)
            ├─ projectMonthEnd(workspaceId, userId, year, month, now)   ← NEW call, SAME `now`
            │     (note: re-fetches budgetPlanSnapshot internally — accepted; daily
            │      cron, not a hot path. SAME `now` passed so month + daysLeft come
            │      from one clock — see "Clock source" below.)
            └─ summarizeForecast(monthEnd, ws.currency)       ← NEW pure mapper → context.forecast
  └─ generateBrief(env, context, recentTexts, briefType)
       └─ English system prompt leads with context.forecast   ← REWRITTEN
  └─ (unchanged) emit text block to thread + sendBriefPush(preview)
       preview = markdownToPlainPreview(briefBlocksToText(blocks))  ← two-step (see Component 4)
                = forecast headline
```

**Clock source.** `buildWorkspaceContext` derives the current month from
wall-clock `new Date()` (existing behavior, line 88/145), and the brief cron
gates on `new Date()` too — the brief pipeline does **not** use
`serverNow()`/`DEV_NOW`. `projectMonthEnd` *defaults* its `now` to
`serverNow()`, which would diverge from the brief's `new Date()` under
`DEV_NOW` or `vi.setSystemTime`. To eliminate the mismatch, we pass the brief's
own `now` (`new Date()`) as `projectMonthEnd`'s 5th arg, so `year/month` and
`daysLeft` are derived from a single instant. (Making the whole brief honor
`serverNow()` is out of scope.)

### Component 1 — `summarizeForecast` (pure mapper)

New exported pure function in `apps/api/src/chat/brief-context.ts`. Maps
`MonthEndForecast` + workspace currency → the brief shape. Pure (no DB, no
clock) so it is unit-testable with synthetic inputs. **Amounts are
display-formatted server-side** (the prompt never sees a raw ISO currency
code — see finding [13]).

```ts
// Mirrors apps/mobile/src/format/money.ts (locale "en-CA") for app-wide parity.
// en-CA renders CAD as "$120.00" and USD as "US$120.00" — matching the client
// is intentional; do NOT switch to en-US.
function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`; // unknown ISO code → graceful fallback
  }
}

export type BriefForecast = {
  daysLeft: number;
  /** False for a brand-new workspace with no spend AND no trailing-90-day
   *  average (projected === 0). Lets the prompt avoid a misleading
   *  "on track to finish under budget" when there is simply no data yet. */
  hasHistory: boolean;
  portfolio: {
    cap: string;        // display-formatted, e.g. "$1,000.00"
    projected: string;
    overspend: string;  // formatMoney(max(0, projected - cap)); "$0.00" when not over
    severity: "on_track" | "watch" | "at_risk"; // portfolio is never insufficient_history
  } | null;             // null ⇔ no positive total cap — see "null trigger" below
  topRisks: Array<{
    category: string;   // CategoryForecast.categoryName
    projected: string;
    cap: string;
    overspend: string;  // formatMoney(CategoryForecast.projectedOverspend)
    severity: "watch" | "at_risk"; // narrowed: only these reach topRisks
  }>;
};

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

`round2` exists in `forecast.ts` — export it (or inline `Math.round(x*100)/100`).

**`portfolio` null trigger.** `portfolio === null` iff `f.portfolio.cap <= 0`,
i.e. `parseFloat(snap.totalAmount) <= 0`. This covers BOTH (a) **no BudgetPlan
snapshot at all** (forecast.ts early return sets `cap: 0`) and (b) a snapshot
whose `totalAmount` is 0/blank. Describe it as "no positive total budget", not
"no budget plan". **Invariant:** `forecast.portfolio === null ⇔ budgetTotal
=== null` — both derive from `parseFloat(snapshot.totalAmount) > 0` on the same
`budgetPlanSnapshot`, so they align by construction. This is the one context
where both budget signals reach Gemini together; we assert the invariant in a
test as a regression guard (current code cannot violate it).

### Component 2 — context wiring (`brief-context.ts`)

- `WorkspaceContext.forecast: BriefForecast` — **non-nullable**.
  `summarizeForecast` always returns an object (`daysLeft` + `hasHistory` are
  always meaningful; only the `portfolio` sub-field is nullable). Do **not**
  declare `forecast: BriefForecast | null`.
- Remove the dead `deviation: string | null` field (always `null` today,
  superseded by `forecast`). Implementation step must
  `grep -rn "\.deviation" apps libs` → expect zero reads outside the type +
  the `deviation: null` literal. If any consumer exists, keep the field and
  note it.
- Thread `userId` and the shared `now` (`new Date()`) into
  `buildWorkspaceContext` (both available in `buildBriefContext` /
  already-computed at line 88).
- After `budgetPlanSnapshot`:
  `const monthEnd = await projectMonthEnd(workspaceId, userId, nowInUserTz.year, nowInUserTz.month, now);`
  then `forecast: summarizeForecast(monthEnd, ws.currency)`.

### Component 3 — English rewrite of ALL LLM strings (`brief.ts`)

Three Korean strings exist in `brief.ts`; **all three** become English
(finding [16]):
1. `SYSTEM_PROMPT_PER_TYPE` (the per-type system prompts).
2. The `instruction` line in `buildUserMessage` (line 30).
3. The empty-brief fallback markdown in `generateBrief` (line 71).

Extract (2) and (3) into named module constants
(`USER_INSTRUCTION`, `EMPTY_BRIEF_FALLBACK`) and **export them** so the
no-Hangul test can assert on them.

**Shared RULES block (embedded in every per-type prompt):**

> You are Fina, a warm, proactive personal-finance assistant. Write the brief
> in **English**.
>
> **Money:** Amounts in `forecast` (`forecast.portfolio.*`,
> `forecast.topRisks[].*`) are already display-formatted (e.g. "$1,000.00").
> Use them **verbatim**. Never prepend a currency code or invent a symbol.
>
> **Headline = the month-end forecast of the TOTAL budget.**
> `forecast.portfolio` tells you whether, at the current pace, the user will
> finish the month **over or under** their overall budget. Lead with this, NOT
> with spend-so-far.
> - `portfolio.severity === "on_track"`: reassure in ONE short clause (e.g.
>   "On pace to finish the month comfortably under budget"). On days with
>   notable activity, fold this into the activity sentence rather than leading
>   with it — keep it light so a daily reader never feels nagged.
> - `"watch"`: a gentle heads-up that you're trending close to the limit.
> - `"at_risk"`: lead with ⚠️ and the projected overspend
>   (`forecast.portfolio.overspend`), then name the top 1–3 categories from
>   `forecast.topRisks` as *where* it's leaking. End with ONE short offer for a
>   plan, phrased in second person and referring to Fina by behavior, not by UI
>   (the line also appears on a lock-screen push with no buttons) — e.g. "Open
>   Fina and ask me for a plan to stay on track." Do **not** write the plan
>   yourself, promise a button/link, or invent schedule dates.
>
> **Top-risk categories independent of total.** `forecast.topRisks` is computed
> independently of `portfolio.severity`: a single category can be over its own
> cap while the TOTAL stays on_track/watch. If `topRisks` is non-empty even
> when the portfolio is on_track or watch, mention the worst 1–2 in a brief
> "keep an eye on …" aside — but keep the total-budget verdict as the headline.
>
> **No history.** If `forecast.portfolio` is non-null but
> `forecast.hasHistory === false` (brand-new workspace, no spend and no
> typical-month average yet), do NOT claim "on track to finish under budget".
> Instead note you're still learning their pace and simply state the budget
> (e.g. "You're just getting started — your budget this month is {cap}.").
>
> **No budget.** If `forecast.portfolio` is null, skip the forecast line
> entirely and just cover activity + encouragement.
>
> **One workspace (the common case): do NOT name the workspace or use any
> ranking/comparison language — write the forecast as a direct personal
> statement ("You're on pace …").** Multiple workspaces: lead with the
> workspace at highest risk, ranked by `portfolio.severity` (at_risk > watch >
> on_track), breaking ties by larger `portfolio.overspend`; mention the others
> in one brief clause.
>
> Always include the total-budget verdict (unless no budget), but **vary the
> wording** from `recent_briefs` (the text of your recent briefs) — never reuse
> a sentence shape two days running.

**Per-type framing (appended to the RULES block):**

- **Daily** (3–5 sentences): "Weave in yesterday's activity and anything
  scheduled today. If a transaction needs categorizing, mention it in one line.
  Close with brief encouragement. Markdown allowed."
- **Weekly** (5–7 sentences, Monday): "It's the start of a new week. Recap last
  week, note this week's schedule, and frame the forecast for the rest of the
  month. Encourage naturally."
- **Monthly** (6–8 sentences, 1st): "It's a new month — spend is near zero, so
  frame `forecast.portfolio.projected` as *based on your typical months, here's
  how this budget is likely to go* (and respect the **No history** rule above
  for new workspaces). If the projection already exceeds the cap, give an
  early, calm heads-up to trim. Cover this month's schedule and the next 30
  days of recurring bills. Encourage."

`buildUserMessage` already serializes the whole `context.workspaces` (now
including `forecast`) into the user-role JSON — the `forecast` field flows
through with no other change; only the `instruction` string is translated.

### Component 4 — push (unchanged code)

No code change. The existing push path is **two steps**
(`daily-brief.ts:168-170`): `briefBlocksToText(blocks)` flattens the
`PresentationBlock[]` to raw markdown, then `markdownToPlainPreview(...)` strips
markdown to a plain preview. Because the forecast leads the markdown, the push
body starts with the forecast headline — the desired "proactively surface
forecast/risk" outcome on the lock screen. (The at_risk invite is therefore
written to read sensibly with no tap target — see RULES block.)

## Edge cases

- **No positive total budget** (`portfolio.cap <= 0`: no plan OR `totalAmount`
  0/blank) → `forecast.portfolio = null`; prompt skips the forecast line.
- **`insufficient_history`** category severity → excluded from `topRisks`
  (filter keeps only watch/at_risk). Portfolio severity is never
  `insufficient_history` (computed by `severityFor`).
- **Brand-new workspace** → `hasHistory === false` (projected 0); prompt uses
  the "still learning your pace" framing instead of a false on_track claim.
- **Monthly on the 1st** → `isThisMonth` true, `spent ≈ 0`; projection driven
  by `recentMonthlyAvgSpend` (the **trailing-90-day monthly average** = sum of
  the last ~90 days of positive transactions ÷ 3, **not** a daily run-rate). 0
  for a workspace < ~history → handled by `hasHistory`.
- **Multi-workspace** → per-workspace `forecast`; prompt leads with the
  highest-risk workspace per the ordering above.

## Testing

Repo rule: integration tests use a real DB, no Prisma mocks.

1. **`summarizeForecast` unit tests** (pure, synthetic `MonthEndForecast`;
   amounts asserted as display-formatted strings, e.g. `"$0.00"`):
   - on_track portfolio → `portfolio.severity === "on_track"`, `overspend`
     formats to the zero string, `topRisks` empty, `hasHistory === true`.
   - at_risk portfolio + **5 categories** (3 at_risk, 1 watch, 1 on_track,
     1 insufficient_history) → `topRisks` has **exactly 3** (4 qualifying,
     capped), sorted by `projectedOverspend` desc; assert the dropped entry is
     the lowest-overspend qualifying category (exercises both `.slice(0,3)` and
     the sort at the cut). on_track + insufficient_history excluded.
   - `portfolio.cap === 0` **with ≥1 qualifying category** → `portfolio ===
     null`, `topRisks` non-empty (still sorted/sliced), `daysLeft` preserved —
     proving topRisks/daysLeft survive independently of the nulled portfolio.
   - `hasHistory` false case: `portfolio.cap > 0`, `projected === 0` →
     `portfolio !== null`, `portfolio.severity === "on_track"`,
     `hasHistory === false`.
2. **`buildBriefContext` integration test** (real DB; real clock; single-source
   month). Compute `y/m` from `new Date()` (UTC) exactly like
   `chat.brief-context.test.ts:102-105` and seed into THAT month; do not use
   `vi.setSystemTime`/`DEV_NOW`. **Reproducible at_risk recipe (spent path,
   day-independent):** one workspace; `BudgetPlan` `totalAmount = "1000.00"`
   with one capped category "Dining" `allocated "500.00"`; seed transactions in
   the current month allocated to Dining totaling **1300** (> 1.1 × 1000 → the
   portfolio is at_risk via `totalSpent` regardless of `daysLeft`/run-rate, and
   Dining > 1.1 × 500 → a topRisk). Assert:
   - `workspaces[0].forecast.portfolio.severity === "at_risk"`,
   - `topRisks` contains Dining,
   - the invariant `(forecast.portfolio === null) === (budgetTotal === null)`
     (assert once here for the positive-cap plan; add a second tiny case with a
     `"0.00"` total cap asserting both are null).
3. **English-only regression** (decision #3). Import the three exported brief
   string constants (`SYSTEM_PROMPT_PER_TYPE` values, `USER_INSTRUCTION`,
   `EMPTY_BRIEF_FALLBACK`) and assert NONE contains Hangul using a positive
   multi-block detector asserted false:
   `const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;` (conjoining
   jamo + compatibility jamo + the full syllable block through `힣`/U+D7A3 — the
   old `ㄱ-힝` range stopped 6 codepoints short). Emoji like ⚠️ are outside
   these ranges and pass.
4. **`recent_briefs` survives the rewrite** (decision #2 anti-repetition input
   guard). With `@google/genai` mocked (follow `chat.brief.test.ts`), call
   `generateBrief(env, context, ["BRIEF_FROM_YESTERDAY_MARKER"], "daily")` and
   assert the captured Gemini request `contents` JSON contains the marker.
5. **`deviation` removal** — `nx typecheck api` passes after removal (catches
   any stray consumer at compile time).

## Files

| File | Change |
|---|---|
| `apps/api/src/analysis/forecast.ts` | Export `round2` (if not already) for reuse by `summarizeForecast` |
| `apps/api/src/chat/brief-context.ts` | Add `formatMoney` + `BriefForecast` + `summarizeForecast`; add non-nullable `forecast` to `WorkspaceContext`; remove dead `deviation`; thread `userId` + `now`; call `projectMonthEnd(..., now)` |
| `apps/api/src/chat/brief.ts` | Rewrite `SYSTEM_PROMPT_PER_TYPE` (English, forecast-lead rules); translate + export `USER_INSTRUCTION` and `EMPTY_BRIEF_FALLBACK` |
| `apps/api/tests/brief.forecast-summary.test.ts` | New — `summarizeForecast` unit tests |
| `apps/api/tests/brief.context-forecast.test.ts` | New — integration: at_risk context + invariant |
| `apps/api/tests/brief.prompts-english.test.ts` | New — no-Hangul guard on all three string constants |
| `apps/api/tests/brief.recent-briefs.test.ts` | New (or add to existing `chat.brief.test.ts`) — anti-repetition input guard |

No `@fina/shared`, web, or mobile changes. (Mobile renders the brief via the
existing `text` block; no renderer change.)

## Out of scope

- A dev-only on-demand brief trigger — handled ad hoc via script during dev.
- Auto-proposing a `plan_proposal_card` in the brief (decision #1 rejected it).
- Brief localization beyond English (decision #3).
- Making the brief pipeline honor `serverNow()`/`DEV_NOW`.
- Task #6 push-delivery follow-ups (separate backlog item).
