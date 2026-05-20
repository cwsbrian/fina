# Plan 1E-next Final Design: Read-Only Chat Finance Tools

**Date:** 2026-05-15  
**Status:** Final design for implementation planning  
**Decision:** Codex-only design as the base, with review findings imported from the Opus-Codex workflow.

---

## 1. Decision Summary

Plan 1E-next adds seven **read-only** tools to Fina's Pro-tier chat assistant:

1. `listAccounts`
2. `getTransactionDetails`
3. `findUncategorizedTransactions`
4. `getCategoryBreakdown`
5. `compareSpendingPeriods`
6. `detectRecurringMerchants`
7. `getCashflowSummary`

This final design intentionally excludes write tools. `createCategory`, `addTransactionNote`, and broader search (`findTransactions`) are valuable, but they expand the product and safety surface enough to deserve follow-up plans.

The final workflow decision behind this spec:

- Use the Codex-authored read-only portfolio as the implementation base.
- Import concrete review improvements from the Opus-Codex variant: sign convention, timezone handling, strict date parsing, `removedAt` policy clarity, registry casting, and Plaid date-only storage caveat.
- Keep Plan 1E-next shippable: no migrations, no new dependencies unless timezone support requires one, no UI changes, and no new write paths.

---

## 2. Existing Context

The existing chat tools are:

- `listTransactions`
- `getSpendingSummary`
- `listCategories`
- `categorizeTransaction`

They leave common user questions unanswered:

- "Which accounts are connected?"
- "Is my bank sync stale?"
- "Show details for that transaction."
- "What still needs categorizing?"
- "Where did my money go by readable category name?"
- "What changed this month compared with last month?"
- "What subscriptions do I have?"
- "How much came in, went out, and was left over?"

Plan 1E-next fills those gaps without changing the chat route, dispatcher, Gemini adapter, chat message persistence, or UI.

---

## 3. Shared Rules

### 3.1 Tool Pattern

Each new tool follows the existing pattern:

- One file per tool in `apps/api/src/chat/tools/`.
- Export a `ToolDef<TArgs, TResult>`.
- Register the tool in `apps/api/src/chat/tools/index.ts`.
- Cast each registry entry as `ToolDef`, matching the current registry pattern.
- Every top-level Zod arg field has `.describe(...)`.
- Tests invoke `tool.run(ctx, args)` directly.

### 3.2 Workspace Isolation

Every Prisma query must filter by `ctx.workspaceId`.

Single-row lookups must use `findFirst({ where: { id, workspaceId: ctx.workspaceId, ... } })` or an equivalent workspace-scoped pattern. Do not use `findUnique({ where: { id } })` for user-owned rows.

### 3.3 Sign Convention

The codebase stores Plaid spending as positive transaction amounts.

- `amount > 0`: expense / outflow.
- `amount < 0`: income, refund, deposit, or inflow.
- Spending tools must aggregate only `amount > 0`.
- Cashflow tools must sum positive amounts as expenses and absolute negative amounts as income.

This is grounded in the existing `getSpendingSummary` implementation and tests.

### 3.4 Decimal And Date Serialization

- `Decimal` values return as strings via `.toString()` or fixed decimal string formatting when explicitly specified.
- Dates return as ISO 8601 strings.
- Date-only labels return as `YYYY-MM-DD`.
- Nullable values stay nullable.

### 3.5 Currency Scope

This phase does not perform currency conversion.

Aggregate tools that produce totals over transactions are CAD-scoped:

- Include only transactions where `currency = "CAD"`.
- Return `currency: "CAD"`.
- Count excluded non-CAD source rows with an explicit field.

Recurring detection groups by `(merchantKey, currency)` instead of converting or merging currencies.

### 3.6 Timezone And Periods

Period helpers should be user-timezone-aware.

Use `User.tz` from `ctx.userId`; if lookup fails or the value is invalid, fall back to the schema default `"America/Toronto"`.

Period boundaries are user-local calendar boundaries converted to UTC instants for Prisma comparisons. This avoids server-local `Date` drift for `this_week`, `this_month`, and `last_month`.

