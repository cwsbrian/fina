# Expense-Only Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fina show and calculate only budget-impacting expenses by default, while keeping excluded bank movements auditable and restorable.

**Architecture:** Add transaction-level `budgetImpact` fields, then route all spending queries through one small helper so excluded rows cannot leak into budget totals. Plaid sync assigns automatic impact only while the user has not overridden it; mobile adds one excluded list and one detail toggle.

**Tech Stack:** Prisma, Fastify, Vitest, Expo Router, React Native, TypeScript.

---

## File Map

- Modify `apps/api/prisma/schema.prisma`: add `BudgetImpact`, `BudgetImpactSource`, transaction fields, and index.
- Create `apps/api/prisma/migrations/20260624190000_budget_impact/migration.sql`: DB migration.
- Modify `libs/shared/src/dto/transactions.ts`: expose `budgetImpact` and `budgetImpactSource`.
- Create `apps/api/src/transactions/budget-impact.ts`: classifier and shared budget-visible Prisma predicates.
- Create `apps/api/tests/transactions.budget-impact.test.ts`: unit coverage for classifier and predicate.
- Modify `apps/api/src/transactions/create-manual.ts`: mark manual negative rows excluded.
- Modify `apps/api/src/plaid/sync.ts`: assign impact on insert/update only when source is `auto`.
- Create `apps/api/src/scripts/backfill-budget-impact.ts`: one-off admin backfill for existing Plaid rows.
- Modify `apps/api/package.json`: add admin scripts for budget-impact reconciliation and categorization backfill.
- Modify `apps/api/src/categorize/llm.ts`: fix DeepSeek JSON-mode prompt.
- Modify `apps/api/src/routes/transactions.ts`: default list filter, excluded filter, DTO fields, PATCH support.
- Modify aggregate call sites to use the shared predicate:
  - `apps/api/src/analysis/service.ts`
  - `apps/api/src/budget-plans/service.ts`
  - `apps/api/src/goals/savings.ts`
  - `apps/api/src/analysis/forecast.ts`
  - `apps/api/src/chat/tools/get-spending-summary.ts`
  - `apps/api/src/chat/tools/list-transactions.ts`
  - `apps/api/src/chat/tools/get-category-breakdown.ts`
  - `apps/api/src/chat/tools/compare-spending-periods.ts`
  - `apps/api/src/chat/tools/compare-spending-vs-budget.ts`
- Modify mobile UI:
  - `apps/mobile/app/(tabs)/activity.tsx`
  - `apps/mobile/app/(tabs)/more.tsx`
  - `apps/mobile/app/transactions/[id]/index.tsx`
  - Create `apps/mobile/app/transactions/excluded.tsx`
  - `apps/mobile/app/(tabs)/index.tsx`
  - `apps/mobile/app/analysis/index.tsx`
  - `apps/mobile/src/home/analysis-glance.ts`
  - `apps/mobile/src/home/analysis-glance.test.ts`

---

### Task 1: Add Transaction Budget Impact Fields

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260624190000_budget_impact/migration.sql`
- Modify: `libs/shared/src/dto/transactions.ts`

- [ ] **Step 1: Update Prisma schema**

Add these enums near the other transaction enums:

```prisma
enum BudgetImpact {
  expense
  excluded
}

enum BudgetImpactSource {
  auto
  user
}
```

Add these fields to `model Transaction` after `needsReclassification`:

```prisma
  budgetImpact             BudgetImpact       @default(expense)
  budgetImpactSource       BudgetImpactSource @default(auto)
```

Add this index to `model Transaction`:

```prisma
  @@index([workspaceId, budgetImpact, occurredAt(sort: Desc)])
```

- [ ] **Step 2: Add migration SQL**

Create `apps/api/prisma/migrations/20260624190000_budget_impact/migration.sql`:

```sql
CREATE TYPE "BudgetImpact" AS ENUM ('expense', 'excluded');
CREATE TYPE "BudgetImpactSource" AS ENUM ('auto', 'user');

ALTER TABLE "transactions"
  ADD COLUMN "budgetImpact" "BudgetImpact" NOT NULL DEFAULT 'expense',
  ADD COLUMN "budgetImpactSource" "BudgetImpactSource" NOT NULL DEFAULT 'auto';

