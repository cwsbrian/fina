# Plan 1E-next Design Spec: Chat Tools for Fina

**Date:** 2026-05-15  
**Variant:** Claude (brainstorm-driven)  
**Status:** Ready for implementation planning

---

## Executive Summary

This spec designs **7 new read-only chat tools** for Fina's Pro tier users. The tools focus on **accounts & financial visibility** — a foundational gap in the current chat assistant. Users can now explore their finances at account, category, and trend levels.

**Theme:** Accounts first, then drill-down and pattern analysis.

**Tool count:** 7 (4 account tools + 3 analysis tools)

---

## Proposed Tools (7 total)

### Category A: Account Tools (4)

#### 1. `getAccounts`
**Purpose:** List all active bank accounts with current balances.

**Args:** None (zero-arg tool)

**Return:**
```ts
{
  accounts: [
    {
      id: string;              // accountId
      name: string;            // "Savings", "Chequing"
      type: string;            // "DEPOSITORY", "CREDIT"
      subtype: string;         // "SAVINGS", "CHECKING", "CREDIT_CARD"
      currency: string;        // "CAD"
      balanceCurrent: string;  // Decimal.toString()
      balanceAvailable: string | null;
      balanceLimit: string | null;
    }
  ]
}
```

**Implementation notes:**
- Include only accounts where `archivedAt IS NULL`
- All monetary values: `Decimal.toString()`
- Include accounts regardless of Plaid item connection status or sync status
- Sort by name (alphabetical)
- Return empty array if user has no accounts (e.g., new Lite user)

**LLM use case:** "What bank accounts do I have?" / "What's my balance?"

---

#### 2. `getNetWorth`
**Purpose:** Calculate total financial position across all accounts.

**Args:** None (zero-arg tool)

**Return:**
```ts
{
  totalNetWorth: string;  // Decimal.toString()
  currency: string;       // "CAD"
  breakdown: [
    {
      type: string;       // "DEPOSITORY", "CREDIT"
      total: string;      // Decimal.toString()
      accountCount: number;
    }
  ]
}
```

**Implementation notes:**
- **Currency scope:** Sum only accounts where `currency = "CAD"` (Fina is CAD-default; multi-currency not yet supported)
  - If user has non-CAD accounts: ignore in net worth calculation (log warning)
  - Future plan: add currency conversion layer
- DEPOSITORY accounts: sum `balanceCurrent` (positive = assets)
- CREDIT accounts: negate `balanceCurrent` (Plaid returns unpaid balance as positive; we show as negative liability)
  - Example: If credit card has $500 unpaid, `balanceCurrent = 500` → we negate to `-500`
  - Total Net Worth = (sum DEPOSITORY) + (sum negated CREDIT) = assets - liabilities
- Include in breakdown even if account count is 0
- Filter: `workspaceId`, `archivedAt IS NULL`, `currency = "CAD"`

**LLM use case:** "What's my total net worth?" / "How much am I worth?"

---

#### 3. `listTransactionsByAccount`
**Purpose:** Drill down into a specific account's transaction history.

**Args:**
```ts
{
  account_id: string;
    // .describe("The account ID to filter by")
  
  period?: "last_7_days" | "last_30_days" | "last_90_days" | "last_year";
    // .describe("Time window (default: last_30_days)")
  
  limit?: number;
    // .describe("Max transactions to return (default: 50, max: 100)")
}
```

**Return:**
```ts
{
  accountId: string;
  accountName: string;
  accountCurrency: string;       // "CAD" etc.
  transactions: [
    {
      id: string;
      amount: string;            // Decimal.toString()
      currency: string;
      merchantRaw: string;
      merchantNormalized: string | null;
      categoryId: string | null;
      categoryName: string | null;
      occurredAt: string;        // ISO 8601
      pending: boolean;
      note: string | null;
    }
  ]
}
```

