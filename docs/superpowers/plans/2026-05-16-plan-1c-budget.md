# Plan 1C-budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship monthly per-category budgets — new `Budget` model + 3 chat tools (`setBudget`, `getBudget`, `compareSpendingVsBudget`) + 3 HTTP routes (`POST/GET/DELETE /workspaces/:id/budgets`).

**Architecture:** Prisma `Budget` model (workspaceId, categoryId, amount, periodStart Date), unique by (ws, cat, periodStart). Period→Date helper `firstOfMonthDateInTz` exported from `periods.ts`. A shared service module (`apps/api/src/budgets/service.ts`) is consumed by both the chat tools and the HTTP routes (DRY). System prompt's existing write-tool confirmation sentence is extended to include `setBudget`.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork).

**Spec:** [`docs/superpowers/specs/2026-05-16-plan-1c-budget-design.md`](../specs/2026-05-16-plan-1c-budget-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `Budget` model + relations on `Workspace`/`Category` |
| `apps/api/prisma/migrations/<ts>_add_budgets/migration.sql` | DDL: table + indexes |
| `apps/api/src/chat/tools/periods.ts` | Add exported `firstOfMonthDateInTz(userId, monthsOffset)` |
| `apps/api/src/budgets/service.ts` | `setBudgetService`, `getBudgetService`, `deleteBudgetService`, `compareSpendingVsBudgetService` |
| `apps/api/src/chat/tools/set-budget.ts` | `setBudget` chat tool |
| `apps/api/src/chat/tools/get-budget.ts` | `getBudget` chat tool |
| `apps/api/src/chat/tools/compare-spending-vs-budget.ts` | `compareSpendingVsBudget` chat tool |
| `apps/api/src/chat/tools/index.ts` | Register 3 new tools (count 14 → 17) |
| `apps/api/src/chat/turn.ts` | Extend SYSTEM_PROMPT confirmation sentence to include `setBudget` |
| `apps/api/src/routes/budgets.ts` | `POST`/`GET`/`DELETE` handlers |
| `apps/api/src/server.ts` | Register `budgetsRoutes` |
| `apps/api/tests/chat.tools.periods.first-of-month-in-tz.test.ts` | Unit test for new helper |
| `apps/api/tests/budgets.service.test.ts` | Service unit/integration tests |
| `apps/api/tests/budgets.routes.test.ts` | HTTP route tests |
| `apps/api/tests/chat.tools.set-budget.test.ts` | Chat tool tests |
| `apps/api/tests/chat.tools.get-budget.test.ts` | Chat tool tests |
| `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts` | Chat tool tests |
| `apps/api/tests/chat.tools.registry.test.ts` | Bump 14 → 17 |

---

## Pre-flight Sanity Check

From the worktree root:

```bash
docker ps --filter name=fina-postgres-dev --format "{{.Names}}: {{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Test suite: `64 passed / 529 passed`.

If the suite is not at baseline, stop and report — do NOT start implementation on a broken baseline.

---

## Task 1: Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_budgets/migration.sql`

### 1.1 Add the Prisma model

- [ ] **Step 1: Add `Budget` model + inverse relations in `apps/api/prisma/schema.prisma`**

Append the `Budget` model (place after `Category` for readability):

```prisma
model Budget {
  id           String   @id @default(cuid())
  workspaceId  String
  categoryId   String
  amount       Decimal  @db.Decimal(10, 2)
  periodStart  DateTime @db.Date
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  workspace    Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category     Category  @relation(fields: [categoryId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, categoryId, periodStart])
  @@index([workspaceId, periodStart])
  @@map("budgets")
}
```

Add inverse relations:
- In `model Workspace { ... }`, add: `budgets Budget[]`
- In `model Category { ... }`, add: `budgets Budget[]`

### 1.2 Generate migration

- [ ] **Step 2: Generate the migration**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_budgets
```

Inspect the generated `migration.sql` — it should be a `CREATE TABLE "budgets"` + 2 indexes + 2 foreign keys, nothing else. Read the whole file before proceeding.

- [ ] **Step 3: Apply migration on both DBs + regenerate client**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
```

**Expected:** Both `db:deploy` report applying `add_budgets`; `prisma generate` reports success.

- [ ] **Step 4: Confirm baseline still passes**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** still 64 files / 529 tests PASS. Schema change without any consumer should be invisible to the test suite.

### 1.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-budget): Budget model + migration"
```

---

## Task 2: `firstOfMonthDateInTz` exported helper (TDD)

**Files:**
- Modify: `apps/api/src/chat/tools/periods.ts`
- Create: `apps/api/tests/chat.tools.periods.first-of-month-in-tz.test.ts`

### 2.1 Write the failing test

- [ ] **Step 1: Create the test file**

```typescript
// apps/api/tests/chat.tools.periods.first-of-month-in-tz.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { firstOfMonthDateInTz } from "../src/chat/tools/periods.js";

describe("firstOfMonthDateInTz", () => {
  let userId: string;

  beforeEach(async () => {
    const stamp = `fom-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "FOM", tz: "America/Toronto" },
    });
    userId = stamp;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns May 1 for a Toronto user mid-May with offset 0", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 0);
    expect(d.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("returns April 1 for offset -1", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, -1);
    expect(d.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("returns June 1 for offset +1", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 1);
    expect(d.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("rolls year on December → next-month offset", async () => {
    vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 1);
    expect(d.toISOString()).toBe("2027-01-01T12:00:00.000Z");
  });

  it("rolls year on January → previous-month offset", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, -1);
    expect(d.toISOString()).toBe("2025-12-01T12:00:00.000Z");
  });

  it("uses user-local month boundary (Toronto vs UTC)", async () => {
    // 2026-05-01T03:00:00Z = Apr 30 23:00 local Toronto → user's month is April.
    vi.setSystemTime(new Date("2026-05-01T03:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 0);
    expect(d.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (export missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.periods.first-of-month-in-tz.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** error citing missing export `firstOfMonthDateInTz` from `periods.js`.

### 2.2 Implement

- [ ] **Step 3: Add two exports to `apps/api/src/chat/tools/periods.ts`**

Currently the file has private `partsInTz` and exported helpers `resolveUserTz`, `basicPeriodRange`, `comparisonRanges`, `lookbackMonthStart`, `dateKeyInTz`.

First, promote `partsInTz` from private to exported (just add the `export` keyword to its declaration around line 35):

```typescript
// Was:
//   function partsInTz(instant: Date, tz: string): Parts { ... }
// Becomes:
export function partsInTz(instant: Date, tz: string): Parts { ... }
```

Then add `firstOfMonthDateInTz` at the bottom (after `comparisonRanges`):

```typescript
// Public: first day of the calendar month at `monthsOffset` from the user's
// "now" (interpreted in their tz). Returns Date at 12:00:00.000Z on the
// first-of-month so the @db.Date column receives the right calendar date
// across UTC-11..+11 zones (matches 1E-time's UTC-noon storage policy).
export async function firstOfMonthDateInTz(
  userId: string,
  monthsOffset: number,
  now: Date = new Date(),
): Promise<Date> {
  const tz = await resolveUserTz(userId);
  const p = partsInTz(now, tz);
  let y = p.year;
  let m = p.month + monthsOffset;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  const mm = String(m).padStart(2, "0");
  return new Date(`${y}-${mm}-01T12:00:00.000Z`);
}
```

Also export the `Parts` type used by `partsInTz` (add the `export` keyword to its `type Parts = { ... }` declaration). Downstream consumers can then write `import { partsInTz, type Parts } from "./periods.js"`.

- [ ] **Step 4: Run — expect PASS (6/6)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.periods.first-of-month-in-tz.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  6 passed (6)`.

- [ ] **Step 5: Run all period tests — confirm no regression**

```bash
pnpm --filter @fina/api exec vitest run "tests/chat.tools.periods" --reporter=basic 2>&1 | tail -10
```

**Expected:** all `chat.tools.periods*` files pass.

### 2.3 Commit

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/chat/tools/periods.ts apps/api/tests/chat.tools.periods.first-of-month-in-tz.test.ts
git commit -m "feat(plan 1c-budget): firstOfMonthDateInTz helper in periods.ts"
```

---

## Task 3: `setBudgetService` (TDD)

**Files:**
- Create: `apps/api/src/budgets/service.ts`
- Create: `apps/api/tests/budgets.service.test.ts`

### 3.1 Write the failing tests

- [ ] **Step 1: Create the service test file with set-only cases**

```typescript
// apps/api/tests/budgets.service.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudgetService } from "../src/budgets/service.js";

describe("setBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryId: string;

  beforeEach(async () => {
    const stamp = `bs-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BS", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bs-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    const cat = await prisma.category.create({ data: { workspaceId, name: "Coffee" } });
    categoryId = cat.id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a new budget for this_month at Toronto May 1", async () => {
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 500, period: "this_month" },
    );
    expect(r.budget.categoryId).toBe(categoryId);
    expect(r.budget.amount).toBe("500.00");
    expect(r.budget.periodStart).toBe("2026-05-01");
  });

  it("upserts on conflict: second call updates amount", async () => {
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 500, period: "this_month" });
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 600, period: "this_month" },
    );
    expect(r.budget.amount).toBe("600.00");
    const all = await prisma.budget.findMany({ where: { workspaceId } });
    expect(all).toHaveLength(1);
  });

  it("rejects amount = 0 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 0, period: "this_month" }),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount < 0 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: -1, period: "this_month" }),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount > 99999999.99 with invalid_amount", async () => {
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 100_000_000, period: "this_month" }),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects archived category with category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      setBudgetService({ workspaceId, userId }, { categoryId, amount: 500, period: "this_month" }),
    ).rejects.toThrow("category_not_found");
  });

  it("rejects cross-workspace category with category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "X" } });
    await expect(
      setBudgetService(
        { workspaceId, userId },
        { categoryId: otherCat.id, amount: 500, period: "this_month" },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("computes periodStart in Toronto tz when server is UTC", async () => {
    // Pinned 2026-05-01T03:00:00Z = Apr 30 23:00 local Toronto.
    vi.setSystemTime(new Date("2026-05-01T03:00:00Z"));
    const r = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 200, period: "this_month" },
    );
    // Toronto sees April → periodStart = 2026-04-01.
    expect(r.budget.periodStart).toBe("2026-04-01");
  });

  it("supports last_month and next_month offsets", async () => {
    const last = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 100, period: "last_month" },
    );
    expect(last.budget.periodStart).toBe("2026-04-01");
    const next = await setBudgetService(
      { workspaceId, userId },
      { categoryId, amount: 200, period: "next_month" },
    );
    expect(next.budget.periodStart).toBe("2026-06-01");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** error citing missing module `../src/budgets/service.js`.

### 3.2 Implement the service (set only for now; get/delete/compare come in later tasks)

- [ ] **Step 3: Create `apps/api/src/budgets/service.ts`**

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { firstOfMonthDateInTz } from "../chat/tools/periods.js";

export type PeriodEnum = "this_month" | "last_month" | "next_month";

const MAX_AMOUNT = 99_999_999.99;

function offsetFor(period: PeriodEnum): number {
  if (period === "last_month") return -1;
  if (period === "next_month") return 1;
  return 0;
}

export type SetBudgetInput = { categoryId: string; amount: number; period: PeriodEnum };
export type SetBudgetOutput = { budget: { id: string; categoryId: string; amount: string; periodStart: string } };

export async function setBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: SetBudgetInput,
): Promise<SetBudgetOutput> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw new Error("invalid_amount");
  }
  const periodStart = await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));

  const cat = await prisma.category.findFirst({
    where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!cat) throw new Error("category_not_found");

  const row = await prisma.budget.upsert({
    where: {
      workspaceId_categoryId_periodStart: {
        workspaceId: ctx.workspaceId,
        categoryId: input.categoryId,
        periodStart,
      },
    },
    create: {
      workspaceId: ctx.workspaceId,
      categoryId: input.categoryId,
      amount: new Prisma.Decimal(input.amount),
      periodStart,
    },
    update: { amount: new Prisma.Decimal(input.amount) },
  });

  return {
    budget: {
      id: row.id,
      categoryId: row.categoryId,
      amount: row.amount.toFixed(2),
      periodStart: row.periodStart.toISOString().slice(0, 10),
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS (9/9)**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  9 passed (9)`.

### 3.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budgets/service.ts apps/api/tests/budgets.service.test.ts
git commit -m "feat(plan 1c-budget): setBudgetService"
```

---

## Task 4: `getBudgetService` + `deleteBudgetService` (TDD)

**Files:**
- Modify: `apps/api/src/budgets/service.ts` (append)
- Modify: `apps/api/tests/budgets.service.test.ts` (append cases)

### 4.1 Append failing tests

- [ ] **Step 1: Append to `apps/api/tests/budgets.service.test.ts`** (after the existing `describe("setBudgetService")` block):

```typescript
import { getBudgetService, deleteBudgetService } from "../src/budgets/service.js";

describe("getBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryAId: string;
  let categoryBId: string;

  beforeEach(async () => {
    const stamp = `bg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BG", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bg-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryAId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    categoryBId = (await prisma.category.create({ data: { workspaceId, name: "Food" } })).id;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId: categoryAId, amount: 100, period: "this_month" });
    await setBudgetService({ workspaceId, userId }, { categoryId: categoryBId, amount: 200, period: "this_month" });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns single budget when categoryId provided", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { categoryId: categoryAId, period: "this_month" });
    expect(r.budgets).toHaveLength(1);
    expect(r.budgets[0]!.categoryId).toBe(categoryAId);
    expect(r.budgets[0]!.amount).toBe("100.00");
  });

  it("returns all budgets for period when no categoryId", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.budgets).toHaveLength(2);
    const ids = r.budgets.map((b) => b.categoryId).sort();
    expect(ids).toEqual([categoryAId, categoryBId].sort());
  });

  it("returns empty array for a month with no budgets", async () => {
    const r = await getBudgetService({ workspaceId, userId }, { period: "last_month" });
    expect(r.budgets).toEqual([]);
  });

  it("accepts an explicit periodStart Date (route variant)", async () => {
    const r = await getBudgetService(
      { workspaceId, userId },
      { periodStart: new Date("2026-05-01T12:00:00.000Z") },
    );
    expect(r.budgets).toHaveLength(2);
  });
});

describe("deleteBudgetService", () => {
  let workspaceId: string;
  let budgetId: string;

  beforeEach(async () => {
    const stamp = `bd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "BD", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "bd-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    const cat = await prisma.category.create({ data: { workspaceId, name: "X" } });
    const b = await prisma.budget.create({
      data: { workspaceId, categoryId: cat.id, amount: "10.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
    });
    budgetId = b.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  it("deletes a budget by id and returns true", async () => {
    const ok = await deleteBudgetService({ workspaceId }, { budgetId });
    expect(ok).toBe(true);
    expect(await prisma.budget.findUnique({ where: { id: budgetId } })).toBeNull();
  });

  it("returns false for cross-workspace id", async () => {
    const ok = await deleteBudgetService({ workspaceId: "other-ws" }, { budgetId });
    expect(ok).toBe(false);
    expect(await prisma.budget.findUnique({ where: { id: budgetId } })).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL on the new functions**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** "Module has no exported member `getBudgetService`" and `deleteBudgetService`.

### 4.2 Implement

- [ ] **Step 3: Append to `apps/api/src/budgets/service.ts`**

```typescript
export type GetBudgetInput =
  | { categoryId?: string; period: PeriodEnum }
  | { categoryId?: string; periodStart: Date };
export type GetBudgetOutput = { budgets: Array<{ id: string; categoryId: string; amount: string; periodStart: string }> };

export async function getBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: GetBudgetInput,
): Promise<GetBudgetOutput> {
  const periodStart =
    "periodStart" in input
      ? input.periodStart
      : await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));
  const where: { workspaceId: string; periodStart: Date; categoryId?: string } = {
    workspaceId: ctx.workspaceId,
    periodStart,
  };
  if (input.categoryId) where.categoryId = input.categoryId;
  const rows = await prisma.budget.findMany({
    where,
    orderBy: [{ categoryId: "asc" }],
    select: { id: true, categoryId: true, amount: true, periodStart: true },
  });
  return {
    budgets: rows.map((r) => ({
      id: r.id,
      categoryId: r.categoryId,
      amount: r.amount.toFixed(2),
      periodStart: r.periodStart.toISOString().slice(0, 10),
    })),
  };
}

export type DeleteBudgetInput = { budgetId: string };

export async function deleteBudgetService(
  ctx: { workspaceId: string },
  input: DeleteBudgetInput,
): Promise<boolean> {
  const { count } = await prisma.budget.deleteMany({
    where: { id: input.budgetId, workspaceId: ctx.workspaceId },
  });
  return count > 0;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  15 passed (15)` (9 from Task 3 + 6 new).

### 4.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budgets/service.ts apps/api/tests/budgets.service.test.ts
git commit -m "feat(plan 1c-budget): getBudgetService + deleteBudgetService"
```

---

## Task 5: `compareSpendingVsBudgetService` (TDD)

**Files:**
- Modify: `apps/api/src/budgets/service.ts` (append)
- Modify: `apps/api/tests/budgets.service.test.ts` (append cases)

### 5.1 Append failing tests

- [ ] **Step 1: Append to `apps/api/tests/budgets.service.test.ts`**

```typescript
import { compareSpendingVsBudgetService } from "../src/budgets/service.js";

describe("compareSpendingVsBudgetService", () => {
  let userId: string;
  let workspaceId: string;
  let categoryId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `bc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "BC", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "bc-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    acctId = (await prisma.bankAccount.create({ data: { workspaceId, name: "x", type: "depository" } })).id;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  async function seedTx(occurredAt: Date, amount: string, currency = "CAD"): Promise<void> {
    await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `tx-${Math.random()}`,
        amount,
        currency,
        merchantRaw: "M",
        categoryId,
        occurredAt,
        rawData: {},
      },
    });
  }

  it("mid-month on-pace (spent ≤ pace + 5%)", async () => {
    // May has 31 days. Pin "now" to May 15 noon UTC (= 8 AM Toronto May 15).
    // todayPct = 15/31 * 100 ≈ 48.4%.
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "30.00"); // 30% of budget

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items).toHaveLength(1);
    const it = r.items[0]!;
    expect(it.amount).toBe("100.00");
    expect(it.spent).toBe("30.00");
    expect(it.status).toBe("on-pace");
  });

  it("mid-month over-pace (spent > pace + 5%)", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "80.00"); // 80% vs ~48% pace

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items[0]!.status).toBe("over-pace");
  });

  it("last_month uses full-month baseline (todayPct = 100)", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "last_month" });
    await seedTx(new Date("2026-04-15T12:00:00Z"), "90.00");

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "last_month" });
    expect(r.items[0]!.todayPct).toBe(100);
    expect(r.items[0]!.status).toBe("on-pace"); // 90 < 100 * 1.05
  });

  it("excludes categories without a budget for the period", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const otherCat = await prisma.category.create({ data: { workspaceId, name: "Food" } });
    // Budget set only for Coffee; spending exists on Food too — Food should not appear.
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await prisma.transaction.create({
      data: {
        workspaceId, accountId: acctId, plaidTransactionId: "x",
        amount: "50.00", currency: "CAD", merchantRaw: "M",
        categoryId: otherCat.id, occurredAt: new Date("2026-05-10T12:00:00Z"), rawData: {},
      },
    });

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.categoryId).toBe(categoryId);
  });

  it("filters out USD and negative-amount (refund) transactions", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "this_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "30.00", "USD");   // wrong currency
    await seedTx(new Date("2026-05-10T12:00:00Z"), "-10.00", "CAD");  // refund
    await seedTx(new Date("2026-05-10T12:00:00Z"), "20.00", "CAD");   // counts

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "this_month" });
    expect(r.items[0]!.spent).toBe("20.00");
  });

  it("next_month returns spent=0 even when current month has spending", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    await setBudgetService({ workspaceId, userId }, { categoryId, amount: 100, period: "next_month" });
    await seedTx(new Date("2026-05-10T12:00:00Z"), "30.00"); // this-month spend

    const r = await compareSpendingVsBudgetService({ workspaceId, userId }, { period: "next_month" });
    expect(r.items[0]!.spent).toBe("0.00");
    expect(r.items[0]!.todayPct).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (export missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 5.2 Implement

- [ ] **Step 3: Append to `apps/api/src/budgets/service.ts`**

```typescript
import { basicPeriodRange, resolveUserTz, partsInTz } from "../chat/tools/periods.js";

export type CompareSpendingInput = { period: PeriodEnum };
export type CompareSpendingOutput = {
  period: { start: string; end: string };
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;
    spent: string;
    remaining: string;
    spentPct: number;
    todayPct: number;
    status: "on-pace" | "over-pace";
  }>;
};

function daysInMonth(year: number, monthOneBased: number): number {
  // monthOneBased is 1..12. Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthOneBased, 0)).getUTCDate();
}

export async function compareSpendingVsBudgetService(
  ctx: { workspaceId: string; userId: string },
  input: CompareSpendingInput,
): Promise<CompareSpendingOutput> {
  const periodStart = await firstOfMonthDateInTz(ctx.userId, offsetFor(input.period));
  // Transaction filter range:
  let gte: Date;
  let lt: Date;
  if (input.period === "this_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "this_month"));
  } else if (input.period === "last_month") {
    ({ gte, lt } = await basicPeriodRange(ctx.userId, "last_month"));
  } else {
    // next_month: explicit empty range so spent=0 regardless of current spending.
    gte = periodStart;
    lt = periodStart;
  }

  const budgets = await prisma.budget.findMany({
    where: { workspaceId: ctx.workspaceId, periodStart },
    include: { category: { select: { name: true } } },
    orderBy: [{ categoryId: "asc" }],
  });
  if (budgets.length === 0) {
    return {
      period: {
        start: periodStart.toISOString().slice(0, 10),
        end: lt.toISOString().slice(0, 10),
      },
      items: [],
    };
  }

  const budgetCategoryIds = budgets.map((b) => b.categoryId);
  const sums = await prisma.transaction.groupBy({
    by: ["categoryId"],
    where: {
      workspaceId: ctx.workspaceId,
      removedAt: null,
      occurredAt: { gte, lt },
      categoryId: { in: budgetCategoryIds },
      currency: "CAD",
      amount: { gt: 0 },
    },
    _sum: { amount: true },
  });
  const spentByCat = new Map<string, Prisma.Decimal>(
    sums.map((s) => [s.categoryId!, s._sum.amount ?? new Prisma.Decimal(0)]),
  );

  // todayPct — uses local day count in user's tz, not elapsed milliseconds.
  // For "May 15" in Toronto, that's 15/31 ≈ 48.39%, regardless of time-of-day.
  const py = periodStart.getUTCFullYear();
  const pm = periodStart.getUTCMonth() + 1; // 1..12
  const dim = daysInMonth(py, pm);
  let todayPct = 0;
  if (input.period === "this_month") {
    const tz = await resolveUserTz(ctx.userId);
    const nowParts = partsInTz(new Date(), tz);
    // nowParts.day is the user's local day-of-month (1..31).
    todayPct = Math.round((nowParts.day / dim) * 10000) / 100;
  } else if (input.period === "last_month") {
    todayPct = 100;
  }

  const items = budgets.map((b) => {
    const spent = spentByCat.get(b.categoryId) ?? new Prisma.Decimal(0);
    const remaining = b.amount.minus(spent);
    const spentPct = b.amount.greaterThan(0)
      ? Number(spent.div(b.amount).times(100).toFixed(2))
      : 0;
    const status: "on-pace" | "over-pace" = spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
    return {
      categoryId: b.categoryId,
      categoryName: b.category.name,
      amount: b.amount.toFixed(2),
      spent: spent.toFixed(2),
      remaining: remaining.toFixed(2),
      spentPct,
      todayPct,
      status,
    };
  });

  return {
    period: {
      start: periodStart.toISOString().slice(0, 10),
      end: lt.toISOString().slice(0, 10),
    },
    items,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  21 passed (21)` (15 prior + 6 new).

### 5.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/budgets/service.ts apps/api/tests/budgets.service.test.ts
git commit -m "feat(plan 1c-budget): compareSpendingVsBudgetService"
```

---

## Task 6: HTTP routes

**Files:**
- Create: `apps/api/src/routes/budgets.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/budgets.routes.test.ts`

### 6.1 Write the failing route tests

- [ ] **Step 1: Create `apps/api/tests/budgets.routes.test.ts`**

Use the pattern from `apps/api/tests/chat.routes.test.ts` for booting an in-process Fastify app. (The implementer should open that file first to copy the boilerplate exactly.) Cases:

```typescript
// Sketch — copy boilerplate (build app, sign up, set Pro trial, etc.)
// from chat.routes.test.ts. Then:

describe("POST /workspaces/:id/budgets", () => {
  it("201 with valid body", async () => {
    // sign up + Pro trial + create category + POST { categoryId, amount: 500, period: 'this_month' }
    // assert status 201 + body shape { budget: { id, categoryId, amount: '500.00', periodStart: '2026-MM-01' } }
  });

  it("400 invalid_amount on amount=0", async () => {
    // POST with amount: 0 → 400 { error: 'invalid_amount' }
  });

  it("404 category_not_found on missing category", async () => {
    // POST with a random categoryId → 404 { error: 'category_not_found' }
  });

  it("402 upgrade_required on Free tier", async () => {
    // Default user is Pro trial; expire the trial first.
    // Then POST → 402 { error: 'upgrade_required' }
  });
});

describe("GET /workspaces/:id/budgets", () => {
  it("200 viewer can read", async () => {
    // Create budget as owner; sign in as viewer (second user added as viewer);
    // GET → 200 { budgets: [...] }
  });
});

describe("DELETE /workspaces/:id/budgets/:budgetId", () => {
  it("204 deletes own", async () => {
    // POST then DELETE → 204; subsequent GET → empty.
  });

  it("404 on cross-workspace id", async () => {
    // DELETE a budgetId that belongs to another workspace → 404 budget_not_found.
  });
});
```

For each test the implementer fills in the boilerplate by mirroring the existing `chat.routes.test.ts` setup. Treat this as a single file; the assertion targets above are the contract.

- [ ] **Step 2: Run — expect FAIL (route not registered)**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 6.2 Implement the routes

- [ ] **Step 3: Create `apps/api/src/routes/budgets.ts`**

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  setBudgetService,
  getBudgetService,
  deleteBudgetService,
} from "../budgets/service.js";

const POST_PERIOD = z.enum(["this_month", "last_month", "next_month"]);
// Note: amount is NOT constrained to positive() here so the service-level
// validation (`invalid_amount`) is what surfaces for 0/negative/over-cap
// values. Otherwise Zod would short-circuit with `invalid_body` and our
// tested error contract would break.
const PostBody = z.object({
  categoryId: z.string().min(1),
  amount: z.number(),
  period: POST_PERIOD,
});

function isFirstOfMonth(s: string): boolean {
  // Shape: YYYY-MM-01, day component must literally be "01".
  if (!/^\d{4}-\d{2}-01$/.test(s)) return false;
  // Parse and round-trip to catch bogus months like "2026-13-01" or "2026-00-01".
  // new Date("2026-13-01") gives an Invalid Date; Date.UTC with month=12 (0-indexed)
  // wraps to January of next year — round-trip check rejects both cases.
  const [yStr, mStr] = s.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return false;
  if (m < 1 || m > 12) return false;
  const d = new Date(Date.UTC(y, m - 1, 1));
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip: the parsed date's YYYY-MM-01 string must equal the input.
  const back = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return back === s;
}

export async function budgetsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/budgets", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const result = await setBudgetService(
        { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
        parsed.data,
      );
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "invalid_amount") return reply.code(400).send({ error: "invalid_amount" });
      if (msg === "category_not_found") return reply.code(404).send({ error: "category_not_found" });
      throw e;
    }
  });

  app.get("/workspaces/:id/budgets", async (req, reply) => {
    const params = req.params as { id: string };
    const q = req.query as { period_start?: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      let result;
      if (q.period_start) {
        if (!isFirstOfMonth(q.period_start)) {
          return reply.code(400).send({ error: "invalid_period_start" });
        }
        result = await getBudgetService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          { periodStart: new Date(`${q.period_start}T12:00:00.000Z`) },
        );
      } else {
        result = await getBudgetService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          { period: "this_month" },
        );
      }
      return result;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/budgets/:budgetId", async (req, reply) => {
    const params = req.params as { id: string; budgetId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const ok = await deleteBudgetService(
        { workspaceId: ctx.membership.workspaceId },
        { budgetId: params.budgetId },
      );
      if (!ok) return reply.code(404).send({ error: "budget_not_found" });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 4: Register the routes in `apps/api/src/server.ts`**

Add the import alongside the existing route imports (after `categoriesRoutes`):

```typescript
import { budgetsRoutes } from "./routes/budgets.js";
```

And register inside the setup function (after `categoriesRoutes`, before `chatRoutes`):

```typescript
  await app.register(budgetsRoutes);
```

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/budgets.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 6.3 Commit

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/budgets.ts apps/api/src/server.ts apps/api/tests/budgets.routes.test.ts
git commit -m "feat(plan 1c-budget): HTTP routes POST/GET/DELETE /budgets"
```

---

## Task 7: Three chat tools + system prompt update + registry bump

**Files:**
- Create: `apps/api/src/chat/tools/set-budget.ts`
- Create: `apps/api/src/chat/tools/get-budget.ts`
- Create: `apps/api/src/chat/tools/compare-spending-vs-budget.ts`
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts` (SYSTEM_PROMPT)
- Modify: `apps/api/tests/chat.tools.registry.test.ts` (bump 14 → 17)
- Create: `apps/api/tests/chat.tools.set-budget.test.ts`
- Create: `apps/api/tests/chat.tools.get-budget.test.ts`
- Create: `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`

### 7.1 `setBudget` tool

- [ ] **Step 1: Create `apps/api/src/chat/tools/set-budget.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { setBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    category_id: z.string().min(1).optional(),
    category_name: z.string().min(1).max(40).optional(),
    amount: z.number().positive().max(99_999_999.99),
    period: z.enum(["this_month", "last_month", "next_month"]).optional(),
  })
  .refine((a) => Boolean(a.category_id) !== Boolean(a.category_name), {
    message: "Provide exactly one of category_id or category_name",
  });

type Args = z.infer<typeof Args>;

export const setBudget: ToolDef<
  Args,
  { budget: { id: string; categoryId: string; categoryName: string; amount: string; periodStart: string } }
> = {
  name: "setBudget",
  description:
    "Set the monthly budget for a category. Upserts on (workspace, category, month). Use category_id when known, else category_name (case-insensitive). period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    let categoryId = args.category_id;
    let categoryName: string;
    if (categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryName = cat.name;
    } else {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name!, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }
    const out = await setBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { categoryId, amount: args.amount, period: args.period ?? "this_month" },
    );
    return {
      budget: { ...out.budget, categoryName },
    };
  },
};
```

- [ ] **Step 2: Create `apps/api/tests/chat.tools.set-budget.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudget } from "../src/chat/tools/set-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("setBudget chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `sb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "SB", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "sb-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    coffeeCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod rejects amount: 0", () => {
    const r = setBudget.args.safeParse({ category_id: coffeeCatId, amount: 0, period: "this_month" });
    expect(r.success).toBe(false);
  });

  it("Zod rejects both category_id and category_name set", () => {
    const r = setBudget.args.safeParse({
      category_id: coffeeCatId,
      category_name: "Coffee",
      amount: 500,
    });
    expect(r.success).toBe(false);
  });

  it("Zod accepts amount with just category_id", () => {
    const r = setBudget.args.safeParse({ category_id: coffeeCatId, amount: 500 });
    expect(r.success).toBe(true);
  });

  it("resolves category by name case-insensitively + returns canonical name", async () => {
    const out = await setBudget.run(ctx, { category_name: "coffee", amount: 500 });
    expect(out.budget.categoryId).toBe(coffeeCatId);
    expect(out.budget.categoryName).toBe("Coffee");
  });

  it("upserts on conflict", async () => {
    await setBudget.run(ctx, { category_id: coffeeCatId, amount: 500 });
    const out = await setBudget.run(ctx, { category_id: coffeeCatId, amount: 700 });
    expect(out.budget.amount).toBe("700.00");
    expect(await prisma.budget.count({ where: { workspaceId: wsId } })).toBe(1);
  });
});
```

- [ ] **Step 3: Run — expect PASS (5/5)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.set-budget.test.ts --reporter=basic 2>&1 | tail -10
```

### 7.2 `getBudget` tool

- [ ] **Step 4: Create `apps/api/src/chat/tools/get-budget.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { getBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

export const getBudget: ToolDef<
  Args,
  { budgets: Array<{ id: string; categoryId: string; categoryName: string; amount: string; periodStart: string }> }
> = {
  name: "getBudget",
  description:
    "List monthly budgets. Returns a single-element array when category_id or category_name is provided, else all budgets for the period.",
  args: Args,
  async run(ctx, args) {
    if (args.category_id && args.category_name) throw new Error("invalid_body");
    let categoryId: string | undefined = args.category_id;
    if (!categoryId && args.category_name) {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name, mode: "insensitive" },
        },
        select: { id: true },
      });
      // Not found → returns empty array (we don't throw — read tool is informational).
      if (!cat) return { budgets: [] };
      categoryId = cat.id;
    }
    const out = await getBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { categoryId, period: args.period ?? "this_month" },
    );
    // Hydrate categoryName for each row.
    const ids = out.budgets.map((b) => b.categoryId);
    const cats = await prisma.category.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      budgets: out.budgets.map((b) => ({ ...b, categoryName: nameById.get(b.categoryId) ?? "" })),
    };
  },
};
```

- [ ] **Step 5: Create `apps/api/tests/chat.tools.get-budget.test.ts`** with 3 cases (single by id, all for period, empty array). Mirror the boilerplate from set-budget.test.ts. Concrete cases:

```typescript
// boilerplate identical to setBudget test
it("returns single budget when category_id provided", async () => {
  await prisma.budget.create({
    data: { workspaceId: wsId, categoryId: coffeeCatId, amount: "300.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
  });
  const r = await getBudget.run(ctx, { category_id: coffeeCatId });
  expect(r.budgets).toHaveLength(1);
  expect(r.budgets[0]!.categoryName).toBe("Coffee");
});

it("returns all budgets for period when no category", async () => {
  const foodId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } })).id;
  await prisma.budget.createMany({
    data: [
      { workspaceId: wsId, categoryId: coffeeCatId, amount: "100.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
      { workspaceId: wsId, categoryId: foodId, amount: "200.00", periodStart: new Date("2026-05-01T12:00:00.000Z") },
    ],
  });
  const r = await getBudget.run(ctx, {});
  expect(r.budgets).toHaveLength(2);
});

it("returns empty array when no budgets exist", async () => {
  const r = await getBudget.run(ctx, {});
  expect(r.budgets).toEqual([]);
});
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.get-budget.test.ts --reporter=basic 2>&1 | tail -10
```

### 7.3 `compareSpendingVsBudget` tool

- [ ] **Step 7: Create `apps/api/src/chat/tools/compare-spending-vs-budget.ts`**

```typescript
import { z } from "zod";
import { compareSpendingVsBudgetService } from "../../budgets/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  period: z.enum(["this_month", "last_month", "next_month"]).optional(),
});

type Args = z.infer<typeof Args>;

export const compareSpendingVsBudget: ToolDef<
  Args,
  {
    period: { start: string; end: string };
    items: Array<{
      categoryId: string;
      categoryName: string;
      amount: string;
      spent: string;
      remaining: string;
      spentPct: number;
      todayPct: number;
      status: "on-pace" | "over-pace";
    }>;
  }
> = {
  name: "compareSpendingVsBudget",
  description:
    "Compare actual spending against budgets for the given period. Returns per-category amount/spent/remaining/pace status. period defaults to this_month.",
  args: Args,
  async run(ctx, args) {
    return compareSpendingVsBudgetService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { period: args.period ?? "this_month" },
    );
  },
};
```

- [ ] **Step 8: Create `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts`** with 1-2 cases (the underlying service is heavily tested in Task 5; the chat tool layer is a thin pass-through).

```typescript
// boilerplate identical to setBudget test, plus an account for transactions
it("returns service output unchanged for this_month", async () => {
  await setBudget.run(ctx, { category_id: coffeeCatId, amount: 100 });
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
  await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "t1",
      amount: "30.00", currency: "CAD", merchantRaw: "M", categoryId: coffeeCatId,
      occurredAt: new Date("2026-05-10T12:00:00Z"), rawData: {},
    },
  });
  const r = await compareSpendingVsBudget.run(ctx, { period: "this_month" });
  expect(r.items).toHaveLength(1);
  expect(r.items[0]!.spent).toBe("30.00");
});
```

- [ ] **Step 9: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.compare-spending-vs-budget.test.ts --reporter=basic 2>&1 | tail -10
```

### 7.4 Registry + system prompt

- [ ] **Step 10: Register the 3 new tools in `apps/api/src/chat/tools/index.ts`**

Open the file. Add the imports next to the existing tool imports, then append three entries to the `REGISTRY: ToolDef[]` array. The existing 14 entries use `as ToolDef` casts because `ToolDef<TArgs, TResult>` is not assignable to the unparameterized `ToolDef` (run's args are narrower); the new entries need the same cast or `pnpm nx run api:typecheck` will fail.

```typescript
import { setBudget } from "./set-budget.js";
import { getBudget } from "./get-budget.js";
import { compareSpendingVsBudget } from "./compare-spending-vs-budget.js";

// In the REGISTRY array body, after the existing 14 entries:
  setBudget as ToolDef,
  getBudget as ToolDef,
  compareSpendingVsBudget as ToolDef,
```

- [ ] **Step 11: Update `apps/api/src/chat/turn.ts` SYSTEM_PROMPT**

Open `apps/api/src/chat/turn.ts` and find the existing write-tool sentence (the one that mentions `createCategory, addTransactionNote`). Replace it to extend the list and add an example. The existing line looks roughly like:

```
"For write tools (createCategory, addTransactionNote), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?'"
```

Replace with:

```
"For write tools (createCategory, addTransactionNote, setBudget), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?'"
```

- [ ] **Step 12: Bump the registry test count**

Open `apps/api/tests/chat.tools.registry.test.ts`. Find the case asserting the tool count is 14 and bump to 17. Find the case asserting the names array contains all expected tools and add `setBudget`, `getBudget`, `compareSpendingVsBudget`.

- [ ] **Step 13: Run the registry test — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.registry.test.ts --reporter=basic 2>&1 | tail -10
```

### 7.5 Commit

- [ ] **Step 14: Commit**

```bash
git add apps/api/src/chat/tools/set-budget.ts \
        apps/api/src/chat/tools/get-budget.ts \
        apps/api/src/chat/tools/compare-spending-vs-budget.ts \
        apps/api/src/chat/tools/index.ts \
        apps/api/src/chat/turn.ts \
        apps/api/tests/chat.tools.set-budget.test.ts \
        apps/api/tests/chat.tools.get-budget.test.ts \
        apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts \
        apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1c-budget): register setBudget/getBudget/compareSpendingVsBudget + prompt"
```

---

## Task 8: Full suite verification

**Files:** none (verification only).

### 8.1 Run the full API suite via nx

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** all files pass. Count = baseline 64 + 6 new = **70 files**. Tests = baseline 529 + (6 firstOfMonthDateInTz + 21 service + ~7 routes + 5+3+1 chat tools + 1 registry bump) ≈ **573 tests**. ±2 acceptable if any existing assertion needed adjusting.

### 8.2 Sanity grep — Budget references reach everything intended

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "budgetsRoutes\|setBudget\|getBudget\|compareSpendingVsBudget" apps/api/src/ | head -20
```

**Expected:**
- `routes/budgets.ts` defines `budgetsRoutes`.
- `server.ts` imports + registers `budgetsRoutes`.
- `chat/tools/index.ts` imports + registers all three chat tools.
- `chat/turn.ts` SYSTEM_PROMPT mentions `setBudget`.

```bash
grep -rn "firstOfMonthDateInTz" apps/api/src/
```

**Expected:** export in `periods.ts` + use in `budgets/service.ts`.

### 8.3 No new dependency

- [ ] **Step 3: Confirm `package.json` unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged).

---

## Self-Review Checklist (after all tasks)

Before final code review:

1. **Spec coverage:** Every spec §4 model, §5 period computation, §6 service, §7 errors, §8 chat tools, §9 routes, §10 system prompt is wired up by a task.
2. **All 7 commits are small + topic-focused** (Tasks 1-7 each commit, Task 8 verification-only).
3. **Service never throws unexpected errors** — `invalid_amount`, `category_not_found`, `budget_not_found` are the only thrown strings.
4. **`updateMany`/`deleteMany` semantics** — Used where the WHERE clause includes columns beyond the primary key (`title IS NULL` style). `setBudgetService` uses `upsert` because the unique key is fully specified.
5. **System prompt only changed in one place** — the write-tool sentence. The "When a tool returns { error: ... }" sentence and the rest of the prompt are untouched.

---

## Known limitations (documented in spec §13)

- Weekly budgets / rollover / multi-currency / overall (no-category) budgets are explicit follow-ups, not in this plan.
- `PATCH` endpoint not added; POST upserts.
- `compareSpendingVsBudget` is chat-only (no HTTP route v1).
- `action_intents` / `audit_events` / rich blocks belong to separate 1C-confirmation / 1C-audit plans.
- UI changes are out of scope (user iterates separately).

These are listed here so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §13 of the spec."
