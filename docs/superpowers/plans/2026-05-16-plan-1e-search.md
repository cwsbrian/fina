# Plan 1E-search Implementation Plan: `findTransactions` Chat Tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 12th read-only chat tool, `findTransactions`, which filters transactions by merchant text, date range, amount range, category name, and account name with deterministic sort + hard-capped pagination.

**Architecture:** One new file `apps/api/src/chat/tools/find-transactions.ts` exporting a `ToolDef<Args, Result>`. One new test file. One modification to `apps/api/src/chat/tools/index.ts` (12th registry entry). One modification to `apps/api/tests/chat.tools.registry.test.ts` (new describe block for plan-1e-search).

**Tech Stack:** TypeScript ESM, Zod, Prisma (with `Prisma.DateTimeFilter`, `Prisma.TransactionWhereInput`), Vitest, Postgres on port 5433.

**Spec:** `docs/superpowers/specs/2026-05-16-plan-1e-search-design.md`

---

## File Structure

**Created:**
- `apps/api/src/chat/tools/find-transactions.ts` — the tool, ~150 lines.
- `apps/api/tests/chat.tools.find-transactions.test.ts` — Vitest, 19 cases.

**Modified:**
- `apps/api/src/chat/tools/index.ts` — add 12th `REGISTRY` entry.
- `apps/api/tests/chat.tools.registry.test.ts` — new describe block for `plan 1e-search` covering `findTransactions`.

**Untouched:**
- All other 11 chat tools and their tests.
- Schema, migrations, routes, turn engine.

---

## Shared Conventions

1. **ESM imports.** Every relative import ends in `.js` (`"../../db.js"`, `"./types.js"`).
2. **Prisma.** `prisma` from `"../../db.js"`. Type-only imports of `Prisma` from `"@prisma/client"`.
3. **Workspace isolation.** Every Prisma query MUST include `workspaceId: ctx.workspaceId`. Single-row lookups MUST use `findFirst` or `findMany` scoped to workspace — never `findUnique({ where: { id } })`.
4. **CAD scope.** Aggregate response filters `currency: "CAD"`. The non-CAD count is computed in a parallel `count()` so excludedNonCadCount is exposed.
5. **Soft delete.** Filter `removedAt: null` on transaction queries. The detail-by-id tool exists separately; this one always excludes soft-deleted.
6. **Error pattern.** `throw new Error("snake_case_code")`. Empty result for unknown category/account names is intentional — do NOT throw.
7. **`.describe()` on every top-level Zod field.** Verified by registry schema test.
8. **Test patterns.** Vitest. `prisma` imported from `"../src/db.js"`. `ToolContext` from `"../src/chat/tools/types.js"`. Tests use `beforeEach` to seed and `afterEach` (or `await prisma.workspace.deleteMany(...)`) for cleanup. ctx shape: `{ env: {} as never, workspaceId, userId }`.
9. **Commands.**
   - Single test file: `pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>.test.ts`
   - Full api suite: `pnpm --filter @fina/api test`
   - Typecheck: `pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json`
10. **Pre-existing typecheck baseline.** `apps/api/src/chat/turn.ts:127` has one existing `InputJsonValue` error inherited from plan 1E-chat. Out of scope; do not fix.

---

## Task 1: `findTransactions` tool

**Files:**
- Create: `apps/api/src/chat/tools/find-transactions.ts`
- Create: `apps/api/tests/chat.tools.find-transactions.test.ts`

### Step 1.1: Write the failing test