CREATE INDEX "transactions_workspaceId_budgetImpact_occurredAt_idx"
  ON "transactions"("workspaceId", "budgetImpact", "occurredAt" DESC);
```

- [ ] **Step 3: Expose fields in shared DTO**

In `TransactionDTO`, add:

```ts
  budgetImpact: "expense" | "excluded";
  budgetImpactSource: "auto" | "user";
```

- [ ] **Step 4: Generate Prisma client and typecheck**

Run:

```bash
pnpm --filter @fina/api db:generate
pnpm nx typecheck shared
pnpm nx typecheck api
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260624190000_budget_impact/migration.sql libs/shared/src/dto/transactions.ts
git commit -m "feat: add transaction budget impact fields"
```

---

### Task 2: Add Budget Impact Helper

**Files:**
- Create: `apps/api/src/transactions/budget-impact.ts`
- Create: `apps/api/tests/transactions.budget-impact.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `apps/api/tests/transactions.budget-impact.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  budgetExpenseTransactionWhere,
  budgetExpenseAllocationWhere,
  classifyPlaidBudgetImpact,
  budgetImpactForAmount,
} from "../src/transactions/budget-impact.js";

describe("budget impact", () => {
  it("excludes non-outgoing amounts", () => {
    expect(budgetImpactForAmount(-100)).toBe("excluded");
    expect(budgetImpactForAmount(0)).toBe("excluded");
    expect(budgetImpactForAmount(100)).toBe("expense");
  });

  it("keeps unknown outgoing rows in the budget", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 12.34,
      name: "COFFEE SHOP",
      merchant_name: "Coffee Shop",
      personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE" },
    })).toBe("expense");
  });

  it("excludes clear credit card payments", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 3000,
      name: "PAYMENT TO CREDIT CARD",
      merchant_name: null,
      personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
    })).toBe("excluded");
  });

  it("keeps outgoing e-transfer as an expense", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 270,
      name: "SEND E-TFR ***K5P",
      merchant_name: null,
      personal_finance_category: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
    })).toBe("expense");
  });

  it("keeps same-bank transfer names in budget until matched to another connected account", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 500,
      name: "WQ062 TFR-TO 6911127",
      merchant_name: null,
      personal_finance_category: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_ACCOUNT_TRANSFER" },
    })).toBe("expense");
  });

  it("excludes investment movement", () => {
    expect(classifyPlaidBudgetImpact({
      amount: 250,
      name: "INVESTMENT TRANSFER",
      merchant_name: null,
      personal_finance_category: { primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS" },
    })).toBe("excluded");
  });

  it("keeps ATM, mortgage, BNPL, and bank fees as expenses", () => {
    for (const tx of [
      { name: "TD ATM W/D 008047", primary: "TRANSFER_OUT", detailed: "TRANSFER_OUT_WITHDRAWAL" },
      { name: "TD MORTGAGE", primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_MORTGAGE_PAYMENT" },
      { name: "FLEXITI Y4J4A8", primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_BNPL" },
      { name: "MONTHLY ACCOUNT FEE", primary: "BANK_FEES", detailed: "BANK_FEES_OTHER_BANK_FEES" },
    ]) {
      expect(classifyPlaidBudgetImpact({
        amount: 50,
        name: tx.name,
        merchant_name: null,
        personal_finance_category: { primary: tx.primary, detailed: tx.detailed },
      })).toBe("expense");
    }
  });

  it("builds budget-visible Prisma predicates", () => {
    expect(budgetExpenseTransactionWhere({ workspaceId: "ws_1" })).toEqual({
      workspaceId: "ws_1",
      removedAt: null,
      budgetImpact: "expense",
      amount: { gt: 0 },
    });
    expect(budgetExpenseAllocationWhere({ workspaceId: "ws_1" })).toEqual({
      amount: { gt: 0 },
      transaction: {
        workspaceId: "ws_1",
        removedAt: null,
        budgetImpact: "expense",
        amount: { gt: 0 },
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.budget-impact.test.ts
```

Expected: FAIL because `../src/transactions/budget-impact.js` does not exist.

- [ ] **Step 3: Add the helper**

Create `apps/api/src/transactions/budget-impact.ts`:

```ts
import type { Prisma } from "@prisma/client";

type PlaidBudgetTx = {
  amount: number;
  name?: string | null;
  merchant_name?: string | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
  } | null;
};

export type BudgetImpactValue = "expense" | "excluded";

export function budgetImpactForAmount(amount: number): BudgetImpactValue {
  return amount > 0 ? "expense" : "excluded";
}

export function budgetExpenseTransactionWhere(
  extra: Prisma.TransactionWhereInput = {},
): Prisma.TransactionWhereInput {
  return {
    ...extra,
    removedAt: null,
    budgetImpact: "expense",
    amount: { gt: 0 },
  };
}

export function budgetExpenseAllocationWhere(
  transaction: Prisma.TransactionWhereInput = {},
): Prisma.TransactionAllocationWhereInput {
  return {
    amount: { gt: 0 },
    transaction: budgetExpenseTransactionWhere(transaction),
  };
}

export function classifyPlaidBudgetImpact(t: PlaidBudgetTx): BudgetImpactValue {
  if (budgetImpactForAmount(t.amount) === "excluded") return "excluded";

  const primary = t.personal_finance_category?.primary?.toUpperCase() ?? "";
  const detailed = t.personal_finance_category?.detailed?.toUpperCase() ?? "";
  const text = `${t.name ?? ""} ${t.merchant_name ?? ""}`.toUpperCase();

  if (detailed.includes("INVESTMENT") || detailed.includes("RETIREMENT")) return "excluded";
  if (detailed.includes("CREDIT_CARD_PAYMENT")) return "excluded";
  if (/\b(PAYMENT|PYMT|PMT)\b/.test(text) && /\b(CREDIT|CARD|VISA|MASTERCARD|AMEX)\b/.test(text)) {
    return "excluded";
  }

  return "expense";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.budget-impact.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/transactions/budget-impact.ts apps/api/tests/transactions.budget-impact.test.ts
git commit -m "feat: add budget impact classifier"
```

---

### Task 3: Wire Transaction Creation, Plaid Sync, Backfill, and Categorization Fix

**Files:**
- Modify: `apps/api/src/transactions/create-manual.ts`
- Modify: `apps/api/src/plaid/sync.ts`
- Create: `apps/api/src/scripts/backfill-budget-impact.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/categorize/llm.ts`

- [ ] **Step 1: Mark manual negative rows excluded**

In `apps/api/src/transactions/create-manual.ts`, import:

```ts
import { budgetImpactForAmount } from "./budget-impact.js";
```

In the `tx.transaction.create` data block, add:

```ts
        budgetImpact: budgetImpactForAmount(input.amount),
        budgetImpactSource: "auto",
```

Add to `CreateManualTxResult["transaction"]`:

```ts
    budgetImpact: "expense" | "excluded";
    budgetImpactSource: "auto" | "user";
```

Add to the returned transaction:

```ts
        budgetImpact: row.budgetImpact,
        budgetImpactSource: row.budgetImpactSource,
```

- [ ] **Step 2: Extend Plaid sync type**

In `PlaidTxLike`, add:

```ts
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
    confidence_level?: string | null;
  } | null;
```

- [ ] **Step 3: Import classifier**

Add:

```ts
import { classifyPlaidBudgetImpact } from "../transactions/budget-impact.js";
```

- [ ] **Step 4: Set impact on fresh inserts**

In the `tx.transaction.create` data block in `upsertAdded`, add:

```ts
      budgetImpact: classifyPlaidBudgetImpact(t),
      budgetImpactSource: "auto",
```

- [ ] **Step 5: Preserve user overrides on update paths**

In each `tx.transaction.update` data block for promotion, existing replay, reconnect match, and `upsertModified`, add this spread:

```ts
          ...(existing.budgetImpactSource === "auto"
            ? { budgetImpact: classifyPlaidBudgetImpact(t), budgetImpactSource: "auto" as const }
            : {}),
```

Where the local variable is named `promotion`, use:

```ts
          ...(promotion.budgetImpactSource === "auto"
            ? { budgetImpact: classifyPlaidBudgetImpact(t), budgetImpactSource: "auto" as const }
            : {}),
```

Also add `budgetImpactSource: true` to the corresponding `findFirst` / `findMany` selects or includes. In the reconnect path, select it on `candidates` and use `strongMatches[0]!.budgetImpactSource` in the spread.

- [ ] **Step 6: Add admin backfill script**

Create `apps/api/src/scripts/backfill-budget-impact.ts`:

