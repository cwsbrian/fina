# Chat read-tool presentation cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the seven chat read-tools that currently return only plain text a structured presentation card, by adding six new `PresentationBlock` types and rendering them on mobile.

**Architecture:** Each tool returns `{ ...data, block }`; `collectPresentationBlocks` in `turn.ts` already surfaces `result.output.block` into the assistant message's `presentationBlocks`. Mobile `PresentationBlock.tsx` renders each block exhaustively. Two interactive cards (`recurring_candidates`, `scheduled_list` unresolved rows) embed a server-pre-created `ActionIntent` id and the client consumes it via the existing `POST /workspaces/:wsId/intents/:id/consume`.

**Tech Stack:** TypeScript, Fastify + Prisma (api), React Native / Expo (mobile), Zod, Vitest (api tests), `@fina/shared` for all cross-app types.

**Spec:** `docs/superpowers/specs/2026-05-28-chat-read-tool-cards-design.md`

---

## File Structure

**Shared (contract — ships first):**
- Modify `libs/shared/src/dto/chat.ts` — add 6 members to the `PresentationBlock` union. `accounts_list.status` reuses `PlaidItemStatus` (already exported from `dto/plaid.ts`).

**API (one vertical slice per tool):**
- Modify `apps/api/src/budgets/service.ts` — extract `spentByCategoryForPeriod`; refactor `compareSpendingVsBudgetService` to use it.
- Modify `apps/api/src/chat/tools/get-budget.ts` — `budget_list`.
- Modify `apps/api/src/chat/tools/list-accounts.ts` — `accounts_list`.
- Modify `apps/api/src/chat/tools/list-scheduled-spends.ts` — `scheduled_list`.
- Modify `apps/api/src/chat/tools/list-unresolved-schedules.ts` — `scheduled_list` + dismiss intents.
- Modify `apps/api/src/chat/tools/detect-recurring-merchants.ts` — `recurring_candidates` + form intents.
- Modify `apps/api/src/chat/tools/get-transaction-details.ts` — `transaction_detail`.
- Modify `apps/api/src/chat/tools/list-categories.ts` — `category_list`.
- Create `apps/api/src/intents/sweep.ts` — expired-intent sweeper.
- Modify the cron scheduler to register the sweep.
- Modify `apps/api/src/chat/turn.ts` — reconcile getBudget vs compareSpendingVsBudget guidance.
- Tests: one `apps/api/tests/chat.tools.<tool>.*.test.ts` per slice + `intents.sweep.test.ts` + a `budgets.service.spent-helper.test.ts`.

**Mobile:**
- Create `apps/mobile/src/chat/blocks/BudgetListBlock.tsx`, `AccountsListBlock.tsx`, `ScheduledListBlock.tsx`, `RecurringCandidatesBlock.tsx`, `TransactionDetailBlock.tsx`, `CategoryListBlock.tsx`.
- Modify `apps/mobile/src/chat/PresentationBlock.tsx` — 6 new branches.
- Modify `apps/mobile/src/chat/ThreadView.tsx` — register new types in `isCardBlock`.

---

## Phase 0: Shared block types (contract first)

### Task 0: Add 6 block types to the PresentationBlock union

**Files:**
- Modify: `libs/shared/src/dto/chat.ts`

- [ ] **Step 1: Add the import + union members**

At the top of `libs/shared/src/dto/chat.ts`, add `PlaidItemStatus` to the existing import line from enums/plaid. The file currently imports `ChatMessageRole` from `../enums.js`; add a new import:

```ts
import type { PlaidItemStatus } from "./plaid.js";
```

Then, inside the `PresentationBlock` union (after the final `recurring_form_card` member, before the closing `;`), append:

```ts
  | {
      /** Read-only budgets card. Used by getBudget. Each row pairs a
       *  category's configured budget `amount` with the period `spent`
       *  and a `bar_pct` (spent/amount*100, may exceed 100). `over` is
       *  true when spent > amount. Amounts are decimal strings without a
       *  currency symbol; the renderer formats with `currency`. */
      type: "budget_list";
      title: string;
      period_label?: string;
      currency?: string;
      rows: Array<{
        id: string;
        category: { name: string; color?: string | null; icon?: string | null };
        amount: string;
        spent: string;
        /** spent/amount*100, clamped 0..100+ by the producer; renderer clamps the bar. */
        bar_pct: number;
        over?: boolean;
      }>;
      footer?: string;
    }
  | {
      /** Read-only bank accounts card. Used by listAccounts. `status`
       *  is the Plaid connection status (null for manual/CSV accounts).
       *  `total_balance` is present ONLY when every row shares one
       *  currency. */
      type: "accounts_list";
      title: string;
      total_balance?: string;
      currency?: string;
      rows: Array<{
        id: string;
        name: string;
        balance?: string | null;
        institution?: string | null;
        status?: PlaidItemStatus | null;
      }>;
      footer?: string;
    }
  | {
      /** Read-only scheduled-spend card. Shared by listScheduledSpends
       *  and listUnresolvedSchedules. `name` is the schedule's note if
       *  present, else its category name. `dismiss_intent` is present
       *  ONLY on unresolved rows — tapping Dismiss consumes that intent
       *  (runs dismissScheduledSpend). */
      type: "scheduled_list";
      title: string;
      period_label?: string;
      total_count: number;
      currency?: string;
      rows: Array<{
        id: string;
        name: string;
        amount: string;
        /** YYYY-MM-DD. */
        scheduled_date: string;
        status: "upcoming" | "unresolved" | "resolved-matched" | "resolved-dismissed";
        category?: { name: string; color?: string | null; icon?: string | null };
        dismiss_intent?: string;
      }>;
      footer?: string;
    }
  | {
      /** Detected recurring-merchant candidates. Used by
       *  detectRecurringMerchants. Each row's "Add" opens a prefilled
       *  recurring form bound to `add_form_intent` (a server-created
       *  addRecurring intent). Irregular-cadence candidates are excluded
       *  by the producer, so `cadence` is always a valid Cadence. */
      type: "recurring_candidates";
      title: string;
      currency?: string;
      rows: Array<{
        merchant: string;
        amount: string;
        cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
        occurrences: number;
        add_form_intent: string;
        defaults: {
          name: string;
          amount?: string;
          cadence?: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
          /** YYYY-MM-DD, derived server-side as lastSeen + one cadence interval. */
          next_occurrence_date?: string;
        };
      }>;
      footer?: string;
    }
  | {
      /** Single-transaction detail card. Used by getTransactionDetails.
       *  `amount` is a signed decimal string. `allocations` each carry a
       *  full category chip. */
      type: "transaction_detail";
      id: string;
      merchant: string;
      amount: string;
      currency?: string;
      date_label: string;
      account?: string;
      category?: { name: string; color?: string | null; icon?: string | null };
      note?: string | null;
      pending?: boolean;
      allocations?: Array<{
        category: { name: string; color?: string | null; icon?: string | null };
        amount: string;
      }>;
    }
  | {
      /** Read-only category chips. Used by listCategories. */
      type: "category_list";
      title: string;
      rows: Array<{ id: string; name: string; color?: string | null; icon?: string | null }>;
      footer?: string;
    }
```