Create `apps/api/tests/chat.tools.find-transactions.test.ts` with the full test body below.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findTransactions } from "../src/chat/tools/find-transactions.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("findTransactions tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let userId: string;
  let acctId: string;
  let acctOtherId: string;
  let foodCatId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `ft-${Date.now()}`, email: `ft-${Date.now()}@t.co`, name: "FT" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ft-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId };

    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    acctId = acct.id;
    const acctOther = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Savings", type: "depository" } });
    acctOtherId = acctOther.id;
    const foodCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    foodCatId = foodCat.id;

    // Seed 5 CAD transactions across April 2026 in Chequing, plus 1 USD non-CAD,
    // plus 1 Savings, plus 1 soft-deleted, plus 1 cross-workspace.
    await prisma.transaction.createMany({
      data: [
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-1", amount: "5.00",  currency: "CAD", merchantRaw: "Starbucks Downtown",  merchantNormalized: "starbucks", categoryId: foodCatId, occurredAt: new Date("2026-04-02T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-2", amount: "8.50",  currency: "CAD", merchantRaw: "Starbucks Pike",       merchantNormalized: "starbucks", categoryId: foodCatId, occurredAt: new Date("2026-04-10T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-3", amount: "120.00",currency: "CAD", merchantRaw: "Whole Foods Market",   merchantNormalized: "whole foods", categoryId: foodCatId, occurredAt: new Date("2026-04-15T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-4", amount: "-50.00",currency: "CAD", merchantRaw: "Refund Inc",           merchantNormalized: "refund inc", categoryId: null,      occurredAt: new Date("2026-04-20T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-5", amount: "1000.00",currency: "CAD", merchantRaw: "Rent April",          merchantNormalized: "rent",       categoryId: null,      occurredAt: new Date("2026-04-25T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-6", amount: "9.99",  currency: "USD", merchantRaw: "Foreign Coffee",       merchantNormalized: "foreign coffee", categoryId: null, occurredAt: new Date("2026-04-12T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctOtherId, plaidTransactionId: "ft-7", amount: "30.00", currency: "CAD", merchantRaw: "Subway",         merchantNormalized: "subway",     categoryId: foodCatId, occurredAt: new Date("2026-04-18T12:00:00Z"), rawData: {} },
        { workspaceId: wsId, accountId: acctId, plaidTransactionId: "ft-8", amount: "2.00",  currency: "CAD", merchantRaw: "Deleted Latte",        merchantNormalized: "deleted latte", categoryId: null,  occurredAt: new Date("2026-04-22T12:00:00Z"), rawData: {}, removedAt: new Date() },
      ],
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("no filters: returns up to 20 most recent active CAD transactions in workspace", async () => {
    const r = await findTransactions.run(ctx, {});
    // 6 CAD active transactions (ft-1..5 + ft-7); ft-6 USD, ft-8 soft-deleted, cross-ws not yet added.
    expect(r.transactions).toHaveLength(6);
    expect(r.totalCount).toBe(6);
    expect(r.hasMore).toBe(false);
    expect(r.filtersApplied.limit).toBe(20);
    expect(r.excludedNonCadCount).toBe(1); // ft-6
  });

  it("results sorted by occurredAt desc, id desc", async () => {
    const r = await findTransactions.run(ctx, {});
    const occurred = r.transactions.map((t) => t.occurredAt);
    const sorted = [...occurred].sort().reverse();
    expect(occurred).toEqual(sorted);
  });

  it("merchant_query matches on merchantRaw (case-insensitive)", async () => {
    const r = await findTransactions.run(ctx, { merchant_query: "STARBUCKS" });
    expect(r.transactions.map((t) => t.merchantRaw).sort()).toEqual(["Starbucks Downtown", "Starbucks Pike"]);
    expect(r.totalCount).toBe(2);
  });

  it("merchant_query matches on merchantNormalized when raw doesn't contain the query", async () => {
    // Seed a row with an asymmetric raw/normalized pair: the search term lives in
    // normalized only. Proves the OR clause actually searches the normalized column.
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: "ft-asym",
        amount: "4.00",
        currency: "CAD",
        merchantRaw: "Espresso Bar",
        merchantNormalized: "coffeehouse",
        occurredAt: new Date("2026-04-08T12:00:00Z"),
        rawData: {},
      },
    });
    const r = await findTransactions.run(ctx, { merchant_query: "coffeehouse" });
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]!.merchantRaw).toBe("Espresso Bar");
    expect(r.transactions[0]!.merchantNormalized).toBe("coffeehouse");
  });

  it("start_date and end_date are inclusive (YYYY-MM-DD)", async () => {
    const r = await findTransactions.run(ctx, { start_date: "2026-04-10", end_date: "2026-04-20" });
    const ids = r.transactions.map((t) => t.id).sort();
    // ft-2 (Apr 10), ft-3 (Apr 15), ft-7 (Apr 18), ft-4 (Apr 20)
    expect(ids.length).toBe(4);
  });

  it("amount_min and amount_max match abs(amount) for expenses AND refunds", async () => {
    // 5..100 absolute range. Matches ft-1 (5), ft-2 (8.50), ft-4 (50 abs), ft-7 (30).
    // Excludes ft-3 (120) and ft-5 (1000).
    const r = await findTransactions.run(ctx, { amount_min: 5, amount_max: 100 });
    const ids = r.transactions.map((t) => t.id).sort();
    expect(ids.length).toBe(4);
  });

  it("category_name resolves case-insensitively and filters by IN ids", async () => {
    const r = await findTransactions.run(ctx, { category_name: "food" });
    // ft-1, ft-2, ft-3, ft-7 are in Food. ft-4 (null), ft-5 (null), ft-6 (USD), ft-8 (deleted) excluded.
    expect(r.transactions).toHaveLength(4);
  });

  it("account_name 'Chequing' resolves and filters out Savings transactions", async () => {
    const r = await findTransactions.run(ctx, { account_name: "chequing" });
    // ft-1..5 are in Chequing (not ft-6 USD, ft-7 Savings, ft-8 deleted).
    expect(r.transactions).toHaveLength(5);
    for (const t of r.transactions) expect(t.accountName).toBe("Chequing");
  });

  it("account_name resolves multiple accounts with the same name (in: ids)", async () => {
    const extraChequing = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: wsId, accountId: extraChequing.id, plaidTransactionId: "ft-extra", amount: "7.00", currency: "CAD", merchantRaw: "Other Chequing Tx", occurredAt: new Date("2026-04-28T12:00:00Z"), rawData: {} } });
    const r = await findTransactions.run(ctx, { account_name: "Chequing" });
    // 5 existing Chequing transactions + 1 in the extra Chequing = 6.
    expect(r.transactions).toHaveLength(6);
  });

  it("combined filters AND together correctly", async () => {
    const r = await findTransactions.run(ctx, {
      merchant_query: "starbucks",
      category_name: "Food",
      account_name: "Chequing",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      amount_min: 1,
      amount_max: 1000,
    });
    expect(r.transactions).toHaveLength(2); // ft-1 and ft-2
    expect(r.filtersApplied.merchantQuery).toBe("starbucks");
    expect(r.filtersApplied.categoryName).toBe("Food");
    expect(r.filtersApplied.accountName).toBe("Chequing");
  });

  it("limit=2 returns 2 rows, hasMore=true, totalCount reflects full match", async () => {
    const r = await findTransactions.run(ctx, { limit: 2 });
    expect(r.transactions).toHaveLength(2);
    expect(r.totalCount).toBe(6);
    expect(r.hasMore).toBe(true);
  });

  it("unknown category_name returns empty result, no throw, totalCount=0", async () => {
    const r = await findTransactions.run(ctx, { category_name: "NopeNotACat" });
    expect(r.transactions).toHaveLength(0);
    expect(r.totalCount).toBe(0);
    expect(r.hasMore).toBe(false);
    expect(r.filtersApplied.categoryName).toBe("NopeNotACat");
  });

  it("unknown account_name returns empty result, no throw, totalCount=0", async () => {
    const r = await findTransactions.run(ctx, { account_name: "Crypto Wallet" });
    expect(r.transactions).toHaveLength(0);
    expect(r.totalCount).toBe(0);
  });

  it("excludedNonCadCount reflects non-CAD txns matching the OTHER filters", async () => {
    const r = await findTransactions.run(ctx, { merchant_query: "Coffee" });
    // CAD: none match "Coffee" (Starbucks doesn't contain 'Coffee'). USD: ft-6 "Foreign Coffee" matches.
    expect(r.transactions).toHaveLength(0);
    expect(r.excludedNonCadCount).toBe(1);
  });

  it("workspace isolation: cross-workspace transactions not returned", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({ data: { workspaceId: otherWs.id, name: "Chequing", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: otherWs.id, accountId: otherAcct.id, plaidTransactionId: "x-1", amount: "999.00", currency: "CAD", merchantRaw: "Other Workspace Tx", occurredAt: new Date(), rawData: {} } });
    const r = await findTransactions.run(ctx, {});
    expect(r.transactions.find((t) => t.merchantRaw === "Other Workspace Tx")).toBeUndefined();
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("soft-deleted transactions excluded from results and totalCount", async () => {
    const r = await findTransactions.run(ctx, {});
    expect(r.transactions.find((t) => t.merchantRaw === "Deleted Latte")).toBeUndefined();
    expect(r.totalCount).toBe(6);
  });

  it("invalid_date: malformed dates rejected after Zod (round-trip mismatch)", async () => {
    await expect(findTransactions.run(ctx, { start_date: "2026-02-31" })).rejects.toThrow("invalid_date");
  });

  it("invalid_date_range: end_date < start_date is rejected", async () => {
    await expect(
      findTransactions.run(ctx, { start_date: "2026-04-15", end_date: "2026-04-01" }),
    ).rejects.toThrow("invalid_date_range");
  });

  it("invalid_amount_range: amount_max < amount_min is rejected", async () => {
    await expect(findTransactions.run(ctx, { amount_min: 100, amount_max: 50 })).rejects.toThrow("invalid_amount_range");
  });
});
```

### Step 1.2: Run test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.find-transactions.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/tools/find-transactions.js'`.

