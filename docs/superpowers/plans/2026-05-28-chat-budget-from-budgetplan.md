# Chat budget tools from BudgetPlan — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repoint the chat `getBudget` and `compareSpendingVsBudget` tools at `BudgetPlan` (the real budget source used by Home and `/budget`), add a headline to the `budget_list` card, and make that card tap through to the `/budget` screen.

**Architecture:** A single `budgetPlanSnapshot(workspaceId, year, month)` helper in `budget-plans/service.ts` merges the plan total + per-category caps + actual spend + scheduled (all already-existing functions). `getBudget` renders a `budget_list` card with a total headline + top capped-category rows; `compareSpendingVsBudget` reuses its existing `recap` card but sourced from the snapshot. The legacy per-category `Budget` reads (`compareSpendingVsBudgetService`, `spentByCategoryForPeriod`) are removed.

**Tech Stack:** TypeScript, Fastify + Prisma, Vitest (real-DB tests), Expo/React Native, `@fina/shared`.

**Spec:** `docs/superpowers/specs/2026-05-28-chat-budget-from-budgetplan-design.md`. Continues branch `feat/chat-read-tool-cards`; **supersedes** its Task 1a/1b.

**Test command:** `pnpm exec nx test api -- <pattern>`. Mobile typecheck: `pnpm exec nx typecheck mobile` (bare `tsc --noEmit` is a no-op).

---

## File Structure
- Modify `libs/shared/src/dto/chat.ts` — add `headline?` to `budget_list`.
- Modify `apps/api/src/budget-plans/service.ts` — add `budgetPlanSnapshot` + `periodToYearMonth`.
- Modify `apps/api/src/chat/tools/get-budget.ts` — rewrite onto snapshot.
- Modify `apps/api/src/chat/tools/compare-spending-vs-budget.ts` — rewrite onto snapshot (reuse existing `toRecapBlock`).
- Modify `apps/api/src/budgets/service.ts` — remove `spentByCategoryForPeriod` (and `compareSpendingVsBudgetService` if unused).
- Delete `apps/api/tests/budgets.service.spent-helper.test.ts`.
- Rewrite `apps/api/tests/chat.tools.get-budget.test.ts`, `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`; add `apps/api/tests/budget-plans.snapshot.test.ts`.
- Modify `apps/mobile/src/chat/blocks/BudgetListBlock.tsx` — headline + tap-to-`/budget`.

---

## Task A: shared `budget_list.headline`

**Files:** Modify `libs/shared/src/dto/chat.ts`

- [ ] **Step 1: Add the optional headline.** In the `budget_list` union member, add a `headline?` field after `currency?` and before `rows`:

```ts
      currency?: string;
      /** Optional total-cap headline (BudgetPlan): the user's monthly cap,
       *  spend so far, and remaining. Renderer shows a hero number + bar. */
      headline?: {
        cap: string;
        spent: string;
        left: string;
        bar_pct: number;
        scheduled?: string;
      };
      rows: Array<{
```

- [ ] **Step 2: Typecheck shared.** Run: `cd libs/shared && npx tsc --noEmit`. Expected: clean (exit 0).

- [ ] **Step 3: Commit.**
```bash
git add libs/shared/src/dto/chat.ts
git commit -m "feat(shared): budget_list optional headline (total cap)"
```

---

## Task B: `budgetPlanSnapshot` + `periodToYearMonth`

**Files:** Modify `apps/api/src/budget-plans/service.ts`; Test `apps/api/tests/budget-plans.snapshot.test.ts`