- [ ] **Step 2: Build shared to verify the union compiles**

Run: `pnpm --filter @fina/shared build`
Expected: PASS (no TS errors).

- [ ] **Step 3: Commit**

```bash
git add libs/shared/src/dto/chat.ts
git commit -m "feat(shared): 6 read-tool presentation block types"
```

---

## Phase 1: budget_list

### Task 1a: Extract `spentByCategoryForPeriod` and refactor compareSpendingVsBudget

**Files:**
- Modify: `apps/api/src/budgets/service.ts`
- Test: `apps/api/tests/budgets.service.spent-helper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/budgets.service.spent-helper.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { spentByCategoryForPeriod } from "../src/budgets/service.js";

describe("spentByCategoryForPeriod", () => {
  let wsId: string;
  let userId: string;
  let catId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `sbc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "S", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "sbc-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    acctId = (await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
    })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("sums positive allocations for the category in this_month", async () => {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acctId, amount: "30.00",
        merchantRaw: "Bean", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false,
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: catId, amount: "30.00" },
    });
    const map = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "this_month", [catId]);
    expect(map.get(catId)?.toFixed(2)).toBe("30.00");
  });

  it("returns empty map for empty category list", async () => {
    const map = await spentByCategoryForPeriod({ workspaceId: wsId, userId }, "this_month", []);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test budgets.service.spent-helper`
Expected: FAIL — `spentByCategoryForPeriod` is not exported.

- [ ] **Step 3: Add the helper and refactor**

In `apps/api/src/budgets/service.ts`, add this exported function (after `offsetFor`, before `setBudgetService`):

```ts
/** Positive spend per category over a budget period. Extracted from
 *  compareSpendingVsBudgetService so getBudget can reuse the exact same
 *  aggregation. Takes the PERIOD ENUM (not a bare periodStart) because
 *  the tx range for this_month/last_month comes from basicPeriodRange;
 *  next_month is an empty range (spend always 0). */
export async function spentByCategoryForPeriod(
  ctx: { workspaceId: string; userId: string },
  period: PeriodEnum,
  categoryIds: string[],
): Promise<Map<string, Prisma.Decimal>> {
  if (categoryIds.length === 0) return new Map();
  let gte: Date;
  let lt: Date;
  if (period === "this_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "this_month"));
  } else if (period === "last_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "last_month"));
  } else {
    const periodStart = await firstOfMonthDateInTz(ctx.userId, offsetFor(period));
    gte = periodStart;
    lt = periodStart;
  }
  const sums = await prisma.transactionAllocation.groupBy({
    by: ["categoryId"],
    where: {
      categoryId: { in: categoryIds },
      amount: { gt: 0 },
      transaction: {
        workspaceId: ctx.workspaceId,
        removedAt: null,
        occurredAt: { gte, lt },
        amount: { gt: 0 },
      },
    },
    _sum: { amount: true },
  });
  return new Map(sums.map((s) => [s.categoryId!, s._sum.amount ?? new Prisma.Decimal(0)]));
}
```

Then in `compareSpendingVsBudgetService`, replace the inline spend block (the section computing `gte`/`lt` at the top AND the `sums`/`spentByCat` block, currently lines ~134-179) so the tx-range + groupBy are sourced from the helper. Specifically delete the `const sums = ...` and `const spentByCat = new Map(...)` block (lines ~163-179) and replace with:

```ts
  const budgetCategoryIds = budgets.map((b) => b.categoryId);
  const spentByCat = await spentByCategoryForPeriod(ctx, input.period, budgetCategoryIds);
```

Keep the existing `gte`/`lt` computation at the top of `compareSpendingVsBudgetService` — it is still used for the `period.end` (`lt`) in the return value and for the planned-schedule anti-join range. (The helper recomputes its own range internally; this duplication is intentional and cheap.)

- [ ] **Step 4: Run the new test + the existing compare test (regression)**

Run: `pnpm --filter @fina/api test budgets.service.spent-helper chat.tools.compare-spending-vs-budget`
Expected: PASS for both — the compare tool's spend totals are unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budgets/service.ts apps/api/tests/budgets.service.spent-helper.test.ts
git commit -m "refactor(budgets): extract spentByCategoryForPeriod"
```

### Task 1b: getBudget returns budget_list

**Files:**
- Modify: `apps/api/src/chat/tools/get-budget.ts`
- Test: `apps/api/tests/chat.tools.get-budget.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `apps/api/tests/chat.tools.get-budget.test.ts` (inside the `describe`):

```ts
  it("returns a budget_list block with spent + bar_pct + over", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
    });
    await prisma.budget.create({
      data: { workspaceId: wsId, categoryId: coffeeCatId, amount: "100.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, amount: "120.00",
        merchantRaw: "Bean", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false,
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: coffeeCatId, amount: "120.00" },
    });
    const r = await getBudget.run(ctx, {});
    expect(r.block?.type).toBe("budget_list");
    const row = r.block!.type === "budget_list" ? r.block!.rows[0]! : null;
    expect(row?.spent).toBe("120.00");
    expect(row?.over).toBe(true);
    expect(row?.bar_pct).toBeGreaterThan(100);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.get-budget`
Expected: FAIL — `r.block` is undefined.

- [ ] **Step 3: Implement the block**

Edit `apps/api/src/chat/tools/get-budget.ts`:

1. Add imports at top:

```ts
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { getBudgetService, spentByCategoryForPeriod } from "../../budgets/service.js";
```

(remove the old `getBudgetService`-only import line).

2. Widen the result type:

```ts
export const getBudget: ToolDef<
  Args,
  {
    budgets: Array<{ id: string; categoryId: string; categoryName: string; amount: string; periodStart: string }>;
    block?: PresentationBlock;
  }
> = {
```

3. In `run`, change the category select to include color/icon, and after building `budgets`, compute spend + block. Replace the `const cats = ...` / `nameById` / `return` tail with:

```ts
    const period = args.period ?? "this_month";
    const ids = out.budgets.map((b) => b.categoryId);
    const cats = await prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, color: true, icon: true },
    });
    const catById = new Map(cats.map((c) => [c.id, c]));
    const budgets = out.budgets.map((b) => ({
      ...b,
      categoryName: catById.get(b.categoryId)?.name ?? "",
    }));

    if (budgets.length === 0) return { budgets };

    const spentMap = await spentByCategoryForPeriod(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      period,
      ids,
    );
    const periodLabel =
      period === "this_month" ? "This month" : period === "last_month" ? "Last month" : "Next month";
    const rows = budgets.map((b) => {
      const cat = catById.get(b.categoryId);
      const spent = spentMap.get(b.categoryId) ?? new Prisma.Decimal(0);
      const amountDec = new Prisma.Decimal(b.amount);
      const barPct = amountDec.greaterThan(0)
        ? Number(spent.div(amountDec).times(100).toFixed(2))
        : 0;
      return {
        id: b.id,
        category: { name: b.categoryName, color: cat?.color ?? null, icon: cat?.icon ?? null },
        amount: b.amount,
        spent: spent.toFixed(2),
        bar_pct: barPct,
        over: spent.greaterThan(amountDec),
      };
    });
    const block: PresentationBlock = {
      type: "budget_list",
      title: "Budgets",
      period_label: periodLabel,
      currency: "CAD",
      rows,
    };
    return { budgets, block };
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.get-budget`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/get-budget.ts apps/api/tests/chat.tools.get-budget.test.ts
git commit -m "feat(chat): getBudget returns budget_list card"
```

