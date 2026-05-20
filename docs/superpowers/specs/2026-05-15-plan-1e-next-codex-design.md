# Plan 1E-next Codex Design: Chat Finance Tools

Date: 2026-05-15

## Purpose

Plan 1E-next adds the next set of chat tools for Fina's Pro-tier finance assistant. The goal is to make the assistant useful for everyday account inspection, transaction cleanup, spending analysis, period comparison, recurring-payment discovery, and cashflow questions without adding new tables or dangerous write paths.

This design deliberately starts from the provided Plan 1E-next briefing and the current API/tool contracts. It does not depend on the existing Claude-authored Plan 1E-next design.

## Current Gap

The existing chat tools cover four useful but narrow tasks:

- `listTransactions`: recent transaction lookup, with limited period support.
- `getSpendingSummary`: simple spending totals grouped by category id, merchant, or day.
- `listCategories`: category lookup.
- `categorizeTransaction`: a safe manual categorization write for one transaction plus siblings.

Common user questions still cannot be answered well:

- "Which accounts are connected and what are their balances?"
- "Show me the full details for this transaction."
- "What still needs categorizing?"
- "Where did my spending go by readable category name?"
- "What increased this month compared with last month?"
- "What subscriptions or recurring payments do I have?"
- "How much came in, went out, and was left over this month?"

## Design Summary

Add seven tools:

1. `listAccounts`
2. `getTransactionDetails`
3. `findUncategorizedTransactions`
4. `getCategoryBreakdown`
5. `compareSpendingPeriods`
6. `detectRecurringMerchants`
7. `getCashflowSummary`

All seven tools are read-only. They use only existing Prisma models and follow the existing `ToolDef` pattern:

- One file per tool in `apps/api/src/chat/tools/`.
- Registration in `apps/api/src/chat/tools/index.ts`.
- No changes to `dispatcher.ts`, `gemini-adapter.ts`, `turn.ts`, or `routes/chat.ts`.
- Every DB query filters by `ctx.workspaceId`.
- Transaction queries also filter `removedAt: null`.
- All monetary `Decimal` values are serialized as strings.
- All dates are returned as ISO 8601 strings.
- Tool errors are domain errors such as `transaction_not_found` and `invalid_period_pair`.
- Empty result sets return empty arrays and zero totals, not errors.
- Aggregate analysis tools do not convert currencies. For this phase, spending and cashflow aggregates summarize CAD transactions only and report excluded non-CAD transaction counts. Recurring detection groups candidates by normalized merchant plus currency, so different currencies never share amount statistics.

## Shared Helpers

Add a small shared helper file:

`apps/api/src/chat/tools/periods.ts`

It should expose period range helpers used by the new analysis tools. Existing tools already duplicate period logic; new tools should avoid adding more duplication.

Recommended helper API:

```ts
export type BasicPeriod = "this_week" | "this_month" | "last_month";
export type ReviewPeriod = BasicPeriod | "all_time";
export type CurrentPeriod = "this_week" | "this_month";
export type ComparisonPeriod = "previous_week" | "last_month";

export function basicPeriodRange(period: BasicPeriod, now?: Date): { gte: Date; lt: Date };
export function reviewPeriodRange(period: ReviewPeriod, now?: Date): { gte?: Date; lt?: Date };
export function comparisonRanges(
  currentPeriod: CurrentPeriod,
  comparisonPeriod: ComparisonPeriod,
  now?: Date,
): {
  current: { gte: Date; lt: Date };
  comparison: { gte: Date; lt: Date };
};
```

Period semantics:

- `this_week`: Monday 00:00 through next Monday 00:00.
- `previous_week`: the Monday-to-Monday window immediately before `this_week`.
- `this_month`: first day of the current calendar month through first day of the next month.
- `last_month`: first day of the previous calendar month through first day of the current month.
- `all_time`: no date filter.

The new helper may follow the existing server-local `Date` behavior used by current tools. User-timezone-aware period boundaries are valuable but out of scope for this plan because existing chat tools do not support them yet.

## Tool 1: `listAccounts`

