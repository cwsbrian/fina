# Chat Forecasting Advisor — Design

**Date:** 2026-05-29
**Status:** Approved (brainstorm + multi-lens review folded in)
**Tasks:** #2 (forecast analysis), #3 (proactive planning), #4 (daily-brief surfacing)

---

## Goal

Turn the chat assistant from a reactive Q&A bot into a **proactive
forecasting financial coach**. "이대로 가도 괜찮아?" must **forecast
month-end budget-cap overage risk** — not just report planned-vs-actual —
judge the risk, surface it **before the user asks** (via the daily brief),
and help the user plan their way back under budget.

**In scope:** budget-cap overage forecasting (per category + portfolio),
proactive risk surfacing, multi-item plan proposals in chat.

**Out of scope (deferred):** income / cash-flow / "will I run out of money"
modeling. There is no inflow model today and adding one roughly doubles the
project. v1 answers "will you exceed your caps", on existing data.

---

## Shared library touchpoints

### USES (existing `@fina/shared` + api building blocks)
- `budgetPlanSnapshot`, `monthlyScheduledByCategory`,
  `subscriptionOccurrencesByCategory`, `recentMonthlyAvgSpend`,
  `monthlyTotalSpend` — `apps/api/src/budget-plans/service.ts`
- `occurrencesInRange`, `monthlyEquivalent` — `apps/api/src/recurring/occurrences.ts`
- `partsInTz`, `localMidnightToUtc`, `resolveUserTz` — `apps/api/src/chat/tools/periods.ts`
- `PresentationBlock` (shared union) — `libs/shared/src/dto/chat.ts`
- `PresentationBlock` (local narrow union) — `apps/api/src/chat/blocks.ts`
- `ActionIntent`, `presentConfirmCard`, `CONFIRMABLE_TOOLS` — `apps/api/src/intents/service.ts`, `present-confirm-card.ts`
- `CADENCES`, `BudgetPeriod`, `MAX_AMOUNT` — `@fina/shared`

### CREATES — shared (`libs/shared`)
| Addition | File | Shape / motivation |
|---|---|---|
| `RiskTier` union + `RISK_TIERS` const | `src/enums.ts` | `"on_track" \| "watch" \| "at_risk" \| "insufficient_history"`. Crosses to mobile via the forecast card. |
| `forecast_card` block variant | `src/dto/chat.ts` | per-category projection card (cap, spent, projected, overspend, runwayDay, severity). Mobile renderer required. |
| `plan_proposal_card` block variant | `src/dto/chat.ts` | lists N proposed scheduled spends (category, date, amount) + one `accept_intent`. Mobile renderer required. |
| `ScheduledSpendBatchBody` zod schema | `src/schemas/schedules.ts` | `{ items: {categoryId, amount, scheduledDate, note?}[] }`, `items.max(20)`, per-item `MAX_AMOUNT`. |