---

## Phase 2: accounts_list

### Task 2: listAccounts returns accounts_list

**Files:**
- Modify: `apps/api/src/chat/tools/list-accounts.ts`
- Test: `apps/api/tests/chat.tools.list-accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.list-accounts.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listAccounts } from "../src/chat/tools/list-accounts.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listAccounts chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `la-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LA" } });
    const ws = await prisma.workspace.create({ data: { name: "la-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns an accounts_list block with total_balance for single-currency", async () => {
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chequing", type: "depository", currency: "CAD", balanceCurrent: "1200.50" },
    });
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Savings", type: "depository", currency: "CAD", balanceCurrent: "800.00" },
    });
    const r = await listAccounts.run(ctx, {});
    expect(r.block?.type).toBe("accounts_list");
    if (r.block?.type !== "accounts_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(2);
    expect(r.block.total_balance).toBe("2000.50");
  });

  it("omits total_balance when currencies differ", async () => {
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "CAD", type: "depository", currency: "CAD", balanceCurrent: "10.00" },
    });
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "USD", type: "depository", currency: "USD", balanceCurrent: "10.00" },
    });
    const r = await listAccounts.run(ctx, {});
    if (r.block?.type !== "accounts_list") throw new Error("wrong block");
    expect(r.block.total_balance).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.list-accounts`
Expected: FAIL — `r.block` undefined.

- [ ] **Step 3: Implement the block**

Edit `apps/api/src/chat/tools/list-accounts.ts`:

1. Add import: `import type { PresentationBlock } from "@fina/shared";`
2. Change the tool result type to `{ accounts: Account[]; block?: PresentationBlock }`.
3. Before `return { accounts };`, build and include the block:

```ts
    const currencies = new Set(accounts.map((a) => a.currency));
    let totalBalance: string | undefined;
    if (currencies.size === 1) {
      const sum = accounts.reduce(
        (s, a) => s + (a.balanceCurrent ? parseFloat(a.balanceCurrent) : 0),
        0,
      );
      totalBalance = sum.toFixed(2);
    }
    const block: PresentationBlock = {
      type: "accounts_list",
      title: "Accounts",
      currency: accounts[0]?.currency ?? "CAD",
      ...(totalBalance !== undefined ? { total_balance: totalBalance } : {}),
      rows: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        balance: a.balanceCurrent,
        institution: a.institutionName,
        status: a.plaidItemStatus,
      })),
    };
    return { accounts, block };
```

(`exactOptionalPropertyTypes` is on — that's why `total_balance` is spread conditionally rather than set to `undefined`.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.list-accounts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/list-accounts.ts apps/api/tests/chat.tools.list-accounts.test.ts
git commit -m "feat(chat): listAccounts returns accounts_list card"
```

---

## Phase 3: scheduled_list (two tools)

### Task 3a: listScheduledSpends returns scheduled_list

**Files:**
- Modify: `apps/api/src/chat/tools/list-scheduled-spends.ts`
- Test: `apps/api/tests/chat.tools.list-scheduled-spends.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.list-scheduled-spends.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listScheduledSpends } from "../src/chat/tools/list-scheduled-spends.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listScheduledSpends chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catId: string;

  beforeEach(async () => {
    const stamp = `lss-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LSS", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lss-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Rent" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a scheduled_list block with no dismiss_intent", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: catId, amount: "1500.00", scheduledDate: new Date("2026-06-01"), note: "June rent" },
    });
    const r = await listScheduledSpends.run(ctx, {});
    expect(r.block?.type).toBe("scheduled_list");
    if (r.block?.type !== "scheduled_list") throw new Error("wrong block");
    expect(r.block.rows[0]!.name).toBe("June rent");
    expect(r.block.rows[0]!.dismiss_intent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.list-scheduled-spends`
Expected: FAIL — `r.block` undefined.

- [ ] **Step 3: Implement the block**

Edit `apps/api/src/chat/tools/list-scheduled-spends.ts`:

1. Add `import type { PresentationBlock } from "@fina/shared";`.
2. Add `block?: PresentationBlock;` to the `Result` type.
3. Change the category select to `{ id: true, name: true, color: true, icon: true }` and build a `catById` map (keep the existing name map too, or derive name from it).
4. Replace the `return { schedules: ... }` with:

```ts
    const catById = new Map(cats.map((c) => [c.id, c]));
    const schedules = r.schedules.map((s) => ({
      ...s,
      categoryName: catById.get(s.categoryId)?.name ?? "Unknown",
    }));
    const block: PresentationBlock = {
      type: "scheduled_list",
      title: "Scheduled spending",
      total_count: schedules.length,
      currency: "CAD",
      rows: schedules.map((s) => {
        const cat = catById.get(s.categoryId);
        return {
          id: s.id,
          name: s.note ?? s.categoryName,
          amount: s.amount,
          scheduled_date: s.scheduledDate,
          status: s.status,
          ...(cat ? { category: { name: cat.name, color: cat.color, icon: cat.icon } } : {}),
        };
      }),
    };
    return { schedules, block };
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.list-scheduled-spends`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/list-scheduled-spends.ts apps/api/tests/chat.tools.list-scheduled-spends.test.ts
git commit -m "feat(chat): listScheduledSpends returns scheduled_list card"
```

### Task 3b: listUnresolvedSchedules returns scheduled_list with dismiss intents

**Files:**
- Modify: `apps/api/src/chat/tools/list-unresolved-schedules.ts`
- Test: `apps/api/tests/chat.tools.list-unresolved-schedules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.list-unresolved-schedules.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listUnresolvedSchedules } from "../src/chat/tools/list-unresolved-schedules.js";
import { consumeIntentService } from "../src/intents/service.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listUnresolvedSchedules chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let catId: string;

  beforeEach(async () => {
    const stamp = `lus-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LUS", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lus-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    catId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Rent" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns scheduled_list with a consumable dismiss_intent per row", async () => {
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: catId, amount: "1500.00", scheduledDate: new Date("2026-05-01"), note: "May rent" },
    });
    const r = await listUnresolvedSchedules.run(ctx, {});
    if (r.block?.type !== "scheduled_list") throw new Error("wrong block");
    const row = r.block.rows[0]!;
    expect(row.status).toBe("unresolved");
    expect(typeof row.dismiss_intent).toBe("string");

    // The intent runs dismissScheduledSpend.
    const out = await consumeIntentService(
      { workspaceId: wsId, userId: ctx.userId, role: "owner", env: {} as never },
      row.dismiss_intent!,
    );
    expect(out.result).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.list-unresolved-schedules`
Expected: FAIL — `r.block` undefined.

- [ ] **Step 3: Implement**

Edit `apps/api/src/chat/tools/list-unresolved-schedules.ts`:

1. Add imports:

```ts
import type { PresentationBlock } from "@fina/shared";
import { createIntentService } from "../../intents/service.js";
```

2. Add `block?: PresentationBlock;` to `Result`.
3. Change the category select to include `color, icon`, build `catById`.
4. Replace the `return { schedules: ... }` tail with a loop that creates a dismiss intent per schedule (full args, NO skipStrictValidate), then builds the block:

```ts
    const catById = new Map(cats.map((c) => [c.id, c]));
    const rows: Extract<PresentationBlock, { type: "scheduled_list" }>["rows"] = [];
    const schedules: Result["schedules"] = [];
    for (const s of r.schedules) {
      const categoryName = catById.get(s.categoryId)?.name ?? "Unknown";
      schedules.push({ id: s.id, categoryId: s.categoryId, categoryName, amount: s.amount, scheduledDate: s.scheduledDate, note: s.note });
      const intent = await createIntentService(
        { workspaceId: ctx.workspaceId, userId: ctx.userId },
        { tool: "dismissScheduledSpend", args: { schedule_id: s.id } },
      );
      const cat = catById.get(s.categoryId);
      rows.push({
        id: s.id,
        name: s.note ?? categoryName,
        amount: s.amount,
        scheduled_date: s.scheduledDate,
        status: "unresolved",
        ...(cat ? { category: { name: cat.name, color: cat.color, icon: cat.icon } } : {}),
        dismiss_intent: intent.intent.id,
      });
    }
    const block: PresentationBlock = {
      type: "scheduled_list",
      title: "Unresolved scheduled spending",
      total_count: rows.length,
      currency: "CAD",
      rows,
    };
    return { schedules, block };