```ts
import { prisma } from "../db.js";
import {
  budgetImpactForAmount,
  classifyPlaidBudgetImpact,
} from "../transactions/budget-impact.js";

const rows = await prisma.transaction.findMany({
  where: {
    budgetImpactSource: "auto",
    removedAt: null,
  },
  select: {
    id: true,
    source: true,
    amount: true,
    merchantRaw: true,
    rawData: true,
  },
});

let changed = 0;
for (const row of rows) {
  const raw = row.rawData as {
    name?: string | null;
    merchant_name?: string | null;
    personal_finance_category?: {
      primary?: string | null;
      detailed?: string | null;
    } | null;
  } | null;
  const amount = Number(row.amount);
  const budgetImpact = row.source === "plaid"
    ? classifyPlaidBudgetImpact({
        amount,
        name: raw?.name ?? row.merchantRaw,
        merchant_name: raw?.merchant_name ?? null,
        personal_finance_category: raw?.personal_finance_category ?? null,
      })
    : budgetImpactForAmount(amount);
  const result = await prisma.transaction.updateMany({
    where: { id: row.id, budgetImpactSource: "auto" },
    data: { budgetImpact },
  });
  changed += result.count;
}

console.log(`backfill-budget-impact changed=${changed} scanned=${rows.length}`);
await prisma.$disconnect();
```

- [ ] **Step 7: Add internal transfer reconciliation script**

Create `apps/api/src/scripts/reconcile-budget-impact.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

function looksLikeOwnAccountTransfer(name: string): boolean {
  return /\bTFR-(TO|FR)\b/i.test(name);
}

const rows = await prisma.transaction.findMany({
  where: {
    source: "plaid",
    budgetImpactSource: "auto",
    removedAt: null,
    amount: { gt: 0 },
  },
  select: {
    id: true,
    workspaceId: true,
    accountId: true,
    amount: true,
    occurredAt: true,
    merchantRaw: true,
    rawData: true,
  },
});

let changed = 0;
for (const row of rows) {
  const raw = row.rawData as { name?: string | null } | null;
  const name = raw?.name ?? row.merchantRaw;

  const dayStart = new Date(row.occurredAt);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const match = looksLikeOwnAccountTransfer(name)
    ? await prisma.transaction.findFirst({
        where: {
          workspaceId: row.workspaceId,
          accountId: { not: row.accountId },
          removedAt: null,
          amount: new Prisma.Decimal(row.amount).negated(),
          occurredAt: { gte: dayStart, lt: dayEnd },
          rawData: {
            path: ["personal_finance_category", "detailed"],
            equals: "TRANSFER_IN_ACCOUNT_TRANSFER",
          },
        },
        select: { id: true },
      })
    : null;
  if (!match) continue;

  const result = await prisma.transaction.updateMany({
    where: { id: row.id, budgetImpactSource: "auto" },
    data: { budgetImpact: "excluded" },
  });
  changed += result.count;
}

console.log(`reconcile-budget-impact changed=${changed} scanned=${rows.length}`);
await prisma.$disconnect();
```

- [ ] **Step 8: Fix DeepSeek JSON-mode categorization prompt**

In `apps/api/src/categorize/llm.ts`, append this sentence to `systemInstruction`:

```ts
      "Return only valid JSON matching the requested schema.",
```

The literal word `JSON` is required because DeepSeek rejects `response_format: json_object` when no message contains `json`.

- [ ] **Step 9: Add package scripts**

In `apps/api/package.json` scripts, add:

```json
"admin:backfill-budget-impact": "tsx src/scripts/backfill-budget-impact.ts",
"admin:reconcile-budget-impact": "tsx src/scripts/reconcile-budget-impact.ts",
"admin:backfill-categorize": "tsx src/scripts/backfill-categorize-uncategorized.ts"
```

- [ ] **Step 10: Typecheck**

Run:

```bash
pnpm nx typecheck api
```

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/transactions/create-manual.ts apps/api/src/plaid/sync.ts apps/api/src/scripts/backfill-budget-impact.ts apps/api/src/scripts/reconcile-budget-impact.ts apps/api/src/categorize/llm.ts apps/api/package.json
git commit -m "feat: assign budget impact during plaid sync"
```

---

### Task 4: Apply Budget Impact in Transaction APIs

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/src/transactions/edit.ts`