Purpose: answer questions like "Which accounts are connected?", "Show my balances", and "Are any accounts archived or stale?"

File:

`apps/api/src/chat/tools/list-accounts.ts`

ToolDef description:

```ts
description: "List bank accounts in the workspace with balances, account status, and Plaid connection status."
```

Zod args:

```ts
const Args = z.object({
  include_archived: z.boolean()
    .describe("Whether to include archived bank accounts. Defaults to false.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Query `prisma.bankAccount.findMany`.
- Always filter by `workspaceId: ctx.workspaceId`.
- If `include_archived` is not true, add `archivedAt: null`.
- Include/select the related `plaidItem.institutionName`, `status`, `errorCode`, and `lastSyncAt`.
- Order deterministically by archived accounts last, active account status first, then `name: "asc"`, then `id: "asc"`. If Prisma cannot express this exact ordering directly, sort rows in memory after fetching the workspace-scoped rows.
- Convert nullable decimals with `value?.toString() ?? null`.
- Convert nullable dates with `value?.toISOString() ?? null`.

Example queries this enables:

- "What accounts are connected?"
- "Which account has the highest current balance?"
- "When did my balances last sync?"

## Tool 2: `getTransactionDetails`

Purpose: answer follow-up questions about a transaction selected from `listTransactions`, `findUncategorizedTransactions`, or another tool result.

File:

`apps/api/src/chat/tools/get-transaction-details.ts`

ToolDef description:

```ts
description: "Get full details for one transaction, including account and category context."
```

Zod args:

```ts
const Args = z.object({
  tx_id: z.string().min(1)
    .describe("Transaction id to inspect. Must belong to the current workspace."),
});
```

Return shape:

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
    } | null;
  };
}
```

Implementation notes:

- Query `prisma.transaction.findFirst`.
- Use `where: { id: args.tx_id, workspaceId: ctx.workspaceId, removedAt: null }`.
- Include/select `account` and `category`.
- If no transaction is found, throw `new Error("transaction_not_found")`.
- Cross-workspace IDs intentionally behave as not found.

Example queries this enables:

- "Show me details for that Starbucks transaction."
- "Which account did this come from?"
- "Was this categorized manually or by mapping?"

## Tool 3: `findUncategorizedTransactions`

Purpose: surface transactions that need cleanup or review.

File:

`apps/api/src/chat/tools/find-uncategorized-transactions.ts`

ToolDef description:

```ts
description: "Find transactions that are uncategorized or have not been manually reviewed."
```

Zod args:

```ts
const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month", "all_time"])
    .describe("Time window to search for uncategorized transactions. Defaults to this_month.")
    .optional(),
  review_mode: z.enum(["missing_category", "not_manual"])
    .describe("missing_category returns categoryId=null. not_manual returns transactions whose categorizationSource is not manual, including uncategorized.")
    .optional(),
  limit: z.number().int().positive().max(50)
    .describe("Maximum transactions to return. Defaults to 20, hard cap 50.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Defaults: `period = "this_month"`, `review_mode = "missing_category"`, `limit = 20`.
- Base filter: `workspaceId: ctx.workspaceId`, `removedAt: null`.
- Date filter comes from `reviewPeriodRange`.
- For `missing_category`, add `categoryId: null`.
- For `not_manual`, add `OR: [{ categorizationSource: null }, { categorizationSource: { not: "manual" } }]`.
- Include/select the account name.
- Order by `occurredAt: "desc"`, then `id: "desc"`.

Example queries this enables:

- "What still needs categorizing?"
- "Show me transactions I have not manually reviewed."
- "Find uncategorized transactions from last month."

## Tool 4: `getCategoryBreakdown`

Purpose: provide readable category-level spending analysis, including category names and visual metadata.

File:

`apps/api/src/chat/tools/get-category-breakdown.ts`

ToolDef description:

```ts
description: "Summarize CAD spending by readable category name, including parent category and visual metadata."
```

Zod args:

```ts
const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize spending by category."),
  include_uncategorized: z.boolean()
    .describe("Whether to include uncategorized spending as its own bucket. Defaults to true.")
    .optional(),
  limit: z.number().int().positive().max(25)
    .describe("Maximum category buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Query active transactions in the period with `workspaceId`, `removedAt: null`, and the period date range.
- This is a CAD spending breakdown, so include only transactions where `currency: "CAD"` and `amount > 0`. Current app convention treats positive amounts as expenses.
- `excludedNonCadCount` counts active positive-amount transactions in the same period whose `currency` is not `"CAD"`. These rows are excluded from spending totals because currency conversion is out of scope.
- Include `category` and `category.parent`.
- If `include_uncategorized` is false, exclude rows where `categoryId` is null.
- If `include_uncategorized` is true, bucket `categoryId: null` as `categoryName: "Uncategorized"`.
- `total` is the positive spending total across returned source rows before the final `limit` is applied.
- `share` is `bucketTotal / total`, or `0` when total is zero.
- Sort buckets by descending total, then category name.
- Default `limit = 10`.

Difference from existing `getSpendingSummary`:

- Returns human-readable category names, parent category names, colors, and icons.
- Computes share values.
- Explicitly uses CAD positive expenses only.
- Keeps uncategorized handling configurable.

Example queries this enables:

- "Where did my money go this month?"
- "What category took the biggest share last month?"
- "Show spending by category with uncategorized included."

## Tool 5: `compareSpendingPeriods`

Purpose: compare spending between two period windows and highlight the biggest increases/decreases.

File:

`apps/api/src/chat/tools/compare-spending-periods.ts`

ToolDef description:

```ts
description: "Compare CAD spending between two matching periods by category or merchant and return the largest changes."
```

Zod args:

```ts
const Args = z.object({
  current_period: z.enum(["this_week", "this_month"])
    .describe("Current period to compare."),
  comparison_period: z.enum(["previous_week", "last_month"])
    .describe("Comparison period. Use previous_week with this_week, last_month with this_month."),
  group_by: z.enum(["category", "merchant"])
    .describe("Dimension to compare spending by."),
  limit: z.number().int().positive().max(25)
    .describe("Maximum changed buckets to return. Defaults to 10, hard cap 25.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Valid pairs only:
  - `current_period: "this_week"` with `comparison_period: "previous_week"`.
  - `current_period: "this_month"` with `comparison_period: "last_month"`.
- Throw `new Error("invalid_period_pair")` for mismatches.
- Query CAD positive-amount transactions only, because this is spending comparison and currency conversion is out of scope.
- `currentExcludedNonCadCount` and `comparisonExcludedNonCadCount` count active positive-amount non-CAD transactions in each period. These rows are excluded from spending totals.
- For `group_by: "category"`:
  - Key is `categoryId ?? "uncategorized"`.
  - Label is category name or `"Uncategorized"`.
- For `group_by: "merchant"`:
  - Key is `merchantNormalized ?? normalizeMerchant(merchantRaw)`.
  - Label should prefer the most recent raw merchant display value for that key.
- `delta = currentTotal - comparisonTotal`.
- `percentChange = delta / comparisonTotal` as a ratio, so `0.25` means a 25% increase. `percentChange = null` when comparison total is zero.
- Sort by absolute delta descending, then label.
- Default `limit = 10`.

Example queries this enables:

- "What went up this month compared with last month?"
- "Which merchants increased this week?"
- "Where did I spend less than last month?"

## Tool 6: `detectRecurringMerchants`

Purpose: detect likely recurring payments or subscriptions from transaction history. This is a heuristic candidate detector, not a persisted recurring-rule engine.

File:

`apps/api/src/chat/tools/detect-recurring-merchants.ts`

ToolDef description:

```ts
description: "Detect likely recurring merchant payments from recent transaction history using cadence and amount stability heuristics."
```

Zod args:

```ts
const Args = z.object({
  lookback_months: z.number().int().min(2).max(12)
    .describe("How many months of transactions to inspect. Defaults to 6, min 2, max 12.")
    .optional(),
  min_occurrences: z.number().int().min(2).max(12)
    .describe("Minimum number of merchant occurrences required. Defaults to 3.")
    .optional(),
  limit: z.number().int().positive().max(25)
    .describe("Maximum recurring merchant candidates to return. Defaults to 10, hard cap 25.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Defaults: `lookback_months = 6`, `min_occurrences = 3`, `limit = 10`.
- `lookbackStart` is the first day of the calendar month that begins the lookback window. For example, on 2026-05-15 with `lookback_months = 6`, inspect transactions from 2025-12-01 inclusive.
- Query active transactions with `workspaceId`, `removedAt: null`, `occurredAt >= lookbackStart`.
- Include only positive amounts so income deposits do not appear as subscriptions.
- Derive `merchantKey = merchantNormalized ?? normalizeMerchant(merchantRaw)`.
- Exclude rows whose `merchantKey` is empty after normalization.
- Group by `(merchantKey, currency)`, using a stable key such as `${merchantKey}::${currency}`.
- `key` in the return is that stable merchant-plus-currency key.
- `merchantNormalized` in the return should contain `merchantKey`, even if it was derived from raw merchant text.
- `displayName` should prefer the most recent `merchantRaw`.
- Keep the transaction ids used for the candidate, newest first, capped at a small implementation-defined maximum such as 12.
- Compute median from positive amounts in the group.
- `latestAmount` is the amount from the newest transaction in the group.
- `currency` is the group currency. Different currencies for the same merchant produce separate candidates; amounts are never converted or merged across currencies.
- Cadence heuristic:
  - Sort occurrences by `occurredAt`.
  - Compute day gaps between consecutive occurrences.
  - `weekly` if median gap is 6-8 days.
  - `biweekly` if median gap is 12-16 days.
  - `monthly` if median gap is 27-34 days.
  - Otherwise `irregular`.
- Confidence heuristic:
  - Start with `min(1, occurrences / max(min_occurrences, 4)) * 0.4`.
  - Add up to `0.4` for cadence regularity when gaps cluster near weekly, biweekly, or monthly.
  - Add up to `0.2` for amount stability when amounts are close to the median.
  - Clamp to `0..1`.
- Sort by confidence descending, then latest amount descending.

Example queries this enables:

- "What subscriptions do I have?"
- "Find recurring merchants."
- "Which payments happen every month?"

## Tool 7: `getCashflowSummary`

Purpose: summarize income, expenses, and net cashflow over a period.

File:

`apps/api/src/chat/tools/get-cashflow-summary.ts`

ToolDef description:

```ts
description: "Summarize CAD income, expenses, and net cashflow for a period, grouped by day or account."
```

Zod args:

```ts
const Args = z.object({
  period: z.enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize cashflow."),
  group_by: z.enum(["day", "account"])
    .describe("Optional grouping dimension. Defaults to day.")
    .optional(),
});
```

Return shape:

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

Implementation notes:

- Default `group_by = "day"`.
- Query active CAD transactions in the period with `workspaceId`, `removedAt: null`, `currency: "CAD"`, and date range.
- `excludedNonCadCount` counts active transactions in the same period whose `currency` is not `"CAD"`. These rows are excluded from totals because currency conversion is out of scope.
- Sign convention:
  - Positive `amount` values are expenses.
  - Negative `amount` values are income/refunds/inflows.
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

Example queries this enables:

- "How much came in and went out this month?"
- "What's my net cashflow last month?"
- "Show cashflow by account."

## Rationale And Priority

The selected portfolio is balanced between financial exploration and account cleanup:

1. `listAccounts` is foundational context. Without it, the assistant cannot answer basic connected-account questions.
2. `getTransactionDetails` enables precise follow-up after any transaction list result.
3. `findUncategorizedTransactions` directly improves data quality and pairs with existing `categorizeTransaction`.
4. `getCategoryBreakdown` turns simple category ids into useful category analysis.
5. `compareSpendingPeriods` answers one of the most common personal-finance questions: "what changed?"
6. `detectRecurringMerchants` adds high perceived value without requiring persisted recurring rules.
7. `getCashflowSummary` covers income/expense/net questions that spending-only tools cannot answer.

Rejected alternatives:

- `searchTransactions`: useful but overlaps with `listTransactions` and would require a broader query grammar. It should wait until there is clearer evidence that users need ad hoc merchant/date/amount search from chat.
- `addTransaction`, `deleteTransaction`, `addRecurring`, `disconnectAccount`: useful but unsafe without a confirmation-card workflow.
- Persistent recurring subscriptions: useful but requires schema and product design beyond this phase.

## Scope And Blast Radius

Affected tables:

- `BankAccount`
- `PlaidItem`
- `Transaction`
- `Category`

Migrations:

- None.

APIs:

- No public route changes.
- `POST /workspaces/:id/chat/message` benefits indirectly through newly registered tools.

SDKs/dependencies:

- No new SDKs or dependencies.

Auth/tier rules:

- No changes. Existing chat route remains Pro-only and requires editor access.

Persistence/rehydration:

- No new persisted chat block types.
- Tool calls continue to persist as existing chat tool messages through the current turn processing.

UI/client assumptions:

- No mobile or web UI change required.
- Assistant responses remain text markdown generated from tool results.

Tests:

- Add direct unit tests for every new tool.
- Add registry/schema tests.
- No Playwright test is required unless implementation changes user-facing routes or UI.

Acceptance criteria:

- All seven tools are registered in `REGISTRY`.
- All args have `.describe()`.
- Every new tool can be invoked directly with `tool.run(ctx, args)`.
- Cross-workspace data is not returned.
- Transactions with `removedAt` are excluded.
- Empty-data cases return valid zero/empty responses.
- Monetary values are strings.
- Dates are ISO strings.
- CAD aggregate tools expose their CAD-only currency scope and count excluded non-CAD transactions.
- Recurring merchant candidates are grouped by normalized merchant plus currency.

## Error Handling

Use domain errors and let the dispatcher convert them to function responses:

- `getTransactionDetails`: throw `new Error("transaction_not_found")`.
- `compareSpendingPeriods`: throw `new Error("invalid_period_pair")`.

Other tools should normally return empty arrays or zero totals for no data. They should throw only for impossible internal conditions, not for normal empty states.

## Testing Plan

Add these tests:

- `apps/api/tests/chat.tools.list-accounts.test.ts`
- `apps/api/tests/chat.tools.get-transaction-details.test.ts`
- `apps/api/tests/chat.tools.find-uncategorized-transactions.test.ts`
- `apps/api/tests/chat.tools.get-category-breakdown.test.ts`
- `apps/api/tests/chat.tools.compare-spending-periods.test.ts`
- `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts`
- `apps/api/tests/chat.tools.get-cashflow-summary.test.ts`

Each tool test should include:

- Happy path.
- Empty workspace or empty relevant data.
- Workspace isolation.
- Decimal/date serialization where applicable.
- Zod validation for limits/enums where applicable.

Specific coverage:

- `periods`: covers `this_week`, `previous_week`, `this_month`, `last_month`, and `all_time` with fixed `now` values.
- `listAccounts`: excludes archived accounts by default, includes them when requested, returns institution name and Plaid item status fields, and orders deterministically.
- `getTransactionDetails`: rejects cross-workspace tx id as not found, excludes soft-deleted transactions.
- `findUncategorizedTransactions`: covers `missing_category`, `not_manual`, period filtering, limit.
- `getCategoryBreakdown`: covers category names, parent names, uncategorized include/exclude, share computation, CAD-only totals, and excluded non-CAD count.
- `compareSpendingPeriods`: covers valid pairs, invalid pair error, category comparison, merchant comparison using `normalizeMerchant`, zero baseline percent change, percent-change ratio semantics, CAD-only totals, and excluded non-CAD counts.
- `detectRecurringMerchants`: covers monthly cadence, irregular cadence, minimum occurrence filtering, income exclusion, fallback `normalizeMerchant`, and separate candidates for the same merchant in different currencies.
- `getCashflowSummary`: covers positive expense, negative income, net total, day grouping, account grouping, CAD-only totals, and excluded non-CAD count.

Add or update registry/schema tests:

- `REGISTRY` contains all seven new tool names.
- `toGeminiFunctionDeclarations` emits parameter schemas for non-zero-arg tools.
- Every top-level arg field has a non-empty description.
- Every new tool has the exact `ToolDef.description` specified in this design.

## Excluded Scope

These are intentionally out of scope:

- Dangerous writes: add transaction, delete transaction, disconnect account, add recurring rule.
- Multi-step confirmation UI or `confirm_card`.
- Rich chat block types such as category cards or recurring-payment cards.
- SSE streaming.
- Morning ritual or daily-thread behavior.
- Lite-tier chat behavior.
- PII redaction layer.
- New Prisma models, migrations, or persisted recurring-rule tables.
- Currency conversion across accounts or currencies.
- User-timezone-aware period boundaries.
- Changes to existing Gemini adapter or dispatcher.

## Self-Review Log

### Round 1

Findings:

- Important: The recurring detector could accidentally surface income deposits as recurring merchants if it grouped all transaction amounts.
- Important: `getCategoryBreakdown` and `compareSpendingPeriods` needed an explicit spending-only sign convention to avoid mixing income/refunds into spending totals.
- Important: Period pairing in `compareSpendingPeriods` needed to be strict enough that the LLM cannot compare `this_week` to `last_month`.
- Important: `all_time` period handling for cleanup needed a clear no-date-filter contract.
- Minor: The relationship between `getCategoryBreakdown` and existing `getSpendingSummary` needed clearer differentiation.

Fixes applied:

- Added positive-amount-only rules for spending and recurring tools.
- Added explicit sign convention to `getCashflowSummary`.
- Added strict valid pairs and `invalid_period_pair`.
- Added shared period helper contract with `reviewPeriodRange`.
- Added a dedicated comparison against existing `getSpendingSummary`.

### Round 2

Findings:

- Important: Recurring merchant return shape had `merchantNormalized: string`, but fallback grouping can come from `merchantRaw` when normalized text is null.
- Important: Multi-currency recurring groups could be misleading if amounts were merged without conversion.
- Important: `getTransactionDetails` needed soft-delete exclusion stated explicitly.
- Minor: Registry/schema tests should explicitly check arg descriptions because Gemini function-call quality depends on them.

Fixes applied:

- Defined `merchantNormalized` as the grouping key even when derived from raw merchant text.
- Added multi-currency rule: use newest currency and do not convert.
- Added `removedAt: null` to transaction-detail lookup notes.
- Added registry/schema test requirements for non-empty descriptions.

### Round 3

Findings:

- Important: Aggregate tools could silently mix currencies even though currency conversion is out of scope.
- Important: Exact `ToolDef.description` strings were missing, leaving LLM-facing tool selection copy to implementation guesswork.
- Important: Recurring detection grouped by merchant only while also saying multi-currency rows must not be merged.
- Important: Recurring and merchant comparison fallback grouping used raw lowercase merchant text instead of the existing `normalizeMerchant` helper.
- Minor: `listAccounts` ordering was not deterministic enough for tests.
- Minor: Period helper tests were not called out explicitly.

Fixes applied:

- Made CAD aggregate scope explicit for `getCategoryBreakdown`, `compareSpendingPeriods`, and `getCashflowSummary`.
- Added excluded non-CAD counts to CAD aggregate tools.
- Added exact `ToolDef.description` strings for all seven tools.
- Changed recurring grouping to normalized merchant plus currency.
- Changed merchant fallback normalization to `normalizeMerchant`.
- Tightened account ordering and Plaid item status fields.
- Added period helper test coverage.

### Round 4

Findings:

- Critical: 0
- Important: 0
- Minor: 0

Confirmation:

- The design uses existing models only.
- The design has no dangerous writes.
- Every proposed arg field includes `.describe()`.
- Workspace isolation is required for every tool.
- Error, empty-state, decimal, and date behavior are specified.
- Currency behavior is explicit and avoids silent cross-currency aggregation.
- The spec is ready for implementation planning after user review.