```

> Note: verify `dismissScheduledSpend`'s arg name by opening `apps/api/src/chat/tools/dismiss-scheduled-spend.ts` — it is `schedule_id`. If different, match it.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.list-unresolved-schedules`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/list-unresolved-schedules.ts apps/api/tests/chat.tools.list-unresolved-schedules.test.ts
git commit -m "feat(chat): listUnresolvedSchedules returns scheduled_list + dismiss intents"
```

---

## Phase 4: recurring_candidates

### Task 4: detectRecurringMerchants returns recurring_candidates

**Files:**
- Modify: `apps/api/src/chat/tools/detect-recurring-merchants.ts`
- Test: `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts` (reuse its existing setup — it already seeds monthly transactions). Add:

```ts
  it("returns recurring_candidates with a consumable add_form_intent and excludes irregular", async () => {
    // (Reuse the existing beforeEach that seeds a monthly merchant.)
    const r = await detectRecurringMerchants.run(ctx, {});
    if (!r.block) throw new Error("no block — seed a monthly merchant in beforeEach");
    if (r.block.type !== "recurring_candidates") throw new Error("wrong block");
    const row = r.block.rows[0]!;
    expect(["monthly", "biweekly", "weekly", "semimonthly", "yearly"]).toContain(row.cadence);
    expect(typeof row.add_form_intent).toBe("string");
    expect(row.defaults.next_occurrence_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The form intent resolves to addRecurring once the user supplies a date.
    const { consumeIntentService } = await import("../src/intents/service.js");
    const out = await consumeIntentService(
      { workspaceId: wsId, userId: ctx.userId, role: "owner", env: {} as never },
      row.add_form_intent,
      { next_occurrence_date: row.defaults.next_occurrence_date },
    );
    expect(out.result).toBeTruthy();
  });
```

> If the existing test file's `beforeEach` does not seed a recurring-looking merchant (≥3 monthly occurrences of the same merchant), add that seeding to a local setup inside this `it` instead. The detector needs ≥ `min_occurrences` (default 3) and confidence ≥ 0.45.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.detect-recurring-merchants`
Expected: FAIL — `r.block` undefined.

- [ ] **Step 3: Implement**

Edit `apps/api/src/chat/tools/detect-recurring-merchants.ts`:

1. Add imports:

```ts
import type { PresentationBlock } from "@fina/shared";
import { createIntentService } from "../../intents/service.js";
```

2. Change `Result` to `{ lookbackMonths: number; candidates: Candidate[]; block?: PresentationBlock }`.
3. Add a date-derivation helper near the other top-level helpers:

```ts
/** Next expected charge = last seen + one cadence interval. The detector
 *  has no native next-date; this seeds the form's date field, which the
 *  user can still adjust. Irregular candidates never reach here. */
function deriveNextOccurrence(
  lastSeenIso: string,
  cadence: "weekly" | "biweekly" | "monthly",
): string {
  const d = new Date(lastSeenIso);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}
```

4. At the end of `run`, replace `return { lookbackMonths, candidates: candidates.slice(0, limit) };` with:

```ts
    const top = candidates.slice(0, limit);
    const stable = top.filter(
      (c): c is Candidate & { cadence: "weekly" | "biweekly" | "monthly" } =>
        c.cadence !== "irregular",
    );

    let block: PresentationBlock | undefined;
    if (stable.length > 0) {
      const rows: Extract<PresentationBlock, { type: "recurring_candidates" }>["rows"] = [];
      for (const c of stable) {
        const nextDate = deriveNextOccurrence(c.lastSeenAt, c.cadence);
        const intent = await createIntentService(
          { workspaceId: ctx.workspaceId, userId: ctx.userId },
          {
            tool: "addRecurring",
            args: {
              name: c.displayName,
              amount: parseFloat(c.medianAmount),
              cadence: c.cadence,
              next_occurrence_date: nextDate,
            },
            skipStrictValidate: true,
          },
        );
        rows.push({
          merchant: c.displayName,
          amount: c.medianAmount,
          cadence: c.cadence,
          occurrences: c.occurrences,
          add_form_intent: intent.intent.id,
          defaults: {
            name: c.displayName,
            amount: c.medianAmount,
            cadence: c.cadence,
            next_occurrence_date: nextDate,
          },
        });
      }
      block = {
        type: "recurring_candidates",
        title: "Possible subscriptions",
        currency: stable[0]!.currency,
        rows,
      };
    }

    return { lookbackMonths, candidates: top, block };
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.detect-recurring-merchants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/detect-recurring-merchants.ts apps/api/tests/chat.tools.detect-recurring-merchants.test.ts
git commit -m "feat(chat): detectRecurringMerchants returns recurring_candidates + form intents"
```

---

## Phase 5: transaction_detail

### Task 5: getTransactionDetails returns transaction_detail

**Files:**
- Modify: `apps/api/src/chat/tools/get-transaction-details.ts`
- Test: `apps/api/tests/chat.tools.get-transaction-details.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.get-transaction-details.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { getTransactionDetails } from "../src/chat/tools/get-transaction-details.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getTransactionDetails chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `gtd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GTD" } });
    const ws = await prisma.workspace.create({ data: { name: "gtd-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a transaction_detail block with allocation category chips", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" },
    });
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Groceries", color: "#33aa55", icon: "🛒" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, amount: "42.10",
        merchantRaw: "Loblaws", occurredAt: new Date("2026-05-10T12:00:00Z"),
        source: "manual", pending: false,
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx.id, categoryId: cat.id, amount: "42.10" },
    });
    const r = await getTransactionDetails.run(ctx, { tx_id: tx.id });
    expect(r.block?.type).toBe("transaction_detail");
    if (r.block?.type !== "transaction_detail") throw new Error("wrong block");
    expect(r.block.merchant).toBe("Loblaws");
    expect(r.block.category?.name).toBe("Groceries");
    expect(r.block.allocations?.[0]!.category.icon).toBe("🛒");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.get-transaction-details`
Expected: FAIL — `r.block` undefined.

- [ ] **Step 3: Implement**

Edit `apps/api/src/chat/tools/get-transaction-details.ts`:

1. Add `import type { PresentationBlock } from "@fina/shared";`.
2. Add `block?: PresentationBlock;` to the `Result` type (alongside `transaction`).
3. Extend the allocation `category` select to include color + icon:

```ts
              category: {
                select: { id: true, name: true, color: true, icon: true, parentId: true, parent: { select: { name: true } } },
              },