Add a shared helper:

`apps/api/src/chat/tools/periods.ts`

Recommended API:

```ts
export type BasicPeriod = "this_week" | "this_month" | "last_month";
export type ReviewPeriod = BasicPeriod | "all_time";
export type CurrentPeriod = "this_week" | "this_month";
export type ComparisonPeriod = "previous_week" | "last_month";

export function basicPeriodRange(
  userId: string,
  period: BasicPeriod,
  now?: Date,
): Promise<{ gte: Date; lt: Date }>;

export function reviewPeriodRange(
  userId: string,
  period: ReviewPeriod,
  now?: Date,
): Promise<{ gte?: Date; lt?: Date }>;

export function comparisonRanges(
  userId: string,
  currentPeriod: CurrentPeriod,
  comparisonPeriod: ComparisonPeriod,
  now?: Date,
): Promise<{
  current: { gte: Date; lt: Date };
  comparison: { gte: Date; lt: Date };
}>;
```

If the implementation chooses not to add a timezone library, it must still include tests around month/week boundaries for `America/Toronto`.

### 3.7 Plaid Date-Only Storage Caveat

Current Plaid sync stores date-only Plaid transactions as UTC-midnight instants. User-timezone period filters can therefore mis-bin transactions exactly at date boundaries for non-UTC timezones.

This plan does not change transaction storage policy. The limitation must be documented in tests or comments near the period helper so a future storage-policy plan can address it without rediscovering the issue.

### 3.8 Error Handling

Throw plain domain errors from tools:

- `new Error("transaction_not_found")`
- `new Error("invalid_period_pair")`

Normal empty states return empty arrays or zero totals, not errors.

Read-only transaction detail may return soft-deleted transactions when explicitly requested by id. Aggregates and list-style tools exclude `removedAt != null`.

---

## 4. Tool Specifications

### 4.1 `listAccounts`

**File:** `apps/api/src/chat/tools/list-accounts.ts`

**Description:**

```ts
"List bank accounts in the workspace with balances, account status, and Plaid connection status."
```

**Args:**

```ts
z.object({
  include_archived: z.boolean()
    .describe("Whether to include archived bank accounts. Defaults to false.")
    .optional(),
})
```

**Return:**

```ts
{
  accounts: Array<{
    id: string;
    name: string;
    officialName: string | null;
    type: string;
    subtype: string | null;
    currency: string;
    status: "active" | "closed" | "hidden";
    balanceCurrent: string | null;
    balanceAvailable: string | null;
    balanceLimit: string | null;
    lastBalanceSyncAt: string | null;
    archivedAt: string | null;
    institutionName: string | null;
    plaidItemStatus: "active" | "error" | "relink_required" | "disconnected" | null;
    plaidItemErrorCode: string | null;
    plaidItemLastSyncAt: string | null;
  }>;
}
```

**Implementation Notes:**

- Query `prisma.bankAccount.findMany`.
- Always filter by `workspaceId: ctx.workspaceId`.
- Unless `include_archived === true`, add `archivedAt: null`.
- Include related `plaidItem` fields: `institutionName`, `status`, `errorCode`, `lastSyncAt`.
- Sort deterministically: archived accounts last, active account status first, then name, then id. If Prisma ordering is awkward, sort workspace-scoped rows in memory.
- Convert nullable decimals and dates explicitly.

---

### 4.2 `getTransactionDetails`

**File:** `apps/api/src/chat/tools/get-transaction-details.ts`

**Description:**

```ts
"Get full details for one transaction, including account and category context."
```

**Args:**

```ts
z.object({
  tx_id: z.string().min(1)
    .describe("Transaction id to inspect. Must belong to the current workspace."),
})
```

**Return:**

```ts
{
  transaction: {
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    postedAt: string | null;
    pending: boolean;
    source: "plaid" | "manual" | "csv";
    note: string | null;
    categorizationSource: "mapping" | "ai" | "manual" | null;
    removedAt: string | null;
    account: {
      id: string;
      name: string;
      type: string;
      subtype: string | null;
      currency: string;
    };
    category: {
      id: string;
      name: string;
      parentId: string | null;
      parentName: string | null;
    } | null;
  };
}
```