- [ ] **Step 1: Write the failing test.** Create `apps/api/tests/budget-plans.snapshot.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { budgetPlanSnapshot, periodToYearMonth } from "../src/budget-plans/service.js";

describe("budgetPlanSnapshot", () => {
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `bps-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "BPS" } });
    const ws = await prisma.workspace.create({ data: { name: "bps-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining", color: "#cc33aa", icon: "🍽️" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns null when no plan exists", async () => {
    expect(await budgetPlanSnapshot(wsId, 2026, 5)).toBeNull();
  });

  it("merges plan total + per-category cap + spend", async () => {
    await prisma.budgetPlan.create({
      data: {
        workspaceId: wsId,
        periodStart: new Date("2026-05-01T12:00:00.000Z"),
        totalAmount: "9000.00",
        categoryAllocations: [{ categoryId: dining, amount: 577 }],
      },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "541.33", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "541.33" } });

    const snap = await budgetPlanSnapshot(wsId, 2026, 5);
    expect(snap).not.toBeNull();
    expect(snap!.totalAmount).toBe("9000.00");
    expect(snap!.totalSpent).toBe("541.33");
    const d = snap!.categories.find((c) => c.categoryId === dining)!;
    expect(d.allocated).toBe("577.00");
    expect(d.spent).toBe("541.33");
    expect(d.color).toBe("#cc33aa");
  });

  it("periodToYearMonth maps relative to UTC now", () => {
    expect(periodToYearMonth("this_month")).toEqual({ year: 2026, month: 5 });
    expect(periodToYearMonth("last_month")).toEqual({ year: 2026, month: 4 });
    expect(periodToYearMonth("next_month")).toEqual({ year: 2026, month: 6 });
  });
});
```

- [ ] **Step 2: Run it — fails (not exported).** Run: `pnpm exec nx test api -- budget-plans.snapshot`. Expected: FAIL.

- [ ] **Step 3: Implement.** In `apps/api/src/budget-plans/service.ts`, add (after the existing exports; it already has `getOrSnapshotMonthBudget`, `monthlySpendByCategory`, `monthlyScheduledByCategory`, `monthlyTotalSpend`, `monthlyScheduledTotal`, `firstOfMonth`, `prisma`, `Prisma`):

```ts
export type BudgetSnapshotCategory = {
  categoryId: string;
  categoryName: string;
  color: string | null;
  icon: string | null;
  /** Cap from the plan's categoryAllocations; null when no cap is set. */
  allocated: string | null;
  spent: string;
  scheduled: string;
};

export type BudgetSnapshot = {
  totalAmount: string;
  totalSpent: string;
  totalScheduled: string;
  categories: BudgetSnapshotCategory[];
};

/** Single source for the chat budget tools — the same BudgetPlan data the
 *  Home/`/budget` screens use. Returns null when the workspace has no plan
 *  (no month snapshot and no default template). */
export async function budgetPlanSnapshot(
  workspaceId: string,
  year: number,
  month1to12: number,
): Promise<BudgetSnapshot | null> {
  const plan = await getOrSnapshotMonthBudget(workspaceId, year, month1to12);
  if (!plan) return null;

  const [spendByCat, scheduledByCat, totalSpent, totalScheduled] = await Promise.all([
    monthlySpendByCategory(workspaceId, year, month1to12),
    monthlyScheduledByCategory(workspaceId, year, month1to12),
    monthlyTotalSpend(workspaceId, year, month1to12),
    monthlyScheduledTotal(workspaceId, year, month1to12),
  ]);

  const allocById = new Map(plan.categoryAllocations.map((a) => [a.categoryId, a.amount]));
  const spentById = new Map(spendByCat.map((c) => [c.categoryId, c.spent]));
  const scheduledById = new Map(scheduledByCat.map((c) => [c.categoryId, c.spent]));
  const nameById = new Map<string, string>();
  for (const c of spendByCat) nameById.set(c.categoryId, c.categoryName);
  for (const c of scheduledByCat) nameById.set(c.categoryId, c.categoryName);

  const ids = Array.from(new Set<string>([...allocById.keys(), ...spentById.keys(), ...scheduledById.keys()]));
  const cats = ids.length
    ? await prisma.category.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, name: true, color: true, icon: true },
      })
    : [];
  const meta = new Map(cats.map((c) => [c.id, c]));

  const categories: BudgetSnapshotCategory[] = ids.map((id) => ({
    categoryId: id,
    categoryName: meta.get(id)?.name ?? nameById.get(id) ?? "Unknown",
    color: meta.get(id)?.color ?? null,
    icon: meta.get(id)?.icon ?? null,
    allocated: allocById.has(id) ? allocById.get(id)!.toFixed(2) : null,
    spent: (spentById.get(id) ?? 0).toFixed(2),
    scheduled: (scheduledById.get(id) ?? 0).toFixed(2),
  }));

  return {
    totalAmount: plan.totalAmount,
    totalSpent: totalSpent.toFixed(2),
    totalScheduled: totalScheduled.toFixed(2),
    categories,
  };
}

export type ChatBudgetPeriod = "this_month" | "last_month" | "next_month";

/** Map the chat period enum to a calendar year/month on the same UTC basis
 *  budget-plans/current uses, so chat and Home agree on which month. */