- [ ] **Step 1: Add query and patch schemas**

In `routes/transactions.ts`, add:

```ts
const BudgetImpactQuery = z.enum(["expense", "excluded", "all"]).optional().default("expense");
const BudgetImpactPatch = z.enum(["expense", "excluded"]);
```

Add to `PatchTxBody`:

```ts
    budgetImpact: BudgetImpactPatch.optional(),
```

Add to `QuerySchema`:

```ts
  budgetImpact: BudgetImpactQuery,
```

- [ ] **Step 2: Filter transaction list by default**

Add to the list `where` object:

```ts
        ...(q.budgetImpact === "all" ? {} : { budgetImpact: q.budgetImpact }),
```

- [ ] **Step 3: Return fields in list and detail responses**

Add to both response maps:

```ts
          budgetImpact: t.budgetImpact,
          budgetImpactSource: t.budgetImpactSource,
```

- [ ] **Step 4: Extend edit service input**

In `apps/api/src/transactions/edit.ts`, add to `EditTxInput`:

```ts
  budgetImpact?: "expense" | "excluded";
```

Add to `EditTxResult["transaction"]`:

```ts
    budgetImpact: "expense" | "excluded";
    budgetImpactSource: "auto" | "user";
```

Add to `TX_SELECT`:

```ts
  budgetImpact: true, budgetImpactSource: true,
```

Add to `shape()`:

```ts
    budgetImpact: row.budgetImpact,
    budgetImpactSource: row.budgetImpactSource,
```

Before the transaction update, add:

```ts
    if (input.budgetImpact !== undefined) {
      data.budgetImpact = input.budgetImpact;
      data.budgetImpactSource = "user";
    }
```

- [ ] **Step 5: Pass patch input from route**

In the PATCH route, add:

```ts
        if (d.budgetImpact !== undefined) input.budgetImpact = d.budgetImpact;
```

- [ ] **Step 6: Typecheck**

Run:

```bash
pnpm nx typecheck api
pnpm nx typecheck shared
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/transactions/edit.ts
git commit -m "feat: expose transaction budget impact api"
```

---

### Task 5: Use Budget Predicate in Spending Calculations

**Files:**
- Modify: `apps/api/src/analysis/service.ts`
- Modify: `apps/api/src/budget-plans/service.ts`
- Modify: `apps/api/src/goals/savings.ts`
- Modify: `apps/api/src/analysis/forecast.ts`
- Modify: `apps/api/src/chat/tools/get-spending-summary.ts`
- Modify: `apps/api/src/chat/tools/list-transactions.ts`
- Modify: `apps/api/src/chat/tools/get-category-breakdown.ts`
- Modify: `apps/api/src/chat/tools/compare-spending-periods.ts`
- Modify: `apps/api/src/chat/tools/compare-spending-vs-budget.ts`

- [ ] **Step 1: Replace direct positive-spend filters**

In each transaction aggregate/find query that currently means budget spending, import:

```ts
import { budgetExpenseTransactionWhere, budgetExpenseAllocationWhere } from "../transactions/budget-impact.js";
```

Use `../../transactions/budget-impact.js` from nested chat tool folders when needed.

Replace transaction `where` blocks like:

```ts
{
  workspaceId,
  removedAt: null,
  occurredAt: { gte: from, lt: to },
  amount: { gt: 0 },
}
```

with:

```ts
budgetExpenseTransactionWhere({
  workspaceId,
  occurredAt: { gte: from, lt: to },
})
```

Replace allocation `where` blocks like:

```ts
{
  amount: { gt: 0 },
  categoryId: { not: null },
  transaction: {
    workspaceId,
    removedAt: null,
    occurredAt: { gte: from, lt: to },
    amount: { gt: 0 },
  },
}
```

with:

```ts
{
  ...budgetExpenseAllocationWhere({
    workspaceId,
    occurredAt: { gte: from, lt: to },
  }),
  categoryId: { not: null },
}
```

- [ ] **Step 2: Remove user-facing non-expense totals from analysis service only if callers stop using them**

Keep `income` and `net` in API response for compatibility. Make budget visibility correct by ensuring `spend` and `spendByCategory` use `budgetImpact = "expense"`.

- [ ] **Step 3: Run targeted API tests**