**Implementation Notes:**

- Query `prisma.transaction.findFirst`.
- Use `where: { id: args.tx_id, workspaceId: ctx.workspaceId }`.
- Do not filter out `removedAt` for this detail lookup. Return `removedAt` so the LLM can explain that the transaction was removed.
- Include/select `account` and `category.parent`.
- If no transaction is found, throw `new Error("transaction_not_found")`.
- Cross-workspace ids behave as not found.

---

### 4.3 `findUncategorizedTransactions`

**File:** `apps/api/src/chat/tools/find-uncategorized-transactions.ts`

**Description:**

```ts
"Find transactions that are uncategorized or have not been manually reviewed."
```

**Args:**

```ts
z.object({
  period: z.enum(["this_week", "this_month", "last_month", "all_time"])
    .describe("Time window to search for uncategorized transactions. Defaults to this_month.")
    .optional(),
  review_mode: z.enum(["missing_category", "not_manual"])
    .describe("missing_category returns categoryId=null. not_manual returns transactions whose categorizationSource is not manual, including uncategorized.")
    .optional(),
  limit: z.number().int().positive().max(50)
    .describe("Maximum transactions to return. Defaults to 20, hard cap 50.")
    .optional(),
})
```

**Return:**

```ts
{
  period: "this_week" | "this_month" | "last_month" | "all_time";
  reviewMode: "missing_category" | "not_manual";
  transactions: Array<{
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    accountName: string;
    categoryId: string | null;
    categorizationSource: "mapping" | "ai" | "manual" | null;
  }>;
}
```

**Implementation Notes:**

- Defaults: `period = "this_month"`, `review_mode = "missing_category"`, `limit = 20`.
- Base filter: `workspaceId: ctx.workspaceId`, `removedAt: null`.
- Date filter comes from `reviewPeriodRange(ctx.userId, period)`.
- For `missing_category`, add `categoryId: null`.
- For `not_manual`, add `OR: [{ categorizationSource: null }, { categorizationSource: { not: "manual" } }]`.
- Include/select account name.
- Order by `occurredAt: "desc"`, then `id: "desc"`.

---

### 4.4 `getCategoryBreakdown`

**File:** `apps/api/src/chat/tools/get-category-breakdown.ts`

**Description:**

```ts
"Summarize CAD spending by readable category name, including parent category and visual metadata."
```

**Args:**

```ts
z.object({
  period: z.enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize spending by category."),
  include_uncategorized: z.boolean()
    .describe("Whether to include uncategorized spending as its own bucket. Defaults to true.")
    .optional(),
  limit: z.number().int().positive().max(25)
    .describe("Maximum category buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
})
```

**Return:**

```ts
{
  period: "this_week" | "this_month" | "last_month";
  currency: "CAD";
  total: string;
  excludedNonCadCount: number;
  categories: Array<{
    categoryId: string | null;
    categoryName: string;
    parentCategoryId: string | null;
    parentCategoryName: string | null;
    color: string | null;
    icon: string | null;
    total: string;
    count: number;
    share: number;
  }>;
}
```

**Implementation Notes:**

- Use `basicPeriodRange(ctx.userId, period)`.
- Include only active transactions where `workspaceId`, `removedAt: null`, `currency: "CAD"`, `amount: { gt: 0 }`, and date range match.
- `excludedNonCadCount` counts matching positive-amount transactions in the same period whose currency is not CAD.
- Include `category` and `category.parent`.
- If `include_uncategorized === false`, exclude `categoryId: null`.
- `total` is the positive spending total before the final bucket limit.
- `share = bucketTotal / total`, or `0` when total is zero.
- Sort by total descending, then category name.
- Default `limit = 10`.

---

### 4.5 `compareSpendingPeriods`

**File:** `apps/api/src/chat/tools/compare-spending-periods.ts`

**Description:**