```

4. Build a `date_label` and the block before the `return`. Replace the existing `return { transaction: {...} };` so it also returns `block`. After computing `cat` (the primary allocation category), add:

```ts
    const dateLabel = tx.occurredAt.toLocaleDateString("en-CA", {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    });
    const block: PresentationBlock = {
      type: "transaction_detail",
      id: tx.id,
      merchant: tx.merchantRaw,
      amount: tx.amount.toString(),
      currency: workspace.currency,
      date_label: dateLabel,
      account: tx.account.name,
      ...(cat ? { category: { name: cat.name, color: (cat as any).color ?? null, icon: (cat as any).icon ?? null } } : {}),
      note: tx.note,
      pending: tx.pending,
      allocations: tx.allocations
        .filter((a) => a.category)
        .map((a) => ({
          category: { name: a.category!.name, color: a.category!.color ?? null, icon: a.category!.icon ?? null },
          amount: a.amount.toString(),
        })),
    };
```

Then change the `return` to `return { transaction: {...the existing object...}, block };`.

> Note: the existing top-level `category` mapping object only has `{id,name,parentId,parentName}`; that is fine — it's the LLM-facing shape. The `block` carries the chip fields. `(cat as any)` is used only because the existing top-level `cat` type doesn't include color/icon; after extending the select, `cat.color`/`cat.icon` exist at runtime.

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.get-transaction-details`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/get-transaction-details.ts apps/api/tests/chat.tools.get-transaction-details.test.ts
git commit -m "feat(chat): getTransactionDetails returns transaction_detail card"
```

---

## Phase 6: category_list

### Task 6: listCategories returns category_list

**Files:**
- Modify: `apps/api/src/chat/tools/list-categories.ts`
- Test: `apps/api/tests/chat.tools.list-categories.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.list-categories.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listCategories } from "../src/chat/tools/list-categories.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listCategories chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `lc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LC" } });
    const ws = await prisma.workspace.create({ data: { name: "lc-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a category_list block with color/icon", async () => {
    await prisma.category.create({ data: { workspaceId: wsId, name: "Food", color: "#abc123", icon: "🍔" } });
    const r = await listCategories.run(ctx, {});
    expect(r.block?.type).toBe("category_list");
    if (r.block?.type !== "category_list") throw new Error("wrong block");
    expect(r.block.rows[0]!.icon).toBe("🍔");
    expect(r.block.rows[0]!.color).toBe("#abc123");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test chat.tools.list-categories`
Expected: FAIL.

- [ ] **Step 3: Implement**

Replace the body of `apps/api/src/chat/tools/list-categories.ts`:

```ts
import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});
type Args = z.infer<typeof Args>;

export const listCategories: ToolDef<
  Args,
  { categories: Array<{ id: string; name: string; color: string | null; icon: string | null }>; block?: PresentationBlock }
> = {
  name: "listCategories",
  description: "List the categories defined in the user's workspace.",
  args: Args,
  async run(ctx) {
    const rows = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, icon: true },
    });
    const block: PresentationBlock = {
      type: "category_list",
      title: "Categories",
      rows: rows.map((r) => ({ id: r.id, name: r.name, color: r.color, icon: r.icon })),
    };
    return { categories: rows, block };
  },
};
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test chat.tools.list-categories`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/list-categories.ts apps/api/tests/chat.tools.list-categories.test.ts
git commit -m "feat(chat): listCategories returns category_list card"
```

---

## Phase 7: ActionIntent sweeper

### Task 7: Expired-intent sweep + register in cron