export function periodToYearMonth(period: ChatBudgetPeriod): { year: number; month: number } {
  const d = new Date();
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1; // 1..12
  if (period === "last_month") {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  } else if (period === "next_month") {
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return { year, month };
}
```

- [ ] **Step 4: Run the test — passes.** Run: `pnpm exec nx test api -- budget-plans.snapshot`. Expected: 3 pass.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/budget-plans/service.ts apps/api/tests/budget-plans.snapshot.test.ts
git commit -m "feat(budget-plans): budgetPlanSnapshot + periodToYearMonth"
```

---

## Task C: rewrite `getBudget` onto the snapshot

**Files:** Modify `apps/api/src/chat/tools/get-budget.ts`; rewrite `apps/api/tests/chat.tools.get-budget.test.ts`

- [ ] **Step 1: Replace the test file.** Overwrite `apps/api/tests/chat.tools.get-budget.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { getBudget } from "../src/chat/tools/get-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getBudget chat tool (BudgetPlan)", () => {
  let ctx: ToolContext;
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `gb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "gb-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining", color: "#cc33aa", icon: "🍽️" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns no block when there is no plan", async () => {
    const r = await getBudget.run(ctx, {});
    expect(r.block).toBeUndefined();
    expect(r.plan).toBeNull();
  });

  it("returns a budget_list with headline + capped rows", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "620.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "620.00" } });

    const r = await getBudget.run(ctx, {});
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.headline?.cap).toBe("9000.00");
    expect(r.block.headline?.spent).toBe("620.00");
    expect(r.block.headline?.left).toBe("8380.00");
    const row = r.block.rows[0]!;
    expect(row.amount).toBe("500.00");
    expect(row.spent).toBe("620.00");
    expect(row.over).toBe(true);
  });

  it("total-only plan → headline, no rows", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [] },
    });
    const r = await getBudget.run(ctx, {});
    if (r.block?.type !== "budget_list") throw new Error("wrong block");
    expect(r.block.headline?.cap).toBe("9000.00");
    expect(r.block.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — fails.** Run: `pnpm exec nx test api -- chat.tools.get-budget`. Expected: FAIL (old impl returns `budgets`, not `plan`/headline).

- [ ] **Step 3: Rewrite the tool.** Replace `apps/api/src/chat/tools/get-budget.ts` entirely:

```ts
import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import {
  budgetPlanSnapshot,
  periodToYearMonth,
  type BudgetSnapshotCategory,
} from "../../budget-plans/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});
type Args = z.infer<typeof Args>;

/** Max category rows in the card; the rest live on the /budget screen. */
const MAX_ROWS = 5;

type PlanSummary = {
  totalAmount: string;
  totalSpent: string;
  totalScheduled: string;
  categories: BudgetSnapshotCategory[];
};

export const getBudget: ToolDef<
  Args,
  { plan: PlanSummary | null; block?: PresentationBlock }
> = {
  name: "getBudget",
  description:
    "Show the user's monthly budget — total cap, spend so far, and per-category caps with progress. Sources the real BudgetPlan (same as the Budget screen). period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    if (args.category_id && args.category_name) throw new Error("invalid_body");
    const period = args.period ?? "this_month";
    const { year, month } = periodToYearMonth(period);

    const [snap, workspace] = await Promise.all([
      budgetPlanSnapshot(ctx.workspaceId, year, month),
      prisma.workspace.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { currency: true } }),
    ]);

    if (!snap || parseFloat(snap.totalAmount) <= 0) return { plan: null };

    // Optional single-category filter (by id or name).
    let filterId: string | undefined = args.category_id;
    if (!filterId && args.category_name) {
      const cat = await prisma.category.findFirst({
        where: { workspaceId: ctx.workspaceId, archivedAt: null, name: { equals: args.category_name, mode: "insensitive" } },
        select: { id: true },
      });
      filterId = cat?.id;
    }

    const capped = snap.categories.filter((c) => c.allocated !== null);
    const filtered = filterId ? capped.filter((c) => c.categoryId === filterId) : capped;
    // Over-budget / closest-to-limit first.
    const sorted = [...filtered].sort((a, b) => ratio(b) - ratio(a));
    const shown = sorted.slice(0, MAX_ROWS);

    const rows = shown.map((c) => {
      const allocated = parseFloat(c.allocated!);
      const spent = parseFloat(c.spent);
      return {
        id: c.categoryId,
        category: { name: c.categoryName, color: c.color, icon: c.icon },
        amount: c.allocated!,
        spent: c.spent,
        bar_pct: allocated > 0 ? Number(((spent / allocated) * 100).toFixed(2)) : 0,
        over: spent > allocated,
      };
    });

    const cap = parseFloat(snap.totalAmount);
    const spentTotal = parseFloat(snap.totalSpent);
    const headline = {
      cap: snap.totalAmount,
      spent: snap.totalSpent,
      left: (cap - spentTotal).toFixed(2),
      bar_pct: cap > 0 ? Number(((spentTotal / cap) * 100).toFixed(2)) : 0,
      ...(parseFloat(snap.totalScheduled) > 0 ? { scheduled: snap.totalScheduled } : {}),
    };

    const uncapped = snap.categories.length - capped.length;
    const footerParts: string[] = [];
    if (sorted.length > shown.length) footerParts.push(`+${sorted.length - shown.length} more capped`);
    if (uncapped > 0) footerParts.push(`${uncapped} uncapped`);
    footerParts.push("tap to open full budget");
    const footer = footerParts.join(" · ");

    const periodLabel = period === "this_month" ? "This month" : period === "last_month" ? "Last month" : "Next month";
    const block: PresentationBlock = {
      type: "budget_list",
      title: "Budget",
      period_label: periodLabel,
      currency: workspace.currency,
      headline,
      rows,
      footer,
    };
    return { plan: snap, block };
  },
};

function ratio(c: BudgetSnapshotCategory): number {
  const a = parseFloat(c.allocated ?? "0");
  return a > 0 ? parseFloat(c.spent) / a : 0;
}
```

- [ ] **Step 4: Run — passes.** Run: `pnpm exec nx test api -- chat.tools.get-budget`. Expected: 3 pass.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/chat/tools/get-budget.ts apps/api/tests/chat.tools.get-budget.test.ts
git commit -m "feat(chat): getBudget reads BudgetPlan, budget_list with headline"
```

---

## Task D: rewrite `compareSpendingVsBudget` onto the snapshot

**Files:** Modify `apps/api/src/chat/tools/compare-spending-vs-budget.ts`; rewrite `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`

The tool keeps its existing `Item` shape + `toRecapBlock` (so the `recap` card renders identically) but builds `items` from `budgetPlanSnapshot` instead of `compareSpendingVsBudgetService`. **Keep `spentPct`/`plannedPct`/`todayPct` as PERCENT (0..100), matching the previous service output, so `toRecapBlock` behaves exactly as before** (its `bar_pct: Math.min(100, Math.round(i.spentPct * 100))` is pre-existing behavior — do not change it).

- [ ] **Step 1: Rewrite the test.** Overwrite `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { compareSpendingVsBudget } from "../src/chat/tools/compare-spending-vs-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("compareSpendingVsBudget chat tool (BudgetPlan)", () => {
  let ctx: ToolContext;
  let wsId: string;
  let dining: string;
  let acct: string;

  beforeEach(async () => {
    const stamp = `cvb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "CVB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "cvb-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    acct = (await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chq", type: "depository", currency: "CAD" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("builds items + recap from the BudgetPlan, per capped category", async () => {
    await prisma.budgetPlan.create({
      data: { workspaceId: wsId, periodStart: new Date("2026-05-01T12:00:00.000Z"), totalAmount: "9000.00", categoryAllocations: [{ categoryId: dining, amount: 500 }] },
    });
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct, amount: "200.00", merchantRaw: "Resto", occurredAt: new Date("2026-05-10T12:00:00Z"), source: "manual", pending: false, rawData: {} },
    });
    await prisma.transactionAllocation.create({ data: { transactionId: tx.id, categoryId: dining, amount: "200.00" } });

    const r = await compareSpendingVsBudget.run(ctx, {});
    expect(r.block.type).toBe("recap");
    const item = r.items.find((i) => i.categoryName === "Dining")!;
    expect(item.amount).toBe("500.00");
    expect(item.spent).toBe("200.00");
    expect(item.remaining).toBe("300.00");
  });

  it("no plan → empty items + recap footer", async () => {
    const r = await compareSpendingVsBudget.run(ctx, {});
    expect(r.items).toHaveLength(0);
    expect(r.block.type).toBe("recap");
  });
});
```

- [ ] **Step 2: Run — fails.** Run: `pnpm exec nx test api -- chat.tools.compare-spending-vs-budget`. Expected: FAIL.

- [ ] **Step 3: Rewrite the tool's `run` to source items from the snapshot.** In `apps/api/src/chat/tools/compare-spending-vs-budget.ts`, replace the imports + `run` (KEEP the existing `Item` type, `Result` type, and the entire `toRecapBlock` function unchanged):

```ts
import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { budgetPlanSnapshot, periodToYearMonth } from "../../budget-plans/service.js";
import type { ToolDef } from "./types.js";
```

```ts
export const compareSpendingVsBudget: ToolDef<Args, Result> = {
  name: "compareSpendingVsBudget",
  description:
    "Compare actual spending against the budget for the period — per capped category, with remaining and pace. Sources the real BudgetPlan. period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    const period = args.period ?? "this_month";
    const { year, month } = periodToYearMonth(period);
    const snap = await budgetPlanSnapshot(ctx.workspaceId, year, month);

    const todayPct = todayPctFor(period, year, month);
    const items: Item[] = (snap?.categories ?? [])
      .filter((c) => c.allocated !== null)
      .map((c) => {
        const amount = parseFloat(c.allocated!);
        const spent = parseFloat(c.spent);
        const planned = parseFloat(c.scheduled);
        const remaining = amount - spent - planned;
        const spentPct = amount > 0 ? Number(((spent / amount) * 100).toFixed(2)) : 0;
        const plannedPct = amount > 0 ? Number(((planned / amount) * 100).toFixed(2)) : 0;
        const status: "on-pace" | "over-pace" = spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
        return {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          amount: c.allocated!,
          spent: c.spent,
          planned: c.scheduled,
          remaining: remaining.toFixed(2),
          spentPct,
          plannedPct,
          todayPct,
          status,
        };
      });

    const start = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    return { period: { start, end }, items, block: toRecapBlock(period, items) };
  },
};

/** Local-day-of-month / days-in-month, as a percent. last_month=100, next_month=0. */
function todayPctFor(period: Period, year: number, month: number): number {
  if (period === "last_month") return 100;
  if (period === "next_month") return 0;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = new Date().getUTCDate();
  return Math.round((day / dim) * 10000) / 100;
}
```

Note: `Period` is the existing `type Period = NonNullable<Args["period"]>` already declared in the file — keep it. Remove the now-unused `compareSpendingVsBudgetService` import.

- [ ] **Step 4: Run — passes.** Run: `pnpm exec nx test api -- chat.tools.compare-spending-vs-budget`. Expected: 2 pass.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/chat/tools/compare-spending-vs-budget.ts apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts
git commit -m "feat(chat): compareSpendingVsBudget reads BudgetPlan"
```

---

## Task E: remove dead legacy-budget code

**Files:** Modify `apps/api/src/budgets/service.ts`; delete `apps/api/tests/budgets.service.spent-helper.test.ts`

- [ ] **Step 1: Confirm no remaining consumers.** Run:
```bash
grep -rn "spentByCategoryForPeriod\|compareSpendingVsBudgetService" apps/api/src apps/api/tests
```
Expected: only `apps/api/src/budgets/service.ts` (the definitions) — no callers in `src` (the two tools no longer import them). If any other caller exists, STOP and report it.

- [ ] **Step 2: Remove the dead exports.** In `apps/api/src/budgets/service.ts`, delete the `spentByCategoryForPeriod` function and the `compareSpendingVsBudgetService` function (and `CompareSpendingInput`/`CompareSpendingOutput` types + the `daysInMonth` helper if they become unused — verify each is unused with grep before deleting). Leave `getBudgetService`, `setBudgetService`, `deleteBudgetService` intact (other code may use them).

- [ ] **Step 3: Delete the orphaned test.** Run: `git rm apps/api/tests/budgets.service.spent-helper.test.ts`.

- [ ] **Step 4: Verify build + budgets tests.** Run: `npx tsc --noEmit -p apps/api/tsconfig.json 2>&1 | grep "budgets/service\|compare-spending\|get-budget"` (expect no output for these files) and `pnpm exec nx test api -- budgets.service chat.tools.get-budget chat.tools.compare-spending-vs-budget budget-plans.snapshot`. Expected: all pass (the old `budgets.service.spent-helper` file is gone; any remaining `budgets.service.test.ts` still passes).

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/budgets/service.ts apps/api/tests/budgets.service.spent-helper.test.ts
git commit -m "refactor(budgets): drop legacy spentByCategoryForPeriod + compareSpendingVsBudgetService (chat now uses BudgetPlan)"
```

---

## Task F: mobile — BudgetListBlock headline + tap-to-`/budget`

**Files:** Modify `apps/mobile/src/chat/blocks/BudgetListBlock.tsx`

- [ ] **Step 1: Read the reference.** Read `apps/mobile/src/home/SpendCard.tsx` for the headline visual (hero spent number, "of {cap}", percent, progress bar, "{left} left") and confirm it navigates via `router.push("/budget")`. Read the current `BudgetListBlock.tsx`.

- [ ] **Step 2: Add the headline + make the card tappable.** Update `apps/mobile/src/chat/blocks/BudgetListBlock.tsx`:
  - Add `import { Pressable } from "react-native";` and `import { router } from "expo-router";`.
  - Wrap the existing `<BlockCard>...</BlockCard>` content in a `<Pressable onPress={() => router.push("/budget" as never)}>`.
  - When `block.headline` is present, render a headline section ABOVE the rows:

```tsx
{block.headline ? (
  <View style={styles.headline}>
    <Text style={styles.heroAmount}>
      {sym}{block.headline.spent}
    </Text>
    <Text style={styles.heroCap}>of {sym}{block.headline.cap}</Text>
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, block.headline.bar_pct))}%`, backgroundColor: colors.primary }]} />
    </View>
    <View style={styles.heroMetaRow}>
      <Text style={styles.heroPct}>{Math.round(block.headline.bar_pct)}%</Text>
      <Text style={styles.heroLeft}>{sym}{block.headline.left} left</Text>
    </View>
    {block.headline.scheduled ? (
      <Text style={styles.heroScheduled}>+ {sym}{block.headline.scheduled} scheduled</Text>
    ) : null}
  </View>
) : null}
```

  - Add these styles to the `StyleSheet.create`:

```ts
  headline: { gap: 4, paddingBottom: space.xs },
  heroAmount: { fontSize: 28, lineHeight: 34, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  heroCap: { ...type$.bodySm, color: colors.muted },
  heroMetaRow: { flexDirection: "row", justifyContent: "space-between" },
  heroPct: { ...type$.caption, color: colors.muted },
  heroLeft: { ...type$.captionStrong ?? type$.caption, color: colors.primary, fontWeight: "600" },
  heroScheduled: { ...type$.caption, color: colors.muted },
```

  (If `type$.captionStrong` does not exist, use `type$.caption` — check `tokens.ts`. Reuse the existing `track`/`fill` styles already in this file for the bar; if they aren't present, add `track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" }` and `fill: { height: "100%" }`.)

- [ ] **Step 3: Typecheck.** Run: `pnpm exec nx typecheck mobile`. Confirm `BudgetListBlock.tsx` has no errors (only the pre-existing `restore.tsx` / `iap/client.ts` errors remain).

- [ ] **Step 4: Commit.**
```bash
git add apps/mobile/src/chat/blocks/BudgetListBlock.tsx
git commit -m "feat(mobile/chat): budget card headline + tap to /budget"
```

---

## Task G: verification + final review

- [ ] **Step 1: API tests (touched).** Run:
```bash
pnpm exec nx test api -- budget-plans.snapshot chat.tools.get-budget chat.tools.compare-spending-vs-budget budgets.service
```
Expected: all pass.

- [ ] **Step 2: Shared + mobile typecheck.** Run: `cd libs/shared && npx tsc --noEmit` (clean) and `pnpm exec nx typecheck mobile` (only restore.tsx + iap/client.ts errors).

- [ ] **Step 3: Manual.** In the app: "show me my budget" → headline card matching Home ($X of $Y · $Z left · %); tap → `/budget` screen. "am I over budget?" → recap card from the plan.

- [ ] **Step 4: Final whole-branch review** (dispatch a reviewer over the full branch diff vs `main`).

---

## Self-Review notes
- **Spec coverage:** budgetPlanSnapshot (Task B), getBudget→headline+rows+tap (C, F), compareSpendingVsBudget→recap (D), shared headline (A), remove legacy helpers (E), period→UTC year/month (B), total-only handling (C/D tests), tests + verification (B–G). ✓
- **Type consistency:** `BudgetSnapshot`/`BudgetSnapshotCategory`/`ChatBudgetPeriod`/`periodToYearMonth` defined in Task B and consumed verbatim in C/D. getBudget result type changes to `{ plan; block? }` (LLM-facing, JSON — safe). compareSpendingVsBudget keeps its `Item`/`Result`/`toRecapBlock` (units: spentPct as percent, bug-for-bug with existing renderer). ✓
- **Removal ordering:** E runs after C and D stop importing the legacy functions. ✓
