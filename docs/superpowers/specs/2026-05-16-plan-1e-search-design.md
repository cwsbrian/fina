# Plan 1E-search Design: `findTransactions` Chat Tool

**Date:** 2026-05-16
**Status:** Final design, ready for implementation planning
**Scope:** One new read-only chat tool. No schema migration, no UI work.

---

## 1. Goal

Add a single chat tool, `findTransactions`, that lets the LLM filter transactions by merchant text, date range, amount range, category name, and account name. The existing `listTransactions` only supports a named-period filter, which is too narrow for most real questions ("show me Starbucks last month", "what did I spend over $100 on food").

This is the 12th tool in the chat registry. Both the per-thread context window (Plan 1E-threads) and the multi-thread isolation make it safe to return up to 50 rows per call — the result list stays inside the relevant thread and doesn't pollute the user's general chat.

---

## 2. Resolved decisions (from 2026-05-15 + 2026-05-16 brainstorm)

| Topic | Decision |
|---|---|
| Filter scope | merchant_query + start_date/end_date + amount_min/max + category_name + account_name. NO free-text on `note`. |
| Date input | ISO `YYYY-MM-DD` only, strict parse. No named periods. |
| Pagination | Hard cap (default 20, max 50). `totalCount` + `hasMore` exposed. No cursor, no page-based. |
| Merchant matching | Case-insensitive substring on `merchantRaw` OR `merchantNormalized`. |
| Category lookup | By exact name, case-insensitive. Unknown name → empty result, no throw. |
| Account lookup | By exact name, case-insensitive. Unknown name → empty result, no throw. |
| Sort order | Fixed `occurredAt DESC, id DESC`. Not argument-controlled. |
| Currency scope | CAD only. `excludedNonCadCount` in response. |
| Tier gate | Inherited from chat route — Pro + `editor` role required; the tool itself does not check. |

---

## 3. File location

- Create: `apps/api/src/chat/tools/find-transactions.ts`
- Create: `apps/api/tests/chat.tools.find-transactions.test.ts`
- Modify: `apps/api/src/chat/tools/index.ts` (add 12th entry to `REGISTRY`)
- Modify: `apps/api/tests/chat.tools.registry.test.ts` (bump expected tool count + descriptions table)

No other files.

---

## 4. Tool identity

```typescript
export const findTransactions: ToolDef<Args, Result> = {
  name: "findTransactions",
  description:
    "Search transactions with filters: merchant text, date range, amount range, category name, account name. " +
    "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing.",
  args: Args,
  async run(ctx, args) { ... },
};
```

The description is LLM-facing — it must telegraph (a) the available filters, (b) the row cap, (c) that totalCount is exposed for narrowing.

---

## 5. Args schema (Zod)

```typescript
const Args = z.object({
  merchant_query: z.string().min(1).max(100)
    .describe("Substring to match on merchant name. Matched case-insensitively against both the raw merchant string and the normalized merchant key. Example: 'starbucks' matches 'STARBUCKS #1234 SEATTLE'.")
    .optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Earliest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Example: '2026-04-01'.")
    .optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Latest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Must be >= start_date if both provided.")
    .optional(),
  amount_min: z.number().nonnegative()
    .describe("Minimum absolute transaction amount (CAD). Inclusive. Matches expenses or refunds whose abs(amount) is >= this value.")
    .optional(),
  amount_max: z.number().nonnegative()
    .describe("Maximum absolute transaction amount (CAD). Inclusive. Must be >= amount_min if both provided.")
    .optional(),
  category_name: z.string().min(1).max(80)
    .describe("Exact category name (case-insensitive). Empty array result if the name doesn't match an existing category.")
    .optional(),
  account_name: z.string().min(1).max(80)
    .describe("Exact bank account name (case-insensitive). Empty array result if the name doesn't match an existing account.")
    .optional(),
  limit: z.number().int().positive().max(50)
    .describe("Maximum transactions to return. Default 20, hard cap 50.")
    .optional(),
});
```

Notes:
- All fields optional. Zero filters → 20 most recent CAD transactions.
- `merchant_query` regex is not applied — it's a free string used in ILIKE.
- `start_date`/`end_date` regex catches malformed strings at Zod time; semantic correctness (`2026-02-31` etc.) is enforced in the run handler via strict re-parse.

---

## 6. Return shape