Run:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/analysis.service.test.ts tests/budget-plans.snapshot.test.ts tests/chat.tools.get-spending-summary.test.ts tests/chat.tools.list-transactions.test.ts
```

Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm nx typecheck api
git add apps/api/src/analysis/service.ts apps/api/src/budget-plans/service.ts apps/api/src/goals/savings.ts apps/api/src/analysis/forecast.ts apps/api/src/chat/tools/get-spending-summary.ts apps/api/src/chat/tools/list-transactions.ts apps/api/src/chat/tools/get-category-breakdown.ts apps/api/src/chat/tools/compare-spending-periods.ts apps/api/src/chat/tools/compare-spending-vs-budget.ts
git commit -m "feat: exclude non-budget transactions from spend"
```

---

### Task 6: Add Excluded Transactions UI and Toggle

**Files:**
- Modify: `apps/mobile/app/(tabs)/activity.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx`
- Modify: `apps/mobile/app/transactions/[id]/index.tsx`
- Create: `apps/mobile/app/transactions/excluded.tsx`

- [ ] **Step 1: Add Activity utility row**

In `activity.tsx`, replace `ListHeaderComponent` with a fragment that keeps the existing upcoming row and adds the excluded row:

```tsx
        ListHeaderComponent={
          <>
            {upcoming.count > 0 && (
              <UpcomingBanner
                total={upcoming.total}
                count={upcoming.count}
                currency={currency}
              />
            )}
            <ExcludedBanner />
          </>
        }
```

Add:

```tsx
function ExcludedBanner() {
  return (
    <Pressable
      style={({ pressed }) => [styles.banner, pressed && { opacity: 0.7 }]}
      onPress={() => router.push("/transactions/excluded" as never)}
    >
      <View style={styles.bannerGlyph}>
        <Ionicons name="swap-horizontal" size={13} color={colors.primary} />
      </View>
      <Text style={styles.bannerLabel} numberOfLines={1}>
        Excluded transactions
      </Text>
      <Text style={styles.bannerCount}>Review</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.mutedSoft} />
    </Pressable>
  );
}
```

- [ ] **Step 2: Add More entry**

In the Planning group in `more.tsx`, change the Categories subtitle to:

```tsx
subtitle="Budget labels for transactions"
```

Add a SettingsRow before Budget:

```tsx
          <SettingsRow
            icon="swap-horizontal-outline"
            title="Excluded transactions"
            subtitle="Card payments, transfers, and other non-budget activity"
            onPress={() => router.push("/transactions/excluded" as never)}
          />
```

Move `last` so only the final Budget row has `last`.

- [ ] **Step 3: Create excluded screen**

Create `apps/mobile/app/transactions/excluded.tsx` by copying the simple fetch/list pattern from `activity.tsx`, but request:

```ts
apiFetch<TxListResp>(`/workspaces/${id}/transactions?budgetImpact=excluded&limit=100`)
```

Use these visible strings:

```tsx
<Text style={styles.title}>Excluded transactions</Text>
<Text style={styles.subtitle}>Card payments, transfers, and other non-budget activity</Text>
<Text style={styles.emptyTitle}>Nothing excluded</Text>
<Text style={styles.emptyBody}>Transactions that do not affect your budget will appear here.</Text>
```

For each row, navigate to the existing detail:

```tsx
onPress={() => router.push(`/transactions/${tx.id}` as never)}
```

- [ ] **Step 4: Add detail toggle**

In `transactions/[id]/index.tsx`, add:

```tsx
  async function setBudgetImpact(next: "expense" | "excluded") {
    if (!tx) return;
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}`, {
        method: "PATCH",
        body: JSON.stringify({ budgetImpact: next }),
      });
      setTx({ ...tx, budgetImpact: next, budgetImpactSource: "user" });
    } catch (e) {
      Alert.alert("Couldn't update", (e as { code?: string }).code ?? "Try again.");
    }
  }
```

Above the Delete button, add:

```tsx
        <View style={{ paddingHorizontal: space.base, paddingTop: space.lg }}>
          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && { opacity: 0.6 }]}
            onPress={() => setBudgetImpact(tx.budgetImpact === "expense" ? "excluded" : "expense")}
          >
            <Text style={styles.secondaryText}>
              {tx.budgetImpact === "expense" ? "Exclude from budget" : "Add to budget"}
            </Text>
          </Pressable>
        </View>