**Files:**
- Create: `apps/api/src/intents/sweep.ts`
- Test: `apps/api/tests/intents.sweep.test.ts`
- Modify: the cron scheduler (read `apps/api/src/cron/scheduler.ts` first to match the registration pattern used by `daily-brief`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/intents.sweep.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { sweepExpiredIntents } from "../src/intents/sweep.js";

describe("sweepExpiredIntents", () => {
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `sw-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "SW" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "sw-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("deletes expired unconsumed intents and keeps active/consumed ones", async () => {
    const base = { workspaceId: wsId, userId, kind: "tool_call", payload: {} as never };
    const expired = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() - 60_000) },
    });
    const active = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const consumed = await prisma.actionIntent.create({
      data: { ...base, expiresAt: new Date(Date.now() - 60_000), consumedAt: new Date() },
    });

    const n = await sweepExpiredIntents();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await prisma.actionIntent.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.actionIntent.findUnique({ where: { id: active.id } })).not.toBeNull();
    expect(await prisma.actionIntent.findUnique({ where: { id: consumed.id } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @fina/api test intents.sweep`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sweeper**

Create `apps/api/src/intents/sweep.ts`:

```ts
import { prisma } from "../db.js";

/** Delete unconsumed ActionIntents whose TTL has passed. Consumed intents
 *  are kept (audit trail references them). Interactive read-tool cards
 *  (recurring_candidates, scheduled_list) pre-create intents eagerly, so
 *  this bounds the table. Returns the number deleted. */
export async function sweepExpiredIntents(): Promise<number> {
  const { count } = await prisma.actionIntent.deleteMany({
    where: { consumedAt: null, expiresAt: { lt: new Date() } },
  });
  return count;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @fina/api test intents.sweep`
Expected: PASS.

- [ ] **Step 5: Register in the cron scheduler**

Open `apps/api/src/cron/scheduler.ts` and find how `daily-brief` is scheduled (it imports a job fn and registers it on an interval/cron). Add an equivalent registration that calls `sweepExpiredIntents` hourly. Match the file's existing style exactly — e.g. if jobs are registered as `{ name, schedule, run }` entries, add:

```ts
import { sweepExpiredIntents } from "../intents/sweep.js";
// ...inside the jobs registration list/loop, hourly:
{ name: "sweep-expired-intents", schedule: "0 * * * *", run: async () => { await sweepExpiredIntents(); } },
```

If the scheduler uses a different registration shape, mirror that shape — the only requirement is `sweepExpiredIntents()` runs roughly hourly.

- [ ] **Step 6: Build the api to verify the registration compiles**

Run: `pnpm --filter @fina/api build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/intents/sweep.ts apps/api/tests/intents.sweep.test.ts apps/api/src/cron/scheduler.ts
git commit -m "feat(intents): hourly sweep of expired unconsumed intents"
```

---

## Phase 8: turn.ts prompt reconciliation

### Task 8: Reconcile getBudget vs compareSpendingVsBudget guidance

**Files:**
- Modify: `apps/api/src/chat/turn.ts`

- [ ] **Step 1: Locate the current guidance**

Run: `grep -n "getBudget\|compareSpendingVsBudget" apps/api/src/chat/turn.ts`
Read the lines around the match (the existing prompt says getBudget is only for the configured number and to use compareSpendingVsBudget for usage/status).

- [ ] **Step 2: Update the sentence**

Edit that guidance so it reads (adapt wording to the surrounding prose):

> `getBudget` now renders a budget card showing each category's configured amount, current spend, and a progress bar — use it for "show my budgets" / "how am I doing on budget". Use `compareSpendingVsBudget` for explicit period-to-period comparisons or pace narrative. Both render cards, so do NOT re-list the numbers as text.

No new per-tool "renders a card" guidance is needed — the existing generic "Card / text split" rule already covers the six new card tools. Just confirm (by reading that section) that it says "when a tool returns a block, write one sentence, don't enumerate."

- [ ] **Step 3: Build to verify**

Run: `pnpm --filter @fina/api build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/chat/turn.ts
git commit -m "docs(chat): reconcile getBudget vs compareSpendingVsBudget prompt guidance"
```

---

## Phase 9: Mobile renderers

### Task 9a: BudgetListBlock + CategoryListBlock + AccountsListBlock (read-only)

**Files:**
- Create: `apps/mobile/src/chat/blocks/BudgetListBlock.tsx`, `CategoryListBlock.tsx`, `AccountsListBlock.tsx`

- [ ] **Step 1: Create BudgetListBlock**

`apps/mobile/src/chat/blocks/BudgetListBlock.tsx`:

```tsx
import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "budget_list" }>;
type Props = { block: Block };

function symbol(code?: string) {
  switch ((code ?? "CAD").toUpperCase()) {
    case "USD": return "US$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "KRW": return "₩";
    default: return "$";
  }
}

export function BudgetListBlock({ block }: Props) {
  const sym = symbol(block.currency);
  return (
    <BlockCard>
      <BlockHeader title={block.title} {...(block.period_label ? { subtitle: block.period_label } : {})} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No budgets set yet." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const pct = Math.max(0, Math.min(100, r.bar_pct));
            return (
              <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={styles.line}>
                  <Text style={styles.name} numberOfLines={1}>
                    {r.category.icon ? `${r.category.icon} ` : ""}{r.category.name}
                  </Text>
                  <Text style={[styles.amount, r.over && { color: colors.down }]}>
                    {sym}{r.spent} / {sym}{r.amount}
                  </Text>
                </View>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${pct}%`, backgroundColor: r.over ? colors.down : (r.category.color ?? colors.primary) }]} />
                </View>
              </View>
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: 6 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500", flex: 1, minWidth: 0 },
  amount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
});
```

- [ ] **Step 2: Create CategoryListBlock**

`apps/mobile/src/chat/blocks/CategoryListBlock.tsx`:

```tsx
import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "category_list" }>;

export function CategoryListBlock({ block }: { block: Block }) {
  return (
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No categories yet." />
      ) : (
        <View style={styles.chips}>
          {block.rows.map((r) => (
            <View
              key={r.id}
              style={[styles.chip, { backgroundColor: r.color ? `${r.color}22` : colors.surfaceSoft }]}
            >
              <Text style={[styles.chipText, { color: r.color ?? colors.body }]} numberOfLines={1}>
                {r.icon ? `${r.icon} ` : ""}{r.name}
              </Text>
            </View>
          ))}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.xs },
  chip: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 },
  chipText: { ...type$.caption, fontWeight: "600" },
});
```

- [ ] **Step 3: Create AccountsListBlock**

`apps/mobile/src/chat/blocks/AccountsListBlock.tsx`:

```tsx
import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock, PlaidItemStatus } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "accounts_list" }>;

function symbol(code?: string) {
  switch ((code ?? "CAD").toUpperCase()) {
    case "USD": return "US$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "KRW": return "₩";
    default: return "$";
  }
}

/** Plaid status → badge label + tone. null = manual/CSV, no badge. */
function statusBadge(status: PlaidItemStatus | null | undefined): { label: string; color: string } | null {
  switch (status) {
    case "error": return { label: "Error", color: colors.down };
    case "relink_required": return { label: "Reconnect", color: colors.down };
    case "disconnected": return { label: "Disconnected", color: colors.muted };
    case "active":
    case null:
    case undefined:
    default: return null;
  }
}