### CREATES — api-local (NOT shared)
- `CategoryForecast` type — `apps/api/src/analysis/forecast.ts` (single server
  consumer, no HTTP endpoint planned → stays local per CLAUDE.md's 2+-consumer bar).
- `BudgetRiskState` Prisma model — suppression state.
- per-category 90-day discretionary-rate aggregate — new exported fn in
  `budget-plans/service.ts`.

**Explicitly NOT added to shared:** batch per-item error codes. Chat tools
throw plain `Error`s that `dispatcher.ts` turns into free-text feedback to
Gemini (same path as the other confirmable tools); the consume route already
returns `invalid_payload_args` for zod failures. No new `API_ERROR_CODES`.

---

## Architecture

Three building blocks, sequenced shared-first:

1. **`apps/api/src/analysis/forecast.ts`** — `projectMonthEnd(ws, userId, year, month)`.
   I/O-bound composition over budget-plans service functions + one new
   per-category discretionary-rate aggregate. Returns per-category
   `CategoryForecast` + a portfolio total. On-demand; cache later if needed
   (key `(workspaceId, year, month)`).
2. **`compareSpendingVsBudget` upgrade** — consume the forecast service,
   surface `projected / projectedOverspend / runwayDay / severity` in its
   existing recap card + text. One tool, one card. `turn.ts` already routes
   "am I okay / on track" here (lines 141-154); no parallel tool to
   disambiguate. Existing tuned recap copy protected by tests.
3. **Daily-brief integration** — `brief-context.ts` `deviation` slot +
   `forecast_card` injection in `daily-brief.ts`, gated by severity, with
   `BudgetRiskState` suppression.

Plus a **`addScheduledSpendBatch`** confirmable chat tool for plan execution.

---

## The forecast (corrected math)

> The naive `spent + max(knownFuture, dailyRate*daysLeft)` was **wrong**:
> (a) a 90-day actual rate already embeds paid recurring bills that ALSO
> appear in `knownFuture`, so `max()` silently re-includes fixed bills; and
> (b) bundling fixed + planned-one-offs into one `knownFuture` and `max`-ing
> it discards real planned spend in mixed categories. The corrected formula
> **separates fixed (additive) from the discretionary remainder (max-ed).**

Per **capped** category `c`, computed **in the user's timezone** (never UTC):

```
daysLeft_c    = lastDayOfMonth(tz) - todayLocalDay(tz) + 1      // inclusive, via partsInTz
spent_c       = posted spend this month                         // exclude pending=true; NET refunds (negative allocations), do not filter amount>0
fixedBills_c  = remaining recurring/subscription occurrences this month, today-forward
                                                                // occurrencesInRange — queried SEPARATELY from ScheduledSpend
plannedOneOffs_c = unmatched, undismissed ScheduledSpend this month, scheduledDate >= monthStart
                                                                // include past-dated-this-month unmatched as still-expected (see Decisions)
discRate_c    = monthlyDiscretionaryBaseline_c / daysInMonth
                where monthlyDiscretionaryBaseline_c = (90-day discretionary actuals) / 3   // matches recentMonthlyAvgSpend normalization
                discretionary EXCLUDES spend represented in fixedBills (subtract trailing recurring monthlyEquivalent,
                or exclude allocations matched to a ScheduledSpend / mapping to a RecurringExpense),
                and is ROBUST (winsorize single-tx outliers > 3x the category's MEDIAN positive tx — mean would be self-inflated by the very outlier it caps) so one $1500 one-off doesn't poison 90 days

projectedTotal_c = spent_c + fixedBills_c + max(plannedOneOffs_c, discRate_c * daysLeft_c)

projectedOverspend_c  = max(0, projectedTotal_c - cap_c)
projectedUnderspend_c = max(0, cap_c - projectedTotal_c)        // celebrate path
```

**Invariant (code comment + test):** `discRate_c` contains only spend NOT
represented in `fixedBills_c`. A rent-only category must project ≈ cap, not
cap + rent.

### Runway (nullable, guarded)
```
runwayDay_c = today + (cap_c - spent_c) / discRate_c
```
Return **null/absent** unless ALL hold: `discRate_c > 0` AND `spent_c < cap_c`
AND the computed day falls within `[today, monthEnd-in-tz]`. Otherwise emit
`"already over"` (spent ≥ cap) or `"not this month"` (beyond month end) —
never a divide-by-zero, Infinity, or past/far-future date.

### Cold start
When `discRate_c <= epsilon` (thin/zero history): severity =
`insufficient_history`, copy = "아직 패턴 학습 중". Do **not** collapse
projection to `spent_c` and silently show on_track.

### Portfolio guard
Also compute a **projected total** severity from `snap.totalSpent /
snap.totalAmount` (incl. uncapped) so the headline can't read green while the
portfolio is red — the same bug the recent `Used %` fix addressed.

---

## Severity tiers (replaces hardcoded `todayPct * 1.05`)

| Tier | Condition |
|---|---|
| `on_track` | `projectedTotal_c <= cap_c` |
| `watch` | `cap_c < projectedTotal_c <= cap_c * 1.10` |
| `at_risk` | `projectedTotal_c > cap_c * 1.10` |
| `insufficient_history` | `discRate_c <= epsilon` |

`1.10` is a starting threshold, workspace-configurable later. Hysteresis on
the boundary (see Suppression) so jitter doesn't flap watch↔at_risk.

---

## Proactive surfacing — daily brief (task #4)

Injection point: `daily-brief.ts` after `generateBrief()` (~line 74), before
the `$transaction` commit (~line 140).

| Severity | Daily brief behavior |
|---|---|
| `at_risk` | `deviation` line + `forecast_card` **every day**; dedicated push on state-rise (see below) |
| `watch` | **brief-quiet** — surfaces only on **first entry into watch** or escalation; chat on-demand otherwise |
| `on_track` | quiet, except an **occasional celebrate** line (early-month reassurance / end-of-month "came in under") using `projectedUnderspend` |
| `insufficient_history` | no brief warning |

**Compile reality:** `daily-brief.ts` / `brief.ts` use the **local narrow**
`PresentationBlock` union in `apps/api/src/chat/blocks.ts` (Text / ConfirmCard /
CategorizeConfirmCard), NOT the shared union. `forecast_card` must be added
to **both** `blocks.ts` and shared `dto/chat.ts`, and to the **mobile
renderer** (`PresentationBlock.tsx` ends in `const _exhaustive: never`) in the
**same commit** — chat is mobile-only (no web chat renderer). There is no
"web renderer" follow-up.

### Dedicated push (at_risk only)
- Fires on **state-rise** (→ at_risk), with a distinct title/body
  (`⚠️ 예산 경고: 식비 월말 +$80 예상`), separate from the routine brief push.
- **Re-notify floor** (avoids going silent on chronic risk): re-push with
  softened copy if still at_risk AND `projectedOverspend` grew materially
  (≥ +25% vs stored `projectedOverspend`) OR ≥ 3 days since `lastPushedAt`.
- **Cooldown + hysteresis** honoring `lastPushedAt` so threshold jitter
  doesn't flap.
- **Cap one** budget-alert push per user per morning across all workspaces
  (pick the worst category).

---

## Plan proposals (task #3)

- **Brief** only warns + **invites** ("채팅에서 같이 짜볼까?"). It does not
  push a fully-formed plan card (it would have to guess amounts/dates).
- **Chat** does conversational planning, then proposes via a
  `plan_proposal_card` backed by **`addScheduledSpendBatch(items[])`**:

```
addScheduledSpendBatch — confirmable tool
- items: { categoryId, amount, scheduledDate, note? }[]   // zod, items.max(20), per-item MAX_AMOUNT
- routed ONLY through presentConfirmCard / ActionIntent (consume route enforces editor + Pro)
- one ActionIntent, one Yes → all N inserts inside prisma.$transaction (all-or-nothing)
- full validation BEFORE the intent is stamped consumedAt (intents/service.ts stamps consumedAt
  at line ~229 BEFORE tool.run at ~244 — a mid-loop throw without a wrapping txn strands rows AND
  burns the intent → user can't retry). Validate-then-execute, rollback on any item failure.
- register in CONFIRMABLE_TOOLS + AUDIT_WRITE_TOOLS
- audit: one summary AuditEvent, targetId=null, items[] in payload (explicit extractTargetId branch)
```

---

## Suppression state

New Prisma model, written **inside the brief `$transaction`** so push state
and brief emission are atomic:

```prisma
model BudgetRiskState {
  id                    String   @id @default(cuid())
  userId                String                       // per-RECIPIENT (briefs iterate users)
  workspaceId           String
  categoryId            String
  periodStart           DateTime @db.Date            // month, matches BudgetPlan/ScheduledSpend convention
  severity              String                       // last-emitted RiskTier
  projectedOverspend    Decimal  @db.Decimal(14, 2)  // for "got worse" detection
  lastPushedAt          DateTime?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category  Category  @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  @@unique([userId, workspaceId, categoryId, periodStart])
}
```

Keyed **per (userId, workspaceId, categoryId, periodStart)** — workspace-only
keying would suppress the alert for all co-members after the first member's
brief tick. Mirrors the proven idempotency pattern (`User.lastTrialPushDays`,
`Goal.lastMilestonePct`).

---

## Performance

- per-category 90-day discretionary rate is a **new** query (not a
  "generalization" of the workspace-total `recentMonthlyAvgSpend`). Implement
  as **one `groupBy(categoryId)` aggregate** per workspace, filtered to capped
  category ids.
- `daily-brief` runs every minute and fans out over all briefed users ×
  workspaces. Verify the query plan; ensure a covering index on
  `Transaction(workspaceId, occurredAt)` joined to
  `TransactionAllocation(categoryId)`; add a composite index if measurement
  warrants. Measure under realistic fan-out before shipping.
- `budgetPlanSnapshot` fires 4 queries via `Promise.all` with no surrounding
  transaction; document the forecast as **best-effort** read consistency, and
  ensure `BudgetRiskState` stores the severity actually pushed.

---

## Copy / prompt updates

- Update `turn.ts` system prompt (lines 141-154) in **lockstep** — the tool
  now returns projected/runway/severity, so the "per-category PACE" copy goes
  stale.
- Branch copy on `daysLeft`: late in the month the run-rate remainder is tiny,
  so phrasing must read **retrospective** ("you ended ~$80 over") not a
  confusing present-tense "you're fine".

---

## Decisions (resolved)

1. **Scope** — budget-cap overage only; no income modeling.
2. **Forecast** — category-split; fixed additive, discretionary remainder max-ed; run-rate term **kept** (it's what makes it a forecast).
3. **Severity** — 3 tiers + insufficient_history; projected-vs-cap, 10% band.
4. **No-budget cohort** — no forecast (forecast needs a cap); when 90-day history exists, brief **nudges to `setBudget`** instead.
5. **watch surfacing** — brief-quiet; surfaces only on entry/escalation (real forecast risk), not daily.
6. **Refund/pending** — net refunds, exclude `pending=true`.
7. **Batch audit** — one summary AuditEvent + `items[]` payload.
8. **Tool** — upgrade `compareSpendingVsBudget` + shared `analysis/forecast.ts` service.
9. **Compute** — on-demand, indexed, cacheable later.
10. **Subscriptions** — live in `RecurringExpense` (separate table), occurrences computed via `occurrencesInRange`; NOT stored as `ScheduledSpend`. Queried separately as `fixedBills`.
11. **Scheduled spends are TODAY-FORWARD** — `plannedOneOffs` counts only `scheduledDate >= today` (unmatched + undismissed), mirroring subscriptions. (Reversed after live testing: a *past-dated* unmatched scheduled spend has almost always already happened — so it's in the actuals — or is stale, and counting it double-adds. The original `>= monthStart` policy falsely flagged a near-capped category as over because of a 5-days-ago "Friends dinner" that was never matched.) Connects to Plaid sync ([[project]] task #5): without transaction import, scheduled items don't auto-match and linger.
12. **Headline shows the numbers behind the %** — the budget recap headline carries `budget`/`spent`/`scheduled` (today-forward) alongside `Used %`, and each at-risk/watch row shows its `scheduled` component so `projected > spent` is explained.

---

## Testing (real DB, no Prisma mocks)

- Forecast math boundaries: rent-only category projects ≈ cap (not cap+rent);
  mixed discretionary+planned category; mid-month one-off doesn't poison rate;
  cold-start → insufficient_history; portfolio-red-while-category-green.
- Timezone: UTC-5 and UTC+13 user at 23:00 local on day 1 and last day of month.
- Runway null cases: discRate=0, spent≥cap, beyond month-end.
- Refund netting + pending exclusion: pending+posted pair; partial refund.
- Severity transitions + suppression: state-rise push, chronic no-double-push,
  re-notify on +25% worse, flapping hysteresis, per-user keying (co-members),
  one-push-per-morning cap.
- Batch tool: N-at-cap (20), one invalid item among valid → full rollback,
  viewer-consume → 403, audit row carries items[].

---

## Sequencing

Shared commit(s) first, then by task:

1. **Shared** — `RiskTier`/`RISK_TIERS` (enums); `ScheduledSpendBatchBody` (schemas).
   `forecast_card` + `plan_proposal_card` union additions land **with** their
   mobile renderer branches as one atomic commit (else `nx typecheck mobile` red).
2. **#2** — `analysis/forecast.ts` + per-category rate aggregate + upgrade
   `compareSpendingVsBudget` + turn.ts copy. Tests.
3. **#3** — `addScheduledSpendBatch` + `plan_proposal_card` + CONFIRMABLE/AUDIT
   registration + chat coaching copy. Tests.
4. **#4** — `BudgetRiskState` migration + `brief-context.ts` deviation +
   `daily-brief.ts` injection + dedicated push + suppression. Tests.