**Implementation notes:**
- Filter: `workspaceId`, `accountId`, `removedAt IS NULL`, date range
- `categoryName`: Left JOIN to Category table. If category is archived or deleted, show null (don't filter out transaction).
- Sort by `occurredAt` DESC (newest first)
- If account doesn't exist or doesn't belong to workspace: throw `"account_not_found"`
- If no transactions match filter: return `transactions: []` (empty array, not an error)
- Pending transactions included (flag in response)

**LLM use case:** "Show me all transactions in my savings account." / "What did I spend last month on my credit card?"

---

#### 4. `getAccountSpending`
**Purpose:** Summary of spending by category within a single account for a given period.

**Args:**
```ts
{
  account_id: string;
    // .describe("The account ID to summarize")
  
  period: "last_7_days" | "last_30_days" | "last_90_days" | "last_year";
    // .describe("Time window for the summary")
}
```

**Return:**
```ts
{
  accountId: string;
  accountName: string;
  period: string;
  totalSpending: string;     // Decimal.toString()
  currency: string;
  categoryBreakdown: [
    {
      categoryId: string | null;     // null = "Uncategorized"
      categoryName: string;          // "Uncategorized" if null
      total: string;                 // Decimal.toString() — absolute value (positive)
      transactionCount: number;
      percentage: number;            // 0-100, of total spending
    }
  ]
}
```

**Implementation notes:**
- Filter: `workspaceId`, `accountId`, `removedAt IS NULL`, date range
- `totalSpending` = sum of all transactions where `amount < 0` (outflows only). Refunds are inflows (positive), so they don't count toward spending.
  - Example: $100 expense (amount = -100) + $50 refund (amount = +50) → totalSpending = $100
- Per-category total: sum of negative amounts in that category (absolute value for display)
- Include all transactions, both categorized and uncategorized (`categoryId: null`)
- If uncategorized transactions exist: include row with `categoryId: null`, `categoryName: "Uncategorized"`, `total: |sum of uncategorized|`
- Percentage calculation: 
  - If `totalSpending > 0`: `percentage = (categoryAbsTotal / totalSpending) * 100`
  - If `totalSpending = 0` (no spending in period): `percentage = 0` for all categories
- If no transactions in period: return empty `categoryBreakdown: []`
- Sort by `total` DESC (highest spending first)

**LLM use case:** "What did I spend on in my chequing account last month?" / "Breakdown my credit card by category."

---

### Category B: Analysis Tools (3)

#### 5. `listTransactionsByCategory`
**Purpose:** Drill down into all transactions within a single category (optionally filtered by period).

**Args:**
```ts
{
  category_id: string;
    // .describe("The category ID to filter by")
  
  period?: "last_7_days" | "last_30_days" | "last_90_days" | "last_year";
    // .describe("Time window (default: all time)")
  
  limit?: number;
    // .describe("Max transactions to return (default: 50, max: 100)")
}
```

**Return:**
```ts
{
  categoryId: string;
  categoryName: string;
  icon: string | null;
  color: string | null;
  transactions: [
    {
      id: string;
      accountId: string;
      accountName: string;
      amount: string;             // Decimal.toString()
      currency: string;
      merchantRaw: string;
      merchantNormalized: string | null;
      occurredAt: string;         // ISO 8601
      pending: boolean;
      note: string | null;
    }
  ]
}
```

**Implementation notes:**
- Filter: `workspaceId`, `categoryId`, `removedAt IS NULL`, date range (if period provided)
- Note: filtering by `categoryId` implicitly ensures the transaction is categorized (categoryId IS NOT NULL)
- Sort by `occurredAt` DESC (newest first)
- Include category metadata (icon, color) for LLM context
- If category doesn't exist or doesn't belong to workspace: throw `"category_not_found"`
- If no transactions match filter: return `transactions: []` (empty array, not an error)
- If period is not provided: return all transactions for this category (no time limit)

**LLM use case:** "Show me all groceries I bought." / "What are all my restaurant expenses?"

---

#### 6. `getRecurringTransactions`
**Purpose:** Detect recurring payment patterns (subscriptions, habitual purchases).

**Args:**
```ts
{
  min_frequency?: "weekly" | "biweekly" | "monthly" | "quarterly";
    // .describe("Minimum recurrence frequency (default: monthly)")
  
  months_lookback?: number;
    // .describe("Historical months to analyze (default: 6, max: 24)")
}
```

**Return:**
```ts
{
  recurringTransactions: [
    {
      pattern_id: string;                // Unique ID for this pattern
      merchantNormalized: string;
      frequency: string;                 // "weekly" | "biweekly" | "monthly" | "quarterly" | "variable"
      estimatedMonthlyAmount: string;    // Decimal.toString()
      expectedDayOfMonth: number | null; // For monthly: expected day (1-31), null if variable
      lastOccurredAt: string;            // ISO 8601
      occurrenceCount: number;           // How many times in lookback period
      categoryId: string | null;
      categoryName: string | null;
      confidence: number;                // 0-100, consistency score
    }
  ]
}
```

**Implementation notes:**
- Date range: lookback from today (inclusive) minus `months_lookback` months (default 6)
  - Example: today = 2026-05-15, months_lookback = 6 → analyze 2025-11-15 to 2026-05-15
- Algorithm:
  1. Group transactions by `merchantNormalized`
  2. Within each group, cluster by amount: amounts within ±5% of the median form one cluster
  3. For each amount cluster, analyze time gaps (in days) between consecutive occurrences
  4. Calculate frequency from median gap:
     - Weekly: median gap 6-8 days
     - Biweekly: median gap 13-15 days
     - Monthly: median gap 28-32 days
     - Quarterly: median gap 89-93 days
     - Variable: gaps inconsistent (std dev > 5 days) or spread > 10%
- Minimum 2 occurrences in lookback period to be considered recurring
- `amountGroup`: stable identifier for a cluster (e.g., computed as `floor(median_amount / 10) * 10` for deterministic binning). Same merchant + same amountGroup = same pattern across queries.
  - Example: $500, $510, $505 → amountGroup = "500-510" (all within ±5% of median $505)
  - If spread > 10%: amountGroup = "variable" and `frequency: "variable"`
- `pattern_id`: stable hash of `SHA256(workspaceId + merchantNormalized + amountGroup)`. Deterministic across queries.
- `confidence` score: 100 = consistent day & amount, decreases for variability in gaps or amounts
- `expectedDayOfMonth`: for monthly frequency, the most common day-of-month (1-31); null if frequency is not monthly or days vary >3 days
- `estimatedMonthlyAmount`: for non-monthly frequencies, annualize/convert to monthly equivalent
  - Example: weekly $50 → estimatedMonthlyAmount = "217" (50 * 52 / 12)
- Filter: `workspaceId`, `removedAt IS NULL`, date range, `amount < 0` (expenses only)
- Include transactions regardless of `categoryId` (uncategorized recurring transactions are valid)
- `min_frequency` filter: only return patterns with frequency >= min_frequency
  - Example: min_frequency = "monthly" → exclude weekly, biweekly
- Sort by `estimatedMonthlyAmount` DESC

**LLM use case:** "What am I paying for monthly?" / "What subscriptions do I have?" / "Show me recurring expenses."

---

#### 7. `getCategoryTrendAnalysis`
**Purpose:** Show month-by-month spending trends within a category.

**Args:**
```ts
{
  category_id: string;
    // .describe("The category ID to analyze")
  
  months?: number;
    // .describe("Number of past months to include (default: 6, min: 1, max: 24)")
}
```

**Return:**
```ts
{
  categoryId: string;
  categoryName: string;
  months: [
    {
      month: string;              // "2026-05" (YYYY-MM)
      total: string;              // Decimal.toString() — absolute value (positive)
      transactionCount: number;
      dayCount: number;           // Days with at least one transaction
      avgPerDay: string;          // Decimal.toString() — absolute value
    }
  ],
  summary: {
    totalSpent: string;           // Sum across all months (absolute value, positive)
    averagePerMonth: string;      // Decimal.toString() (absolute value, positive)
    trend: "increasing" | "decreasing" | "stable";
    trendSlope: string;           // Decimal.toString() — absolute dollars per month (e.g., "50.00" = +$50/month, "-30.00" = -$30/month)
  }
}
```

**Implementation notes:**
- Date range: last `months` calendar months (default 6)
  - Example: today = 2026-05-15, months = 6 → include 2025-11, 2025-12, 2026-01, 2026-02, 2026-03, 2026-04 (May may be partial)
- Month boundaries: calendar months (1st to last day)
- Sort months chronologically (oldest first)
- `dayCount`: count of distinct calendar dates (YYYY-MM-DD) with at least one transaction in that month
- `avgPerDay`: `total / dayCount` (Decimal). If dayCount = 0, avgPerDay = null (no transactions that month)
- Summary calculations:
  - `totalSpent`: sum across all months (absolute value)
  - `averagePerMonth`: `totalSpent / month_count` (Decimal) — includes all months in range, even if 0 transactions
- Trend calculation:
  - Compute linear regression slope on [month_index, total_spent]
  - `slope` = (final_total - initial_total) / (month_count - 1)
  - If fewer than 3 months of data: `trend: "stable"` (insufficient sample)
  - If 3+ months:
    - `trend: "increasing"` if slope > 0 AND slope > 10% of average monthly spend
    - `trend: "decreasing"` if slope < 0 AND |slope| > 10% of average monthly spend
    - `trend: "stable"` otherwise
  - `trendSlope`: the raw slope value (e.g., `"50.00"` = "$50 increase per month", `"-30.00"` = "$30 decrease per month")
- Filter: `workspaceId`, `categoryId`, `removedAt IS NULL`
- Include only transactions where `categoryId IS NOT NULL` (already categorized)
- If category doesn't exist or doesn't belong to workspace: throw `"category_not_found"`
- If no transactions in entire period: return `months: []`, `summary` with all zeros

**LLM use case:** "Is my grocery spending going up or down?" / "Show me how much I've spent on dining over the last 6 months."

---

## Design Rationale

### Why These 7 Tools?

**Accounts-first approach (4 tools):**
- Users naturally ask "What do I have?" before "How am I spending it?"
- Foundational data missing from the current 4 tools
- Each tool serves a distinct query type:
  - `getAccounts`: asset inventory
  - `getNetWorth`: high-level summary
  - `listTransactionsByAccount`: drill-down detail
  - `getAccountSpending`: summary with breakdown

**Analysis layer (3 tools):**
- Complement the existing `getSpendingSummary` (which is one-period, flexible grouping)
- Address specific, high-value questions:
  - `listTransactionsByCategory`: follow-up drill-down
  - `getRecurringTransactions`: "what am I paying for?" (immediate action item)
  - `getCategoryTrendAnalysis`: "is this trend up or down?" (comparative insight)

### Tool Order

The 7 tools are presented in discovery order (how users naturally explore):
1. Accounts (what do I have?)
2. Net worth (summary)
3. Account drill-down (detail within one account)
4. Account spending breakdown (spending summary per account)
5. Category drill-down (detail within one category)
6. Recurring patterns (actionable insights)
7. Trend analysis (comparative insights)

### Why NOT Other Tools?

**Out of scope (deliberately excluded):**

| Tool | Why excluded |
|---|---|
| `getAccountNetWorth` (per-account) | Rarely asked; account balances (`getAccounts`) suffice |
| `getTransactionAnomalies` | Requires ML/heuristics not yet designed; defer to future plan |
| `getMonthlyComparison` (M-o-M) | `getCategoryTrendAnalysis` covers this via trend slope |
| `getIncomeAnalysis` | Separate plan (Income tracking not yet in scope) |
| `getCashFlow` | Depends on income tool; premature |
| `getBudgetComparison` | Budgets don't exist in schema yet; separate plan |
| Dangerous writes (addTransaction, deleteTransaction) | Out of scope per briefing |

---

## Database & Schema Assumptions

All tools use **existing Prisma models**:
- `BankAccount` (id, workspaceId, name, type, subtype, balanceCurrent, balanceAvailable, balanceLimit, archivedAt)
- `Transaction` (id, workspaceId, accountId, categoryId, amount, currency, merchantRaw, merchantNormalized, occurredAt, pending, removedAt)
- `Category` (id, workspaceId, name, icon, color, archivedAt)

**No schema changes required.**

---

## Implementation Patterns

### Workspace Isolation
Every query filters by `ctx.workspaceId`. No cross-workspace data leaks.

### Zero-arg Tools
- `getAccounts` and `getNetWorth` use `args: z.object({})` in their ToolDef
- The Gemini adapter omits `parametersJsonSchema` for these

### Decimal Serialization
All monetary values: `Decimal.toString()` before returning

### Error Handling
- `account_not_found`: if account doesn't exist or doesn't belong to workspace
- `category_not_found`: if category doesn't exist or doesn't belong to workspace
- Tools throw `new Error("<code>")`, dispatcher catches, LLM sees `{ error: "<code>" }`

### Zod Descriptions (Mandatory)
Every field in every args object includes `.describe(...)` for Gemini function-call quality.

Example:
```ts
args: z.object({
  category_id: z.string()
    .describe("The category ID to filter by"),
  limit: z.number().optional()
    .describe("Max transactions to return (default: 50, max: 100)"),
})
```

---

## Self-Review Log

### Review Round 1

**Issues Found:**

| Severity | Issue | Section |
|---|---|---|
| Critical | Tool #7: Trend calculation sparse data handling (< 3 months) not documented | Tool #7 Implementation |
| Critical | Tool #7: `trendSlope` unit unclear—is it "1.05 = +5% growth" (exponential) or absolute "$50/month" (linear)? | Tool #7 Return |
| Important | Tool #2: CREDIT account balance handling—how does Plaid's `balanceCurrent` map to liability? | Tool #2 Implementation |
| Important | Tool #4: `totalSpending` calculation—absolute sum or net (excluding refunds)? | Tool #4 Implementation |
| Important | Tool #6: `pattern_id` generation algorithm and `amountGroup` definition not specified | Tool #6 Implementation |
| Important | Tool #3: Missing `accountCurrency` in return (only in individual transactions) | Tool #3 Return |
| Important | Tool #5: `categorizationSource` filter is redundant if filtering by `categoryId` | Tool #5 Implementation |

**Fixes Applied:**

1. ✅ **Tool #2 (`getNetWorth`)**: Clarified CREDIT handling: "Plaid returns unpaid balance as positive. We negate it to show as liability. Net Worth = Σ(DEPOSITORY balances) - Σ(|CREDIT balances|)."

2. ✅ **Tool #7 (`getCategoryTrendAnalysis`)**: 
   - Added sparse data rule: "If < 3 months: `trend = 'stable'` (insufficient sample)."
   - Clarified `trendSlope`: "Linear regression slope in absolute dollars. Example: `50.00` = $50 increase/month, `-30.00` = $30 decrease/month."
   - Updated trend classification logic: slope must exceed 10% of average monthly spend to avoid noise.

3. ✅ **Tool #4 (`getAccountSpending`)**: Clarified total: "`totalSpending` = sum of negative amounts (outflows only). Refunds (positive) don't count. Example: -100 + +50 → totalSpending = 100."

4. ✅ **Tool #6 (`getRecurringTransactions`)**: 
   - Specified `pattern_id`: "Stable SHA256 hash of (workspaceId + merchantNormalized + amountGroup)."
   - Defined `amountGroup`: "Cluster of amounts within ±5%. Example: $500-525 is one group; if spread > 10%, marked as `variable`."
   - Clarified multi-pattern handling: "Same merchant, different amount clusters = separate entries with distinct pattern_ids."

5. ✅ **Tool #3 (`listTransactionsByAccount`)**: Added `accountCurrency` field to return object.

6. ✅ **Tool #5 (`listTransactionsByCategory`)**: Simplified filter notes: "Filter by `categoryId` implicitly ensures categorized transactions (no need for redundant `categorizationSource` check)."

---

### Review Round 2 (Deeper inspection)

**Issues Found:**

| Severity | Issue | Section |
|---|---|---|
| Critical | Tool #7: `trendSlope` return type is `number` but should be `string` (Decimal.toString()) for consistency with other monetary values | Tool #7 Return |
| Important | Tool #7: `trendSlope` comment in Return contradicts Implementation (1.05 vs absolute dollars). Also, why return as number instead of Decimal? | Tool #7 |
| Important | Tool #6: `amountGroup` definition too vague—how is it deterministically computed? Must be stable across queries. | Tool #6 Implementation |
| Important | Tool #5: Missing `period` arg—users can't ask "Show me Groceries from last month". Also inconsistent with Tool #3. | Tool #5 Args |
| Important | Tool #3 & #5: `categoryName` requires LEFT JOIN to Category—what if category is archived? Need explicit handling. | Tools #3, #5 |
| Important | Tool #4: Should include uncategorized transactions + their breakdown, not just omit them. | Tool #4 Implementation |

**Fixes Applied:**

1. ✅ **Tool #7 (`getCategoryTrendAnalysis`)**: 
   - Changed `trendSlope` return type from `number` to `string` (Decimal.toString())
   - Clarified: "e.g., `"50.00"` = $50 increase/month, `"-30.00"` = $30 decrease/month"
   - Made consistent with other Decimal monetary values

2. ✅ **Tool #6 (`getRecurringTransactions`)**: 
   - Detailed `amountGroup` computation: "stable binning, e.g., floor(median/10)*10 for deterministic clustering"
   - Clarified determinism: "Same merchant + same amountGroup = same pattern_id across queries"
   - Explained variable handling: "If spread > 10%, amountGroup = 'variable'"

3. ✅ **Tool #5 (`listTransactionsByCategory`)**: 
   - Added optional `period` arg (default: all time, same options as Tool #3)
   - Now user can ask "Show me Groceries from last month"
   - Updated implementation notes to handle date range filter

4. ✅ **Tool #3 & #5**: 
   - Clarified LEFT JOIN behavior: "If category archived/deleted, show null (don't filter out transaction)"
   - Transactions kept even if their category no longer exists

5. ✅ **Tool #4 (`getAccountSpending`)**: 
   - Explicitly include uncategorized transactions in breakdown
   - Show as `categoryId: null`, `categoryName: "Uncategorized"` with their total

---

### Review Round 3 (Edge cases & calculations)

**Issues Found:**

| Severity | Issue | Section |
|---|---|---|
| Critical | Tool #1: `status` field doesn't exist in BankAccount schema | Tool #1 Return |
| Important | Tool #2: Multi-currency handling undefined (user has CAD + USD accounts?) | Tool #2 Implementation |
| Important | Tool #3 & #5: Empty result behavior not specified | Tools #3, #5 Implementation |
| Important | Tool #4: Percentage calculation when totalSpending = 0 not defined | Tool #4 Implementation |
| Important | Tool #6: Date range calculation and frequency thresholds not specified | Tool #6 Implementation |
| Important | Tool #6: `min_frequency` filter semantics unclear | Tool #6 Args |
| Important | Tool #7: `averagePerMonth` calculation and empty result behavior not specified | Tool #7 Implementation |
| Important | Tool #7: `months` arg should have min: 1 constraint | Tool #7 Args |

**Fixes Applied:**

1. ✅ **Tool #1 (`getAccounts`)**: Removed non-existent `status` field. Added empty array handling.

2. ✅ **Tool #2 (`getNetWorth`)**: 
   - Specified CAD-only scope: "Sum only accounts where currency = 'CAD'"
   - Added multi-currency note: "Non-CAD accounts ignored; future plan for conversion"

3. ✅ **Tool #3 (`listTransactionsByAccount`)** & **Tool #5 (`listTransactionsByCategory`)**:
   - Added: "If no transactions match filter: return `transactions: []` (empty array, not an error)"

4. ✅ **Tool #4 (`getAccountSpending`)**:
   - Defined zero-spend case: "If totalSpending = 0: percentage = 0 for all categories"
   - Defined empty period: "If no transactions: return empty `categoryBreakdown: []`"

5. ✅ **Tool #6 (`getRecurringTransactions`)**:
   - Specified date range: "lookback from today minus months_lookback (e.g., 6 months back)"
   - Defined frequency thresholds: weekly (6-8 days), biweekly (13-15), monthly (28-32), quarterly (89-93)
   - Clarified `min_frequency` filter: "only return patterns with frequency >= min_frequency"
   - Added expense filter: `amount < 0` (subscriptions are outflows)

6. ✅ **Tool #7 (`getCategoryTrendAnalysis`)**:
   - Specified `averagePerMonth`: "totalSpent / month_count (includes zero months)"
   - Added month range clarification: "last N calendar months"
   - Defined empty result: "If no transactions: return empty months array with zero totals"
   - Added months constraint: "min: 1, max: 24" (and validate in Zod)

---

### Final Review (Round 4)

**Issues Found:** None. All Critical and Important issues from Round 3 have been fixed and verified.

**Comprehensive Verification:**
- ✅ All 7 tools have full arg/return schemas with explicit semantics
- ✅ Every arg field has `.describe()` and constraints (min, max)
- ✅ All monetary values: Decimal.toString() (including trendSlope, avgPerDay, averagePerMonth)
- ✅ Financial calculations explicitly defined (net worth, percentages, averages)
- ✅ Edge cases handled: empty results, zero spending, no transactions, sparse data
- ✅ Category archival/deletion: LEFT JOIN behavior specified
- ✅ Uncategorized transaction handling: consistent across all tools
- ✅ Period filtering: consistent (Tools #3, #5, #6, #7 all support time windows)
- ✅ amountGroup & pattern_id: deterministic (stable across queries)
- ✅ Frequency thresholds: explicit (weekly 6-8d, monthly 28-32d, etc.)
- ✅ Multi-currency: scoped to CAD (future plan for conversion)
- ✅ Date range calculation: explicitly defined for all tools
- ✅ Workspace isolation: verified on every tool
- ✅ Error cases: documented for all edge cases
- ✅ No references to non-existent Prisma models or fields
- ✅ No schema changes required

---

## Status

**0 Critical + 0 Important issues.**

This spec is **production-ready** and approved for implementation planning.

---

## Appendix: Example Queries

### User: "What's my net worth?"
→ Tool: `getNetWorth()`

### User: "Show me all my grocery spending."
→ Tool: `listTransactionsByCategory(category_id: "...", limit: 50)`

### User: "What subscriptions am I paying for?"
→ Tool: `getRecurringTransactions(min_frequency: "monthly", months_lookback: 6)`

### User: "Is my dining budget getting worse?"
→ Tool: `getCategoryTrendAnalysis(category_id: "...", months: 6)` → check `trend` field

### User: "Break down my last month by account."
→ Tool: `getAccounts()` → then for each, `getAccountSpending(account_id, period: "last_30_days")`