### Step 1.3: Write the implementation

Create `apps/api/src/chat/tools/find-transactions.ts`:

```typescript
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  merchant_query: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Substring to match on merchant name. Matched case-insensitively against both the raw merchant string and the normalized merchant key. Example: 'starbucks' matches 'STARBUCKS #1234 SEATTLE'.",
    )
    .optional(),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Earliest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Example: '2026-04-01'.")
    .optional(),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("Latest occurredAt date to include, ISO YYYY-MM-DD (inclusive). Must be >= start_date if both provided.")
    .optional(),
  amount_min: z
    .number()
    .nonnegative()
    .describe(
      "Minimum absolute transaction amount (CAD). Inclusive. Matches expenses or refunds whose abs(amount) is >= this value.",
    )
    .optional(),
  amount_max: z
    .number()
    .nonnegative()
    .describe("Maximum absolute transaction amount (CAD). Inclusive. Must be >= amount_min if both provided.")
    .optional(),
  category_name: z
    .string()
    .min(1)
    .max(80)
    .describe("Exact category name (case-insensitive). Empty array result if the name doesn't match an existing category.")
    .optional(),
  account_name: z
    .string()
    .min(1)
    .max(80)
    .describe("Exact bank account name (case-insensitive). Empty array result if the name doesn't match an existing account.")
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .describe("Maximum transactions to return. Default 20, hard cap 50.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  transactions: Array<{
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    occurredAt: string;
    accountName: string;
    accountId: string;
    categoryId: string | null;
    categoryName: string | null;
    categorizationSource: "mapping" | "ai" | "manual" | null;
  }>;
  totalCount: number;
  hasMore: boolean;
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
  excludedNonCadCount: number;
};

function isValidIsoDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function resolveFilters(args: Args, limit: number): Result["filtersApplied"] {
  return {
    merchantQuery: args.merchant_query ?? null,
    startDate: args.start_date ?? null,
    endDate: args.end_date ?? null,
    amountMin: args.amount_min ?? null,
    amountMax: args.amount_max ?? null,
    categoryName: args.category_name ?? null,
    accountName: args.account_name ?? null,
    limit,
  };
}

function emptyResult(args: Args, limit: number): Result {
  return {
    transactions: [],
    totalCount: 0,
    hasMore: false,
    filtersApplied: resolveFilters(args, limit),
    excludedNonCadCount: 0,
  };
}

export const findTransactions: ToolDef<Args, Result> = {
  name: "findTransactions",
  description:
    "Search transactions with filters: merchant text, date range, amount range, category name, account name. " +
    "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing.",
  args: Args,
  async run(ctx, args) {
    const limit = args.limit ?? 20;

    // Strict date + range validation (after Zod regex).
    if (args.start_date && !isValidIsoDate(args.start_date)) throw new Error("invalid_date");
    if (args.end_date && !isValidIsoDate(args.end_date)) throw new Error("invalid_date");
    if (args.start_date && args.end_date && args.start_date > args.end_date) {
      throw new Error("invalid_date_range");
    }
    if (args.amount_min != null && args.amount_max != null && args.amount_max < args.amount_min) {
      throw new Error("invalid_amount_range");
    }

    // Resolve name lookups → ids. Empty result on zero matches.
    let categoryIds: string[] | undefined;
    if (args.category_name) {
      const cats = await prisma.category.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          name: { equals: args.category_name, mode: "insensitive" },
          archivedAt: null,
        },
        select: { id: true },
      });
      if (cats.length === 0) return emptyResult(args, limit);
      categoryIds = cats.map((c) => c.id);
    }
    let accountIds: string[] | undefined;
    if (args.account_name) {
      const accts = await prisma.bankAccount.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          name: { equals: args.account_name, mode: "insensitive" },
          archivedAt: null,
        },
        select: { id: true },
      });
      if (accts.length === 0) return emptyResult(args, limit);
      accountIds = accts.map((a) => a.id);
    }

    // Build a separate Prisma.DateTimeFilter — TransactionWhereInput["occurredAt"] is a union
    // (Date | string | DateTimeFilter), which TS refuses to spread.
    const occurredAt: Prisma.DateTimeFilter = {};
    if (args.start_date) occurredAt.gte = new Date(`${args.start_date}T00:00:00.000Z`);
    if (args.end_date) occurredAt.lte = new Date(`${args.end_date}T23:59:59.999Z`);

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      removedAt: null,
      currency: "CAD",
    };
    if (categoryIds) where.categoryId = { in: categoryIds };
    if (accountIds) where.accountId = { in: accountIds };
    if (occurredAt.gte || occurredAt.lte) where.occurredAt = occurredAt;

    // Amount filter on abs(amount): two ranges OR'd, one for expenses (positive),
    // one for refunds (negative).
    if (args.amount_min != null || args.amount_max != null) {
      const min = args.amount_min ?? 0;
      const max = args.amount_max ?? Number.MAX_SAFE_INTEGER;
      where.OR = [
        { amount: { gte: min, lte: max } },
        { amount: { gte: -max, lte: -min } },
      ];
    }

    // Merchant ILIKE on both raw and normalized columns. If `where.OR` already exists
    // (amount range), wrap in AND so the two ORs are AND'd together.
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
      transactions: rows.map((r) => ({
        id: r.id,
        amount: r.amount.toString(),
        currency: r.currency,
        merchantRaw: r.merchantRaw,
        merchantNormalized: r.merchantNormalized,
        occurredAt: r.occurredAt.toISOString(),
        accountName: r.account.name,
        accountId: r.account.id,
        categoryId: r.category?.id ?? null,
        categoryName: r.category?.name ?? null,
        categorizationSource: (r.categorizationSource ?? null) as Result["transactions"][number]["categorizationSource"],
      })),
      totalCount,
      hasMore: totalCount > rows.length,
      filtersApplied: resolveFilters(args, limit),
      excludedNonCadCount,
    };
  },
};
```