```

Add styles:

```tsx
  secondaryBtn: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  secondaryText: { ...type$.button, color: colors.body },
```

- [ ] **Step 5: Typecheck mobile**

Run:

```bash
pnpm nx typecheck mobile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/mobile/app/(tabs)/activity.tsx" "apps/mobile/app/(tabs)/more.tsx" "apps/mobile/app/transactions/[id]/index.tsx" apps/mobile/app/transactions/excluded.tsx
git commit -m "feat: add excluded transactions ui"
```

---

### Task 7: Remove Non-Expense UI Copy

**Files:**
- Modify: `apps/mobile/src/home/analysis-glance.ts`
- Modify: `apps/mobile/src/home/analysis-glance.test.ts`
- Modify: `apps/mobile/app/(tabs)/index.tsx`
- Modify: `apps/mobile/app/analysis/index.tsx`

- [ ] **Step 1: Update home analysis helper test**

Change the first test in `analysis-glance.test.ts` to:

```ts
  it("shows analysis when spending exists", () => {
    expect(
      shouldShowAnalysisGlance({
        label: "May 2026",
        income: 0,
        spend: 100,
        net: -100,
        prevNet: null,
      }),
    ).toBe(true);
  });
```

Change the empty-state test body to assert that non-expense-only data does not show:

```ts
    expect(
      shouldShowAnalysisGlance({
        label: "June 2026",
        income: 100,
        spend: 0,
        net: 100,
        prevNet: null,
      }),
    ).toBe(false);
```

- [ ] **Step 2: Update helper**

In `analysis-glance.ts`, change:

```ts
  return analysis.income !== 0 || analysis.spend !== 0 || analysis.net !== 0;
```

to:

```ts
  return analysis.spend > 0;
```

- [ ] **Step 3: Replace Home glance cards**

In `apps/mobile/app/(tabs)/index.tsx`, replace the current two-card glance block with one spend-focused card:

```tsx
                <View style={styles.glanceGrid}>
                  <View style={styles.glanceCard}>
                    <Text style={styles.glanceLabel}>Spent</Text>
                    <Text
                      style={styles.glanceValue}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.6}
                    >
                      {formatMoney(analysis.spend.toFixed(2), CURRENCY).display}
                    </Text>
                  </View>
                </View>
```

Update the comment above it to:

```tsx
            {/* 5. Glance - spending analysis. Hide on fresh accounts with no spending this month. */}
```

- [ ] **Step 4: Replace Analysis cashflow card**

In `apps/mobile/app/analysis/index.tsx`, replace the net/cashflow card title and metadata with expense-only text:

```tsx
      <Text style={styles.cardEyebrow}>Spending trend</Text>
      <Text style={styles.cardValue}>
        {formatMoney(analysis.spend.toFixed(2)).display}
      </Text>
```

Change `CashflowChart` to draw only `p.spend` bars and compute max from `points.map((p) => p.spend)`.

- [ ] **Step 5: Run mobile tests and typecheck**

Run:

```bash
(cd apps/mobile && pnpm exec vitest run --config vitest.config.ts src/home/analysis-glance.test.ts)
pnpm nx typecheck mobile
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/home/analysis-glance.ts apps/mobile/src/home/analysis-glance.test.ts "apps/mobile/app/(tabs)/index.tsx" apps/mobile/app/analysis/index.tsx
git commit -m "feat: keep mobile analysis expense focused"
```

---

## Final Verification

- [ ] Run API tests:

```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.budget-impact.test.ts tests/analysis.service.test.ts tests/budget-plans.snapshot.test.ts
```

- [ ] Run typechecks:

```bash
pnpm nx typecheck shared
pnpm nx typecheck api
pnpm nx typecheck mobile
```

- [ ] Run local DB migration:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api db:migrate
```

- [ ] Run local backfill:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api admin:backfill-budget-impact
```

- [ ] Manual Plaid validation with local app:

```bash
pnpm smoke:api
pnpm smoke:mobile:lan
```

Confirm:

- Matched own-account transfers appear in `Excluded transactions`.
- Depository-side credit card payments appear in `Excluded transactions`.
- Outgoing E-Transfers remain in Activity as expenses.
- Normal card purchases remain in Activity and budget totals.
- `Add to budget` and `Exclude from budget` survive refresh.
- Home and Analysis do not show non-expense copy.