```ts
"Compare CAD spending between two matching periods by category or merchant and return the largest changes."
```

**Args:**

```ts
z.object({
  current_period: z.enum(["this_week", "this_month"])
    .describe("Current period to compare."),
  comparison_period: z.enum(["previous_week", "last_month"])
    .describe("Comparison period. Use previous_week with this_week, last_month with this_month."),
  group_by: z.enum(["category", "merchant"])
    .describe("Dimension to compare spending by."),
  limit: z.number().int().positive().max(25)
    .describe("Maximum changed buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
})
```

**Return:**

```ts
{
  currentPeriod: "this_week" | "this_month";
  comparisonPeriod: "previous_week" | "last_month";
  groupBy: "category" | "merchant";
  currency: "CAD";
  currentTotal: string;
  comparisonTotal: string;
  delta: string;
  percentChange: number | null;
  currentExcludedNonCadCount: number;
  comparisonExcludedNonCadCount: number;
  changes: Array<{
    key: string;
    label: string;
    currentTotal: string;
    comparisonTotal: string;
    delta: string;
    percentChange: number | null;
    currentCount: number;
    comparisonCount: number;
  }>;
}
```

**Implementation Notes:**

- Valid pairs only:
  - `this_week` with `previous_week`.
  - `this_month` with `last_month`.
- Throw `new Error("invalid_period_pair")` for mismatches.
- Use `comparisonRanges(ctx.userId, current_period, comparison_period)`.
- Query CAD positive-amount transactions only.
- Count non-CAD positive-amount exclusions separately for each period.
- For `group_by: "category"`:
  - Key is `categoryId ?? "uncategorized"`.
  - Label is category name or `"Uncategorized"`.
- For `group_by: "merchant"`:
  - Key is `merchantNormalized ?? normalizeMerchant(merchantRaw)`.
  - Label should prefer the most recent raw merchant display value for that key.
- `delta = currentTotal - comparisonTotal`.
- `percentChange = delta / comparisonTotal` as a ratio. Return `null` when comparison total is zero.
- Sort by absolute delta descending, then label.
- Default `limit = 10`.

---

### 4.6 `detectRecurringMerchants`

**File:** `apps/api/src/chat/tools/detect-recurring-merchants.ts`

**Description:**

```ts
"Detect likely recurring merchant payments from recent transaction history using cadence and amount stability heuristics."
```

**Args:**

```ts
z.object({
  lookback_months: z.number().int().min(2).max(12)
    .describe("How many months of transactions to inspect. Defaults to 6, min 2, max 12.")
    .optional(),
  min_occurrences: z.number().int().min(2).max(12)
    .describe("Minimum number of merchant occurrences required. Defaults to 3.")
    .optional(),
  limit: z.number().int().positive().max(25)
    .describe("Maximum recurring merchant candidates to return. Defaults to 10, hard cap 25.")
    .optional(),
})
```

**Return:**

```ts
{
  lookbackMonths: number;
  candidates: Array<{
    key: string;
    merchantNormalized: string;
    displayName: string;
    occurrences: number;
    firstSeenAt: string;
    lastSeenAt: string;
    medianAmount: string;
    latestAmount: string;
    currency: string;
    cadence: "weekly" | "biweekly" | "monthly" | "irregular";
    confidence: number;
    transactionIds: string[];
  }>;
}
```

**Implementation Notes:**

- Defaults: `lookback_months = 6`, `min_occurrences = 3`, `limit = 10`.
- `lookbackStart` is the first day of the calendar month that begins the lookback window in the user's timezone, converted to a UTC instant.
- Query active transactions with `workspaceId`, `removedAt: null`, `occurredAt >= lookbackStart`, and `amount: { gt: 0 }`.
- Derive `merchantKey = merchantNormalized ?? normalizeMerchant(merchantRaw)`.
- Exclude empty merchant keys.
- Group by `(merchantKey, currency)`.
- Return key as `${merchantKey}::${currency}`.
- Do not convert or merge currencies.
- Sort occurrences by `occurredAt`.
- Cadence:
  - `weekly`: median gap 6-8 days.
  - `biweekly`: median gap 12-16 days.
  - `monthly`: median gap 27-34 days.
  - otherwise `irregular`.