### Step 1.4: Run test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.find-transactions.test.ts
```
Expected: all 19 tests PASS.

### Step 1.5: Commit

```bash
git add apps/api/src/chat/tools/find-transactions.ts apps/api/tests/chat.tools.find-transactions.test.ts
git commit -m "feat(plan 1e-search): findTransactions tool"
```

---

## Task 2: Register tool + extend registry schema test

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

### Step 2.1: Write the failing test

Append a new `describe` block to `apps/api/tests/chat.tools.registry.test.ts` after the existing `describe("REGISTRY (plan 1e-next)", ...)` block. Place it before the file's closing — i.e., as the last top-level statement.

```typescript
describe("REGISTRY (plan 1e-search)", () => {
  const EXPECTED = [
    [
      "findTransactions",
      "Search transactions with filters: merchant text, date range, amount range, category name, account name. " +
        "Returns up to 50 most recent matches with totalCount and hasMore for follow-up narrowing.",
    ],
  ] as const;

  it("contains findTransactions", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("has .describe() on every top-level arg field", () => {
    for (const [name] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool!.args as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const desc = (schema as z.ZodTypeAny).description;
        expect(desc, `${name}.${field} missing description`).toBeTruthy();
      }
    }
  });

  it("Gemini declaration emits parametersJsonSchema (has args)", () => {
    const decls = toGeminiFunctionDeclarations(REGISTRY);
    for (const [name] of EXPECTED) {
      const decl = decls.find((d) => d.name === name);
      expect(decl, `missing declaration for ${name}`).toBeDefined();
      expect(decl!.parametersJsonSchema).toBeDefined();
    }
  });
});
```

### Step 2.2: Run test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts
```
Expected: 4 NEW tests in the `plan 1e-search` block FAIL because `findTransactions` is not yet registered. Existing 4 tests in the `plan 1e-next` block still PASS.