```typescript
type Result = {
  transactions: Array<{
    id: string;
    amount: string;              // Decimal.toString(), sign preserved
    currency: string;            // ISO 4217; always "CAD" in this phase
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;          // ISO 8601 full timestamp
    accountName: string;
    accountId: string;
    categoryId: string | null;
    categoryName: string | null;
    categorizationSource: "mapping" | "ai" | "manual" | null;
  }>;
  totalCount: number;            // count(*) over the same filters, no limit
  hasMore: boolean;              // totalCount > transactions.length
  filtersApplied: {
    merchantQuery: string | null;
    startDate: string | null;
    endDate: string | null;
    amountMin: number | null;
    amountMax: number | null;
    categoryName: string | null;
    accountName: string | null;
    limit: number;
  };
  excludedNonCadCount: number;   // Non-CAD transactions that match the OTHER filters
};
```

`filtersApplied` echoes the resolved filters (post-default for `limit`) so the LLM can confirm to the user what it actually searched. Both `accountId` and `accountName` are returned so the LLM can chain into `getTransactionDetails` or `compareSpendingPeriods` without a second lookup.

---

## 7. Validation helpers

```typescript
function isValidIsoDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
```

Round-trip check rejects:
- `"2026-99-99"` → `Date` is NaN → false.
- `"2026-02-31"` → parses as `2026-03-03`, round-trip mismatches the input → false.

This is the only validation gap left after Zod's regex. It runs first in `run()`.

---

## 8. Query construction (Prisma)

```typescript
async run(ctx, args) {
  const limit = args.limit ?? 20;

  // Strict date + range validation
  if (args.start_date && !isValidIsoDate(args.start_date)) throw new Error("invalid_date");
  if (args.end_date && !isValidIsoDate(args.end_date)) throw new Error("invalid_date");
  if (args.start_date && args.end_date && args.start_date > args.end_date) throw new Error("invalid_date_range");
  if (args.amount_min != null && args.amount_max != null && args.amount_max < args.amount_min) {
    throw new Error("invalid_amount_range");
  }

  // Resolve name lookups → ids. Either null → return empty result.
  let categoryId: string | undefined;
  if (args.category_name) {
    const cat = await prisma.category.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        name: { equals: args.category_name, mode: "insensitive" },
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!cat) return emptyResult(args, limit);
    categoryId = cat.id;
  }
  let accountId: string | undefined;
  if (args.account_name) {
    const acct = await prisma.bankAccount.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        name: { equals: args.account_name, mode: "insensitive" },
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!acct) return emptyResult(args, limit);
    accountId = acct.id;
  }

  // Assemble where
  const where: Prisma.TransactionWhereInput = {
    workspaceId: ctx.workspaceId,
    removedAt: null,
    currency: "CAD",
  };
  if (categoryId) where.categoryId = categoryId;
  if (accountId) where.accountId = accountId;
  if (args.start_date) {
    where.occurredAt = { ...(where.occurredAt ?? {}), gte: new Date(`${args.start_date}T00:00:00.000Z`) };
  }
  if (args.end_date) {
    where.occurredAt = { ...(where.occurredAt ?? {}), lte: new Date(`${args.end_date}T23:59:59.999Z`) };
  }

  // amount filter on abs(amount). Express as OR of (positive range) and (negative range).
  if (args.amount_min != null || args.amount_max != null) {
    const min = args.amount_min ?? 0;
    const max = args.amount_max ?? Number.MAX_SAFE_INTEGER;
    where.OR = [
      { amount: { gte: min, lte: max } },
      { amount: { gte: -max, lte: -min } },
    ];
  }

  // merchant ILIKE on raw OR normalized. Combine with existing OR (amount) via AND if needed.
  if (args.merchant_query) {
    const merchantOr = [
      { merchantRaw: { contains: args.merchant_query, mode: "insensitive" as const } },
      { merchantNormalized: { contains: args.merchant_query, mode: "insensitive" as const } },
    ];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: merchantOr }];
      delete where.OR;
    } else {
      where.OR = merchantOr;
    }
  }

  // Parallel: page + count + non-CAD count
  const [rows, totalCount, excludedNonCadCount] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        account: { select: { id: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.count({ where: { ...where, currency: { not: "CAD" } } }),
  ]);

  return {
    transactions: rows.map(serialize),
    totalCount,
    hasMore: totalCount > rows.length,
    filtersApplied: resolveFilters(args, limit),
    excludedNonCadCount,
  };
}
```

`serialize(row)` shapes a Prisma row into the public type. `emptyResult(args, limit)` returns the zero-result shell with `filtersApplied` populated.

---

## 9. Error handling