- Confidence:
  - Start with `min(1, occurrences / max(min_occurrences, 4)) * 0.4`.
  - Add up to `0.4` for cadence regularity.
  - Add up to `0.2` for amount stability.
  - Clamp to `0..1`.
- Exclude candidates below a minimum confidence of `0.45` to avoid low-signal irregular merchants filling the result.
- Sort by confidence descending, then latest amount descending.

---

### 4.7 `getCashflowSummary`

**File:** `apps/api/src/chat/tools/get-cashflow-summary.ts`

**Description:**

```ts
"Summarize CAD income, expenses, and net cashflow for a period, grouped by day or account."
```

**Args:**

```ts
z.object({
  period: z.enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize cashflow."),
  group_by: z.enum(["day", "account"])
    .describe("Optional grouping dimension. Defaults to day.")
    .optional(),
})
```

**Return:**

```ts
{
  period: "this_week" | "this_month" | "last_month";
  groupBy: "day" | "account";
  currency: "CAD";
  incomeTotal: string;
  expenseTotal: string;
  netTotal: string;
  excludedNonCadCount: number;
  groups: Array<{
    key: string;
    label: string;
    incomeTotal: string;
    expenseTotal: string;
    netTotal: string;
    count: number;
  }>;
}
```

**Implementation Notes:**

- Default `group_by = "day"`.
- Use `basicPeriodRange(ctx.userId, period)`.
- Query active CAD transactions in the period.
- `excludedNonCadCount` counts active transactions in the same period whose currency is not CAD.
- Sign convention:
  - Positive amounts are expenses.
  - Negative amounts are income/refunds/inflows.
  - `expenseTotal` sums positive amounts.
  - `incomeTotal` sums the absolute value of negative amounts.
  - `netTotal = incomeTotal - expenseTotal`.
- For `group_by: "day"`:
  - Key and label are `YYYY-MM-DD`.
  - Sort by date ascending.
- For `group_by: "account"`:
  - Key is `account.id`.
  - Label is `account.name`.
  - Sort by absolute activity descending.
- Zero amounts, if present, count in `count` but do not change totals.

---

## 5. Registry Update

Update `apps/api/src/chat/tools/index.ts`:

```ts
import { listAccounts } from "./list-accounts.js";
import { getTransactionDetails } from "./get-transaction-details.js";
import { findUncategorizedTransactions } from "./find-uncategorized-transactions.js";
import { getCategoryBreakdown } from "./get-category-breakdown.js";
import { compareSpendingPeriods } from "./compare-spending-periods.js";
import { detectRecurringMerchants } from "./detect-recurring-merchants.js";
import { getCashflowSummary } from "./get-cashflow-summary.js";

export const REGISTRY: ToolDef[] = [
  listTransactions as ToolDef,
  getSpendingSummary as ToolDef,
  listCategories as ToolDef,
  categorizeTransaction as ToolDef,
  listAccounts as ToolDef,
  getTransactionDetails as ToolDef,
  findUncategorizedTransactions as ToolDef,
  getCategoryBreakdown as ToolDef,
  compareSpendingPeriods as ToolDef,
  detectRecurringMerchants as ToolDef,
  getCashflowSummary as ToolDef,
];
```

---

## 6. Testing Plan

Add:

- `apps/api/tests/chat.tools.periods.test.ts`
- `apps/api/tests/chat.tools.list-accounts.test.ts`
- `apps/api/tests/chat.tools.get-transaction-details.test.ts`
- `apps/api/tests/chat.tools.find-uncategorized-transactions.test.ts`
- `apps/api/tests/chat.tools.get-category-breakdown.test.ts`
- `apps/api/tests/chat.tools.compare-spending-periods.test.ts`
- `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts`
- `apps/api/tests/chat.tools.get-cashflow-summary.test.ts`

Common coverage:

- Happy path.
- Empty workspace / no matching data.
- Workspace isolation.
- `removedAt` handling.
- Decimal/date serialization.
- Zod validation for limits/enums.
- User-timezone period boundaries.
- Positive expense and negative income/refund sign convention.
- Non-CAD exclusion count where applicable.

Specific coverage:

- `periods`: `this_week`, `previous_week`, `this_month`, `last_month`, `all_time`, `America/Toronto` boundary cases.
- `listAccounts`: archived default exclusion, archived inclusion, Plaid item status fields, deterministic ordering.
- `getTransactionDetails`: cross-workspace not found, missing id not found, soft-deleted transaction returned with `removedAt`.
- `findUncategorizedTransactions`: `missing_category`, `not_manual`, period filtering, limit.
- `getCategoryBreakdown`: readable category and parent fields, uncategorized include/exclude, share computation, CAD-only totals.
- `compareSpendingPeriods`: valid pairs, invalid pair error, category comparison, merchant comparison with `normalizeMerchant`, zero baseline percent change, CAD-only totals.
- `detectRecurringMerchants`: monthly cadence, weekly cadence, irregular low-confidence exclusion, minimum occurrences, negative amount exclusion, fallback merchant normalization, separate currency groups.
- `getCashflowSummary`: positive expenses, negative income, net total, day grouping, account grouping.

Registry/schema tests:

- `REGISTRY` contains all seven new tool names.
- Gemini declarations emit parameter schemas for non-zero-arg tools.
- Every top-level arg field has a non-empty description.
- Every new tool has the exact description string from this spec.

---

## 7. Implementation Order

1. `periods.ts`
2. `listAccounts`
3. `getTransactionDetails`
4. `findUncategorizedTransactions`
5. `getCategoryBreakdown`
6. `compareSpendingPeriods`
7. `detectRecurringMerchants`
8. `getCashflowSummary`
9. Registry/schema tests

This order establishes shared date behavior first, then moves from low-complexity read tools to aggregate and heuristic tools.

---

## 8. Excluded Scope

Excluded from Plan 1E-next:

- `findTransactions` advanced search.
- `createCategory`.
- `addTransactionNote`.
- Any other write tool.
- Confirm-card workflow.
- Category rename/archive/merge/delete.
- Manual transaction creation.
- Persistent recurring subscription rules.
- Budget models or budget comparison.
- Currency conversion.
- Plaid transaction storage policy changes.
- SSE streaming.
- New chat block types.
- Web or mobile UI changes.

Follow-up candidates:

- Plan 1E-search: `findTransactions` with merchant, category, amount, date filters, pagination, strict date parsing, and Prisma `AND`/nested `OR` patterns.
- Plan 1E-write: safe chat writes with confirmation UX, `createCategory`, `addTransactionNote`, and category uniqueness migration.
- Plan 1E-time: Plaid date-only storage policy and user-timezone correctness across existing transaction APIs.

---

## 9. Acceptance Criteria

This phase is complete when:

- All seven tools are implemented and registered.
- Existing four tools still work unchanged.
- All new args include `.describe(...)`.
- Tool tests pass.
- Registry/schema tests pass.
- Cross-workspace data is never returned.
- Soft-deleted transactions are excluded from aggregates and list-style tools.
- `getTransactionDetails` returns soft-deleted transactions only by explicit id lookup.
- Monetary values are strings.
- Dates are ISO strings.
- CAD aggregate tools expose non-CAD exclusion counts.
- Period boundaries use `User.tz` and have boundary tests.
- Recurring detection excludes negative amount transactions and groups by merchant plus currency.

---

## 10. Provenance

This final design is based on the comparison of:

- `docs/superpowers/specs/2026-05-15-plan-1e-next-claude-design.md`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-codex-design.md`
- `docs/superpowers/specs/2026-05-15-plan-1e-next-opus-codex-design.md`

Final decision:

- Use Codex-only's read-only portfolio as the base.
- Do not keep Opus-Codex write tools in this phase.
- Port Opus-Codex review findings that improve correctness without expanding scope.