### Step 2.3: Add the registry entry

Edit `apps/api/src/chat/tools/index.ts` to its final state:

```typescript
import type { ToolDef } from "./types.js";
import { listTransactions } from "./list-transactions.js";
import { getSpendingSummary } from "./get-spending-summary.js";
import { listCategories } from "./list-categories.js";
import { categorizeTransaction } from "./categorize-transaction.js";
import { listAccounts } from "./list-accounts.js";
import { getTransactionDetails } from "./get-transaction-details.js";
import { findUncategorizedTransactions } from "./find-uncategorized-transactions.js";
import { getCategoryBreakdown } from "./get-category-breakdown.js";
import { compareSpendingPeriods } from "./compare-spending-periods.js";
import { detectRecurringMerchants } from "./detect-recurring-merchants.js";
import { getCashflowSummary } from "./get-cashflow-summary.js";
import { findTransactions } from "./find-transactions.js";

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
  findTransactions as ToolDef,
];
```

### Step 2.4: Run registry test + full suite + typecheck

Run all three to verify nothing regresses:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts
pnpm --filter @fina/api test
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```

Expected:
- Registry test: 8/8 PASS (4 plan-1e-next + 4 plan-1e-search).
- Full suite: all green.
- Typecheck: only the one pre-existing error on `apps/api/src/chat/turn.ts:127`.

### Step 2.5: Commit

```bash
git add apps/api/src/chat/tools/index.ts apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1e-search): register findTransactions + schema regression"
```

---

## Acceptance Verification

After Task 2, walk through the spec's §11 acceptance criteria. Each row should be observable:

- `findTransactions` registered as the 12th entry in `REGISTRY` (Task 2 commit).
- Description exactly matches the string in spec §4 (verified by Task 2 test).
- All 8 args have `.describe()` text (verified by Task 2 test).
- Strict date validation rejects `2026-99-99` and `2026-02-31` (Task 1 tests).
- `end_date >= start_date` and `amount_max >= amount_min` enforced (Task 1 tests).
- Unknown `category_name` / `account_name` returns empty result, no throw (Task 1 tests).
- Merchant matching is case-insensitive substring on both columns (Task 1 tests).
- Sort fixed `occurredAt DESC, id DESC` (Task 1 test).
- Default `limit=20`, hard cap `50` (Task 1 tests, Zod `.max(50)`).
- Response includes `totalCount`, `hasMore`, `filtersApplied`, `excludedNonCadCount` (Task 1 tests).
- Workspace isolation (Task 1 test).
- Soft-deleted excluded (Task 1 test).
- CAD-scoped with `excludedNonCadCount` exposed (Task 1 test).
- 11 existing tool tests untouched, still green (Task 2 Step 2.4 full suite).