| Condition | Code | Where |
|---|---|---|
| `start_date` or `end_date` fails strict round-trip (e.g. `2026-99-99`, `2026-02-31`) | `invalid_date` | `run()` after Zod |
| `end_date < start_date` | `invalid_date_range` | `run()` |
| `amount_max < amount_min` | `invalid_amount_range` | `run()` |
| `category_name` doesn't match any workspace category | (no throw — empty result) | category lookup |
| `account_name` doesn't match any workspace account | (no throw — empty result) | account lookup |
| Zod top-level (limit > 50, malformed types, etc.) | thrown by Zod, caught by dispatcher | pre-run |

**Rationale for "empty result, no throw" on unknown name:** the LLM may misspell or hallucinate a category/account name. Empty result + `filtersApplied` echo lets it self-correct conversationally ("I don't see a category called 'Foods' — did you mean 'Food'?") instead of failing the turn.

All thrown errors are `new Error("<snake_case_code>")` — consistent with the rest of the 11 read-only tools.

---

## 10. Testing plan

`apps/api/tests/chat.tools.find-transactions.test.ts` — single file, ~19 cases.

### 10.1 Happy paths
- No filters → 20 most recent active CAD transactions
- `merchant_query` only → ILIKE on raw + normalized, both matched
- `start_date` + `end_date` only → inclusive range
- `amount_min` + `amount_max` only → matches abs(amount) for expenses AND refunds
- `category_name` (case-insensitive) → resolves to id, filters
- `account_name` (case-insensitive) → resolves to id, filters
- All filters combined → AND'd correctly

### 10.2 Sort + pagination
- `limit=5` returns 5 rows, `totalCount` is full count, `hasMore=true`
- Result sorted by `occurredAt DESC, id DESC` deterministically

### 10.3 Edge cases
- `category_name` not in workspace → empty `transactions`, `totalCount=0`
- `account_name` not in workspace → empty `transactions`, `totalCount=0`
- `excludedNonCadCount` reflects non-CAD txns matching OTHER filters
- Workspace isolation: cross-workspace data not returned
- Soft-deleted transactions (`removedAt != null`) excluded from results AND count

### 10.4 Validation
- `start_date="2026-99-99"` → throws `invalid_date`
- `start_date="2026-02-31"` → throws `invalid_date`
- `start_date="2026-04-15"`, `end_date="2026-04-01"` → throws `invalid_date_range`
- `amount_min=100`, `amount_max=50` → throws `invalid_amount_range`
- `limit=51` → Zod fails at dispatcher boundary

### 10.5 Registry schema regression
- `chat.tools.registry.test.ts` updates the expected tool count from 11 to 12 and adds `findTransactions` + its description string to the expected-descriptions table.

---

## 11. Acceptance criteria

This phase is complete when:

- `findTransactions` registered as the 12th entry in `REGISTRY`, with the exact description string from §4.
- All 8 args have `.describe()` text.
- Strict date validation rejects `2026-99-99` and `2026-02-31`.
- `end_date >= start_date` and `amount_max >= amount_min` enforced.
- Unknown `category_name` / `account_name` returns empty result (no throw).
- Merchant matching is case-insensitive substring on `merchantRaw` OR `merchantNormalized`.
- Sort is fixed `occurredAt DESC, id DESC`.
- Default `limit=20`, hard cap `50`.
- Response includes `totalCount`, `hasMore`, `filtersApplied`, `excludedNonCadCount`.
- Workspace isolation enforced (`workspaceId: ctx.workspaceId` on all queries).
- Soft-deleted transactions excluded.
- CAD-scoped with `excludedNonCadCount` exposed.
- All test cases (10.1–10.5) pass.
- Existing 11 tool tests untouched and still passing.

---

## 12. Excluded scope

The following are explicitly NOT in this plan:

- Free-text search on transaction `note` field — rejected during brainstorm.
- Named period filters (`this_week`, `this_month`, `last_month`) — date range is the only date input.
- Cursor or page-based pagination — hard cap only.
- Currency conversion or multi-currency aggregation.
- Argument-controlled sort.
- Category-by-id or account-by-id filter — name-only.
- Refactoring `listTransactions` to add filters — separate concern.
- UI rendering of search results — Plan 1E-UI follow-up.

---

## 13. Follow-up candidates

- **Plan 1E-write:** safe chat writes (`createCategory`, `addTransactionNote`) with confirmation UX.
- **Plan 1E-UI:** web + mobile chat consuming the multi-thread API + rendering the 12 tools' result shapes (this tool's table-shaped output is a key use case).
- **Plan 1E-time:** Plaid date-only storage policy + user-timezone correctness across transaction APIs.
- **Plan 1E-note-search:** add free-text search on the `note` field once UX demand is proven.