export function AccountsListBlock({ block }: { block: Block }) {
  const sym = symbol(block.currency);
  return (
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.total_balance ? (
        <Text style={styles.total}>
          <Text style={styles.totalAmount}>{sym}{block.total_balance}</Text>
          <Text style={styles.totalSub}> total</Text>
        </Text>
      ) : null}
      {block.rows.length === 0 ? (
        <BlockEmpty text="No accounts connected." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const badge = statusBadge(r.status);
            return (
              <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.name}</Text>
                  {r.institution ? <Text style={styles.inst} numberOfLines={1}>{r.institution}</Text> : null}
                </View>
                <View style={styles.right}>
                  {r.balance ? <Text style={styles.bal}>{sym}{r.balance}</Text> : null}
                  {badge ? <Text style={[styles.badge, { color: badge.color }]}>{badge.label}</Text> : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  total: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  totalAmount: { color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  totalSub: { color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: space.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  inst: { ...type$.caption, color: colors.muted, marginTop: 1 },
  right: { alignItems: "flex-end", gap: 2 },
  bal: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"] },
  badge: { ...type$.caption, fontWeight: "600" },
});
```

- [ ] **Step 4: Typecheck mobile**

Run: `pnpm --filter @fina/mobile exec tsc --noEmit`
Expected: PASS (these files are not yet imported, but should compile).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/chat/blocks/BudgetListBlock.tsx apps/mobile/src/chat/blocks/CategoryListBlock.tsx apps/mobile/src/chat/blocks/AccountsListBlock.tsx
git commit -m "feat(mobile/chat): budget/category/accounts block components"
```

### Task 9b: ScheduledListBlock (with Dismiss action) + TransactionDetailBlock

**Files:**
- Create: `apps/mobile/src/chat/blocks/ScheduledListBlock.tsx`, `TransactionDetailBlock.tsx`

- [ ] **Step 1: Create ScheduledListBlock**

`apps/mobile/src/chat/blocks/ScheduledListBlock.tsx` — read-only rows, with an optimistic Dismiss button on rows that carry `dismiss_intent`:

```tsx
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "scheduled_list" }>;
type Row = Block["rows"][number];

type Props = {
  block: Block;
  /** Consume the dismiss intent (runs dismissScheduledSpend server-side). */
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
};

function symbol(code?: string) {
  switch ((code ?? "CAD").toUpperCase()) {
    case "USD": return "US$"; case "EUR": return "€"; case "GBP": return "£"; case "KRW": return "₩"; default: return "$";
  }
}

export function ScheduledListBlock({ block, onSubmitForm }: Props) {
  const sym = symbol(block.currency);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const rows = block.rows.filter((r) => !dismissed.has(r.id));

  return (
    <BlockCard>
      <BlockHeader title={block.title} {...(block.period_label ? { subtitle: block.period_label } : {})} />
      {rows.length === 0 ? (
        <BlockEmpty text="Nothing scheduled." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {rows.map((r, i) => (
            <ScheduledRow
              key={r.id}
              row={r}
              sym={sym}
              isLast={i === rows.length - 1}
              onDismiss={
                r.dismiss_intent && onSubmitForm
                  ? async () => {
                      setDismissed((prev) => new Set(prev).add(r.id));
                      try { await onSubmitForm(r.dismiss_intent!, {}); } catch { /* keep optimistic */ }
                    }
                  : undefined
              }
            />
          ))}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

function ScheduledRow({ row, sym, isLast, onDismiss }: { row: Row; sym: string; isLast: boolean; onDismiss?: () => void }) {
  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1}>{row.name}</Text>
        <Text style={styles.date} numberOfLines={1}>{row.scheduled_date}</Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.amount}>{sym}{row.amount}</Text>
        {onDismiss ? (
          <Pressable onPress={onDismiss} style={({ pressed }) => [styles.dismiss, pressed && { opacity: 0.6 }]}>
            <Text style={styles.dismissText}>Dismiss</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 10, gap: space.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  date: { ...type$.caption, color: colors.muted, marginTop: 1 },
  right: { alignItems: "flex-end", gap: 4 },
  amount: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"] },
  dismiss: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.hairline },
  dismissText: { ...type$.caption, color: colors.body, fontWeight: "600" },
});
```

- [ ] **Step 2: Create TransactionDetailBlock**

`apps/mobile/src/chat/blocks/TransactionDetailBlock.tsx`:

```tsx
import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "transaction_detail" }>;

function symbol(code?: string) {
  switch ((code ?? "CAD").toUpperCase()) {
    case "USD": return "US$"; case "EUR": return "€"; case "GBP": return "£"; case "KRW": return "₩"; default: return "$";
  }
}

function Chip({ category }: { category: { name: string; color?: string | null; icon?: string | null } }) {
  return (
    <View style={[styles.chip, { backgroundColor: category.color ? `${category.color}22` : colors.surfaceSoft }]}>
      <Text style={[styles.chipText, { color: category.color ?? colors.body }]} numberOfLines={1}>
        {category.icon ? `${category.icon} ` : ""}{category.name}
      </Text>
    </View>
  );
}

export function TransactionDetailBlock({ block }: { block: Block }) {
  const sym = symbol(block.currency);
  const showAllocations = (block.allocations?.length ?? 0) > 1;
  return (
    <BlockCard>
      <View style={styles.headRow}>
        <Text style={styles.merchant} numberOfLines={2}>{block.merchant}</Text>
        <Text style={styles.amount}>{sym}{block.amount}</Text>
      </View>
      <Text style={styles.meta}>
        {block.date_label}{block.account ? ` · ${block.account}` : ""}{block.pending ? " · pending" : ""}
      </Text>
      {block.category ? <View style={styles.chips}><Chip category={block.category} /></View> : null}
      {block.note ? <Text style={styles.note}>{block.note}</Text> : null}
      {showAllocations ? (
        <View style={styles.allocs}>
          {block.allocations!.map((a, i) => (
            <View key={i} style={styles.allocRow}>
              <Chip category={a.category} />
              <Text style={styles.allocAmount}>{sym}{a.amount}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.sm },
  merchant: { ...type$.titleSm, color: colors.ink, flex: 1, minWidth: 0 },
  amount: { ...type$.titleSm, color: colors.ink, fontVariant: ["tabular-nums"] },
  meta: { ...type$.caption, color: colors.muted, marginTop: 2 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: space.xs },
  note: { ...type$.bodySm, color: colors.body, marginTop: space.xs, fontStyle: "italic" },
  allocs: { marginTop: space.sm, gap: 6 },
  allocRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  allocAmount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  chip: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: 6, alignSelf: "flex-start" },
  chipText: { ...type$.caption, fontWeight: "600" },
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @fina/mobile exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/chat/blocks/ScheduledListBlock.tsx apps/mobile/src/chat/blocks/TransactionDetailBlock.tsx
git commit -m "feat(mobile/chat): scheduled-list (dismiss) + transaction-detail blocks"
```

### Task 9c: RecurringCandidatesBlock (Add → prefilled form)

**Files:**
- Create: `apps/mobile/src/chat/blocks/RecurringCandidatesBlock.tsx`

- [ ] **Step 1: Create the component**

It renders each candidate with an "Add" button. Tapping Add expands that row into the existing `RecurringFormBlock`, constructed from the candidate's `defaults` + `add_form_intent`. Submission reuses the same `onSubmitForm` the form card uses.

`apps/mobile/src/chat/blocks/RecurringCandidatesBlock.tsx`:

```tsx
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty } from "./_primitives";
import { RecurringFormBlock } from "./RecurringFormBlock";

type Block = Extract<PresentationBlock, { type: "recurring_candidates" }>;
type Row = Block["rows"][number];
type FormCard = Extract<PresentationBlock, { type: "recurring_form_card" }>;

type Props = {
  block: Block;
  onSubmitForm?: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onFormFocusChange?: (focused: boolean) => void;
};

function symbol(code?: string) {
  switch ((code ?? "CAD").toUpperCase()) {
    case "USD": return "US$"; case "EUR": return "€"; case "GBP": return "£"; case "KRW": return "₩"; default: return "$";
  }
}

function cadenceLabel(c: Row["cadence"]): string {
  switch (c) {
    case "monthly": return "mo"; case "semimonthly": return "½ mo"; case "biweekly": return "2 wk"; case "weekly": return "wk"; case "yearly": return "yr";
  }
}

/** Build the synthetic recurring_form_card the existing form renderer expects. */
function toFormCard(row: Row): FormCard {
  return {
    type: "recurring_form_card",
    question: `Add ${row.merchant} as a recurring expense?`,
    intent_id: row.add_form_intent,
    defaults: row.defaults,
    currency: "CAD",
    mode: "add",
  };
}

export function RecurringCandidatesBlock({ block, onSubmitForm, onFormFocusChange }: Props) {
  const sym = symbol(block.currency);
  const [openIntent, setOpenIntent] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());

  return (
    <BlockCard>
      <BlockHeader title={block.title} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No recurring patterns detected." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const isOpen = openIntent === r.add_form_intent;
            if (isOpen) {
              return (
                <View key={r.add_form_intent} style={styles.formWrap}>
                  <RecurringFormBlock
                    block={toFormCard(r)}
                    onSubmit={async (id, overrides) => {
                      if (onSubmitForm) await onSubmitForm(id, overrides);
                      setAdded((prev) => new Set(prev).add(r.add_form_intent));
                      setOpenIntent(null);
                    }}
                    onCancel={() => setOpenIntent(null)}
                    {...(onFormFocusChange ? { onFocusChange: onFormFocusChange } : {})}
                  />
                </View>
              );
            }
            return (
              <View key={r.add_form_intent} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.merchant}</Text>
                  <Text style={styles.sub} numberOfLines={1}>
                    {sym}{r.amount} / {cadenceLabel(r.cadence)} · seen {r.occurrences}×
                  </Text>
                </View>
                {added.has(r.add_form_intent) ? (
                  <Text style={styles.addedText}>Added</Text>
                ) : (
                  <Pressable
                    onPress={() => setOpenIntent(r.add_form_intent)}
                    style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.85 }]}
                  >
                    <Text style={styles.addBtnText}>Add</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: space.sm },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  sub: { ...type$.caption, color: colors.muted, marginTop: 1 },
  addBtn: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.primary },
  addBtnText: { ...type$.button, color: colors.onPrimary },
  addedText: { ...type$.caption, color: colors.muted, fontWeight: "600" },
  formWrap: { paddingVertical: space.xs },
});
```

> Verify `RecurringFormBlock`'s prop names (`block`, `onSubmit`, `onCancel`, `onFocusChange`) by opening the file — they match how `PresentationBlock.tsx` calls it today. If `onSubmit`'s signature differs, mirror it.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @fina/mobile exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/chat/blocks/RecurringCandidatesBlock.tsx
git commit -m "feat(mobile/chat): recurring-candidates block with inline add form"
```

### Task 9d: Wire all 6 into PresentationBlock + isCardBlock

**Files:**
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx`
- Modify: `apps/mobile/src/chat/ThreadView.tsx`

- [ ] **Step 1: Add imports + branches in PresentationBlock.tsx**

At the top of `apps/mobile/src/chat/PresentationBlock.tsx`, add:

```tsx
import { BudgetListBlock } from "./blocks/BudgetListBlock";
import { AccountsListBlock } from "./blocks/AccountsListBlock";
import { ScheduledListBlock } from "./blocks/ScheduledListBlock";
import { RecurringCandidatesBlock } from "./blocks/RecurringCandidatesBlock";
import { TransactionDetailBlock } from "./blocks/TransactionDetailBlock";
import { CategoryListBlock } from "./blocks/CategoryListBlock";
```

Before the `const _exhaustive: never = block;` line, add the six branches:

```tsx
  if (block.type === "budget_list") {
    return <BudgetListBlock block={block} />;
  }
  if (block.type === "accounts_list") {
    return <AccountsListBlock block={block} />;
  }
  if (block.type === "scheduled_list") {
    return <ScheduledListBlock block={block} {...(onSubmitForm ? { onSubmitForm } : {})} />;
  }
  if (block.type === "recurring_candidates") {
    return (
      <RecurringCandidatesBlock
        block={block}
        {...(onSubmitForm ? { onSubmitForm } : {})}
        {...(onFormFocusChange ? { onFormFocusChange } : {})}
      />
    );
  }
  if (block.type === "transaction_detail") {
    return <TransactionDetailBlock block={block} />;
  }
  if (block.type === "category_list") {
    return <CategoryListBlock block={block} />;
  }
```

- [ ] **Step 2: Register card types in isCardBlock (ThreadView.tsx)**

In `apps/mobile/src/chat/ThreadView.tsx`, extend `isCardBlock` (around line 531):

```tsx
function isCardBlock(b: Block): boolean {
  return (
    b.type === "recap" ||
    b.type === "transactions_list" ||
    b.type === "recurring_list" ||
    b.type === "recurring_form_card" ||
    b.type === "confirm_card" ||
    b.type === "categorize_confirm_card" ||
    b.type === "budget_list" ||
    b.type === "accounts_list" ||
    b.type === "scheduled_list" ||
    b.type === "recurring_candidates" ||
    b.type === "transaction_detail" ||
    b.type === "category_list"
  );
}
```

- [ ] **Step 3: Typecheck — the never-cast now proves exhaustiveness**

Run: `pnpm --filter @fina/mobile exec tsc --noEmit`
Expected: PASS. (If a block type is missing a branch, `const _exhaustive: never = block` errors — that's the guard working.)

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/chat/PresentationBlock.tsx apps/mobile/src/chat/ThreadView.tsx
git commit -m "feat(mobile/chat): render 6 read-tool cards; mark them full-width"
```

---

## Phase 10: Full-suite verification

### Task 10: Run the api test suite and mobile typecheck

- [ ] **Step 1: API tests**

Run: `pnpm --filter @fina/api test`
Expected: PASS (all existing + new tool tests).

- [ ] **Step 2: Mobile typecheck**

Run: `pnpm --filter @fina/mobile exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Shared build**

Run: `pnpm --filter @fina/shared build`
Expected: PASS.

- [ ] **Step 4: Manual scenarios (dev client / Expo Go)**

Walk the 10 scenarios from the spec's "Manual scenarios" table. Confirm each card renders, the Dismiss and Add interactions consume their intents, and no "Unsupported message type" pill appears.

---

## Self-Review notes (filled by plan author)

- **Spec coverage:** all 6 blocks (Tasks 1b/2/3a-b/4/5/6), intent pre-creation (3b, 4), sweeper (7), prompt reconciliation (8), mobile render + exhaustiveness (9a-d), tests per slice, manual scenarios (10). ✓
- **Type consistency:** block field names match the shared union from Task 0 (`bar_pct`, `add_form_intent`, `dismiss_intent`, `scheduled_date`, `total_balance`). Mobile `Extract<PresentationBlock, {type}>` derives row types directly, so drift TS-errors. ✓
- **Known verify-at-implementation points (flagged inline, not placeholders):** `dismissScheduledSpend` arg name (`schedule_id`); cron scheduler registration shape; `RecurringFormBlock` prop signature. Each step says to open the file and match — these are real, small confirmations, not missing code.
