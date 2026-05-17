# Plan 1C-recurring-persist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user-confirmed recurring expenses — new `RecurringExpense` model + 3 chat tools (`addRecurring`, `listRecurring`, `removeRecurring`) + 3 HTTP routes. `(workspaceId, nameNormalized)` is the dedup key; `merchant` is normalized server-side via `normalizeMerchant`.

**Architecture:** Prisma `RecurringExpense` model with `nameNormalized` column + composite unique index. Shared service module `apps/api/src/recurring/service.ts` is consumed by both chat tools and HTTP routes (DRY, follows 1C-budget pattern). System prompt's write-tool sentence extends to include `addRecurring` and `removeRecurring`.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork).

**Spec:** [`docs/superpowers/specs/2026-05-17-plan-1c-recurring-persist-design.md`](../specs/2026-05-17-plan-1c-recurring-persist-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `RecurringCadence` enum + `RecurringExpense` model + relations on `Workspace`/`Category` |
| `apps/api/prisma/migrations/<ts>_add_recurring_expenses/migration.sql` | DDL: enum, table, indexes, FKs |
| `apps/api/src/recurring/service.ts` | 4 service functions |
| `apps/api/src/chat/tools/add-recurring.ts` | `addRecurring` chat tool |
| `apps/api/src/chat/tools/list-recurring.ts` | `listRecurring` chat tool |
| `apps/api/src/chat/tools/remove-recurring.ts` | `removeRecurring` chat tool |
| `apps/api/src/chat/tools/index.ts` | Register 3 new tools (18 → 21) with `as ToolDef` cast |
| `apps/api/src/chat/turn.ts` | Extend write-tool confirmation sentence |
| `apps/api/src/routes/recurring.ts` | POST/GET/DELETE handlers |
| `apps/api/src/server.ts` | Register `recurringRoutes` |
| `apps/api/tests/recurring.service.test.ts` | 13+ service cases |
| `apps/api/tests/recurring.routes.test.ts` | 7 route cases (includes workspace_mismatch) |
| `apps/api/tests/chat.tools.add-recurring.test.ts` | 5 chat-tool cases |
| `apps/api/tests/chat.tools.list-recurring.test.ts` | 3 chat-tool cases |
| `apps/api/tests/chat.tools.remove-recurring.test.ts` | 3 chat-tool cases |
| `apps/api/tests/chat.tools.registry.test.ts` | Bump 18 → 21 + plan 1c-recurring describe block |

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

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Test suite: `72 passed / 596 passed`.

If not at baseline, stop and report — do NOT start on a broken baseline.

---

## Task 1: Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_recurring_expenses/migration.sql`

### 1.1 Add the Prisma model

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

Append the new enum + model (place after `Budget` for readability):

```prisma
enum RecurringCadence {
  monthly
  semimonthly
  biweekly
  weekly
  yearly
}

model RecurringExpense {
  id                  String           @id @default(cuid())
  workspaceId         String
  name                String
  nameNormalized      String
  amount              Decimal          @db.Decimal(10, 2)
  currency            String           @default("CAD")
  categoryId          String?
  merchantNormalized  String?
  cadence             RecurringCadence
  nextOccurrenceDate  DateTime         @db.Date
  createdAt           DateTime         @default(now())
  updatedAt           DateTime         @updatedAt

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category  Category? @relation(fields: [categoryId], references: [id], onDelete: SetNull)

  @@unique([workspaceId, nameNormalized])
  @@index([workspaceId, nextOccurrenceDate])
  @@map("recurring_expenses")
}
```

Add inverse relations (mirror how `budgets Budget[]` is positioned):
- In `model Workspace { ... }` add: `recurringExpenses RecurringExpense[]`
- In `model Category { ... }` add: `recurringExpenses RecurringExpense[]`

### 1.2 Generate the migration

- [ ] **Step 2: Generate migration skeleton**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_recurring_expenses 2>&1 | tail -20
```

Read the generated `migration.sql`. It should contain:
- `CREATE TYPE "RecurringCadence" AS ENUM ('monthly', 'semimonthly', 'biweekly', 'weekly', 'yearly');`
- `CREATE TABLE "recurring_expenses"` with all columns
- `CREATE UNIQUE INDEX "recurring_expenses_workspaceId_nameNormalized_key" ON "recurring_expenses"("workspaceId", "nameNormalized");`
- `CREATE INDEX "recurring_expenses_workspaceId_nextOccurrenceDate_idx" ON "recurring_expenses"("workspaceId", "nextOccurrenceDate");`
- 2 FK constraints (workspace → CASCADE, category → SET NULL)

If Prisma's `--create-only` adds unrelated drift statements (e.g. a `DROP INDEX` stub from manually-managed indexes elsewhere — happened on prior plans), strip those out so only the recurring-related DDL remains. Read the whole file before proceeding.

### 1.3 Apply + verify baseline

- [ ] **Step 3: Apply migration on both DBs + regenerate client**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
```

**Expected:** both deploys report applying `add_recurring_expenses`.

- [ ] **Step 4: Confirm baseline still passes**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** 72 files / 596 tests still PASS (no consumer of the new model yet).

### 1.4 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-recurring-persist): RecurringExpense model + migration"
```

---

## Task 2: Service module — addRecurring + listRecurring (TDD)

**Files:**
- Create: `apps/api/src/recurring/service.ts`
- Create: `apps/api/tests/recurring.service.test.ts`

### 2.1 Write the failing tests for `addRecurringService` + `listRecurringService`

- [ ] **Step 1: Create `apps/api/tests/recurring.service.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  addRecurringService,
  listRecurringService,
} from "../src/recurring/service.js";

describe("addRecurringService", () => {
  let workspaceId: string;
  let categoryId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `re-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RE", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "re-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Streaming" } })).id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a row with currency=CAD by default and computes nameNormalized", async () => {
    const r = await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    expect(r.recurring.name).toBe("Netflix");
    expect(r.recurring.currency).toBe("CAD");
    expect(r.recurring.amount).toBe("19.99");
    expect(r.recurring.nextOccurrenceDate).toBe("2026-06-01");
    const row = await prisma.recurringExpense.findFirst({ where: { workspaceId } });
    expect(row?.nameNormalized).toBe("netflix");
  });

  it("upserts on (workspaceId, nameNormalized) — same name different case replaces row", async () => {
    await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    const r = await addRecurringService(
      { workspaceId },
      { name: "netflix", amount: 22.99, cadence: "monthly", nextOccurrenceDate: "2026-07-01" },
    );
    expect(r.recurring.amount).toBe("22.99");
    expect(r.recurring.name).toBe("netflix");  // raw name replaced
    expect(r.recurring.nextOccurrenceDate).toBe("2026-07-01");
    const all = await prisma.recurringExpense.findMany({ where: { workspaceId } });
    expect(all).toHaveLength(1);
  });

  it("rejects amount = 0 with invalid_amount", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 0, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
      ),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects amount over Decimal(10,2) cap with invalid_amount", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 100_000_000, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
      ),
    ).rejects.toThrow("invalid_amount");
  });

  it("rejects bogus month nextOccurrenceDate with invalid_next_date", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-13-01" },
      ),
    ).rejects.toThrow("invalid_next_date");
  });

  it("rejects non-real date like 2026-02-30 with invalid_next_date", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        { name: "X", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-02-30" },
      ),
    ).rejects.toThrow("invalid_next_date");
  });

  it("rejects cross-workspace categoryId with category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-re-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "Y" } });
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          categoryId: otherCat.id,
        },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects archived categoryId with category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          categoryId,
        },
      ),
    ).rejects.toThrow("category_not_found");
  });

  it("rejects whitespace-only merchant with invalid_merchant", async () => {
    await expect(
      addRecurringService(
        { workspaceId },
        {
          name: "X",
          amount: 10,
          cadence: "monthly",
          nextOccurrenceDate: "2026-06-01",
          merchant: "   ",
        },
      ),
    ).rejects.toThrow("invalid_merchant");
  });

  it("normalizes raw merchant input via normalizeMerchant", async () => {
    const r = await addRecurringService(
      { workspaceId },
      {
        name: "Netflix",
        amount: 19.99,
        cadence: "monthly",
        nextOccurrenceDate: "2026-06-01",
        merchant: "STARBUCKS #1234 TORONTO ON",
      },
    );
    expect(r.recurring.merchantNormalized).toBe("starbucks");
  });

  it("accepts semimonthly cadence and persists it", async () => {
    const r = await addRecurringService(
      { workspaceId },
      { name: "Hydro", amount: 90, cadence: "semimonthly", nextOccurrenceDate: "2026-06-15" },
    );
    expect(r.recurring.cadence).toBe("semimonthly");
  });
});

describe("listRecurringService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `rl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RL", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rl-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns rows ordered by nextOccurrenceDate ASC then name ASC", async () => {
    await addRecurringService({ workspaceId }, { name: "Zeta", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-06-01" });
    await addRecurringService({ workspaceId }, { name: "Alpha", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-06-01" });
    await addRecurringService({ workspaceId }, { name: "Beta", amount: 10, cadence: "monthly", nextOccurrenceDate: "2026-05-15" });
    const r = await listRecurringService({ workspaceId });
    const names = r.recurring.map((row) => row.name);
    expect(names).toEqual(["Beta", "Alpha", "Zeta"]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.2 Implement addRecurring + listRecurring

- [ ] **Step 3: Create `apps/api/src/recurring/service.ts` with addRecurring + listRecurring + shared utilities**

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";

export type Cadence = "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";

const MAX_AMOUNT = 99_999_999.99;

export type AddRecurringInput = {
  name: string;
  amount: number;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId?: string | null;
  merchant?: string | null;
  currency?: string;
};

export type RecurringRow = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  merchantNormalized: string | null;
};

export type AddRecurringOutput = { recurring: RecurringRow };
export type ListRecurringOutput = { recurring: RecurringRow[] };

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

// Strict YYYY-MM-DD validation: shape + round-trip. Avoids destructuring
// the split result so noUncheckedIndexedAccess doesn't leave `number | undefined`
// fields flowing into Date.UTC and arithmetic.
function isValidDateOnly(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return false;
  const back =
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return back === s;
}

function formatRow(row: {
  id: string;
  name: string;
  amount: Prisma.Decimal;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: Date;
  categoryId: string | null;
  merchantNormalized: string | null;
}): RecurringRow {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    cadence: row.cadence,
    nextOccurrenceDate: row.nextOccurrenceDate.toISOString().slice(0, 10),
    categoryId: row.categoryId,
    merchantNormalized: row.merchantNormalized,
  };
}

export async function addRecurringService(
  ctx: { workspaceId: string },
  input: AddRecurringInput,
): Promise<AddRecurringOutput> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw new Error("invalid_amount");
  }
  if (!isValidDateOnly(input.nextOccurrenceDate)) {
    throw new Error("invalid_next_date");
  }
  const nameNormalized = normalizeName(input.name);
  if (nameNormalized.length === 0) throw new Error("invalid_body");

  let merchantNormalized: string | null = null;
  if (input.merchant != null && input.merchant !== "") {
    const m = normalizeMerchant(input.merchant);
    if (m.length === 0) throw new Error("invalid_merchant");
    merchantNormalized = m;
  }

  if (input.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cat) throw new Error("category_not_found");
  }

  const periodDate = new Date(`${input.nextOccurrenceDate}T12:00:00.000Z`);
  const data = {
    workspaceId: ctx.workspaceId,
    name: input.name,
    nameNormalized,
    amount: new Prisma.Decimal(input.amount),
    currency: (input.currency ?? "CAD").toUpperCase(),
    categoryId: input.categoryId ?? null,
    merchantNormalized,
    cadence: input.cadence,
    nextOccurrenceDate: periodDate,
  };
  const row = await prisma.recurringExpense.upsert({
    where: {
      workspaceId_nameNormalized: {
        workspaceId: ctx.workspaceId,
        nameNormalized,
      },
    },
    create: data,
    update: {
      name: data.name,
      amount: data.amount,
      currency: data.currency,
      categoryId: data.categoryId,
      merchantNormalized: data.merchantNormalized,
      cadence: data.cadence,
      nextOccurrenceDate: data.nextOccurrenceDate,
    },
  });
  return { recurring: formatRow(row) };
}

export async function listRecurringService(
  ctx: { workspaceId: string },
): Promise<ListRecurringOutput> {
  const rows = await prisma.recurringExpense.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ nextOccurrenceDate: "asc" }, { name: "asc" }],
  });
  return { recurring: rows.map(formatRow) };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  12 passed (12)`.

### 2.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/recurring/service.ts apps/api/tests/recurring.service.test.ts
git commit -m "feat(plan 1c-recurring-persist): addRecurringService + listRecurringService"
```

---

## Task 3: removeRecurring services (TDD)

**Files:**
- Modify: `apps/api/src/recurring/service.ts` (append)
- Modify: `apps/api/tests/recurring.service.test.ts` (append cases)

### 3.1 Append failing tests

- [ ] **Step 1: Append to `apps/api/tests/recurring.service.test.ts`**

```typescript
import {
  removeRecurringByIdService,
  removeRecurringByNameService,
} from "../src/recurring/service.js";

describe("removeRecurringByIdService", () => {
  let workspaceId: string;
  let userId: string;
  let recurringId: string;

  beforeEach(async () => {
    const stamp = `rid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RID", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rid-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    const r = await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
    recurringId = r.recurring.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("deletes and returns true for own row", async () => {
    expect(await removeRecurringByIdService({ workspaceId }, { id: recurringId })).toBe(true);
    expect(await prisma.recurringExpense.findUnique({ where: { id: recurringId } })).toBeNull();
  });

  it("returns false for cross-workspace id", async () => {
    expect(await removeRecurringByIdService({ workspaceId: "other-ws" }, { id: recurringId })).toBe(false);
    expect(await prisma.recurringExpense.findUnique({ where: { id: recurringId } })).not.toBeNull();
  });
});

describe("removeRecurringByNameService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `rnm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RNM", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "rnm-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    await addRecurringService(
      { workspaceId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-06-01" },
    );
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("case-insensitive resolve + delete returns true", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "NETFLIX" })).toBe(true);
    expect(await prisma.recurringExpense.count({ where: { workspaceId } })).toBe(0);
  });

  it("returns false for nonexistent name", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "DoesNotExist" })).toBe(false);
  });

  it("returns false for whitespace-only name", async () => {
    expect(await removeRecurringByNameService({ workspaceId }, { name: "   " })).toBe(false);
    expect(await prisma.recurringExpense.count({ where: { workspaceId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL on the new exports**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 3.2 Implement

- [ ] **Step 3: Append to `apps/api/src/recurring/service.ts`**

```typescript
export async function removeRecurringByIdService(
  ctx: { workspaceId: string },
  input: { id: string },
): Promise<boolean> {
  const { count } = await prisma.recurringExpense.deleteMany({
    where: { id: input.id, workspaceId: ctx.workspaceId },
  });
  return count > 0;
}

export async function removeRecurringByNameService(
  ctx: { workspaceId: string },
  input: { name: string },
): Promise<boolean> {
  const nameNormalized = normalizeName(input.name);
  if (nameNormalized.length === 0) return false;
  const row = await prisma.recurringExpense.findUnique({
    where: {
      workspaceId_nameNormalized: {
        workspaceId: ctx.workspaceId,
        nameNormalized,
      },
    },
    select: { id: true },
  });
  if (!row) return false;
  return removeRecurringByIdService(ctx, { id: row.id });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  17 passed (17)` (12 from Task 2 + 5 new).

### 3.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/recurring/service.ts apps/api/tests/recurring.service.test.ts
git commit -m "feat(plan 1c-recurring-persist): removeRecurringById + removeRecurringByName"
```

---

## Task 4: HTTP routes

**Files:**
- Create: `apps/api/src/routes/recurring.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/recurring.routes.test.ts`

### 4.1 Write the failing route tests

- [ ] **Step 1: Create `apps/api/tests/recurring.routes.test.ts`**

Read `apps/api/tests/budgets.routes.test.ts` first and copy its `buildApp` / `signUpAndGetCookie` / `makePro` boilerplate exactly. Then add the 7 cases below as their own describe block.

```typescript
// Sketch — implementer copies the budgets.routes.test.ts boilerplate.
// Required test cases:
describe("POST /workspaces/:id/recurring", () => {
  it("201 with valid body", async () => {
    // sign up + Pro + create category + POST { name: "Netflix", amount: 19.99,
    //   cadence: "monthly", nextOccurrenceDate: "2026-06-01", categoryId }
    // → 201, body.recurring.name === "Netflix"
  });
  it("400 invalid_amount on amount=0", async () => { /* … */ });
  it("404 category_not_found on missing category", async () => { /* … */ });
  it("402 upgrade_required when trial expired (Free tier)", async () => { /* … */ });
  it("400 workspace_mismatch when :id ≠ X-Workspace-Id header", async () => {
    // POST to /workspaces/<other-ws-id>/recurring with X-Workspace-Id = <this-ws-id>
    // → 400 { error: "workspace_mismatch" }
  });
});
describe("GET /workspaces/:id/recurring", () => {
  it("200 viewer can read", async () => { /* sign in second user as viewer + GET */ });
});
describe("DELETE /workspaces/:id/recurring/:recurringId", () => {
  it("204 deletes own + 404 on cross-workspace id", async () => { /* … */ });
});
```

The implementer copies boilerplate from `apps/api/tests/budgets.routes.test.ts` verbatim — DO NOT invent new helpers; the existing ones already wrap Fastify in-process.

- [ ] **Step 2: Run — expect FAIL (route not registered)**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 4.2 Create the route file

- [ ] **Step 3: Create `apps/api/src/routes/recurring.ts`**

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  addRecurringService,
  listRecurringService,
  removeRecurringByIdService,
} from "../recurring/service.js";

const CADENCE = z.enum(["monthly", "semimonthly", "biweekly", "weekly", "yearly"]);
const PostBody = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number(),  // service validates positive/cap — 0/neg surfaces as invalid_amount
  cadence: CADENCE,
  nextOccurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().min(1).optional(),
  merchant: z.string().min(1).max(200).optional(),
  currency: z.string().length(3).optional(),
});

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/recurring", async (req, reply) => {
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
      // Build the service input WITHOUT the optional keys when their values
      // are undefined — tsconfig.base.json has `exactOptionalPropertyTypes: true`,
      // which rejects `{ categoryId: undefined }` against `categoryId?: string | null`.
      // Same fix shape as the chat-tool snippet in Task 5 (Parameters<…>[1] + conditional).
      const serviceInput: Parameters<typeof addRecurringService>[1] = {
        name: parsed.data.name,
        amount: parsed.data.amount,
        cadence: parsed.data.cadence,
        nextOccurrenceDate: parsed.data.nextOccurrenceDate,
      };
      if (parsed.data.categoryId !== undefined) serviceInput.categoryId = parsed.data.categoryId;
      if (parsed.data.merchant !== undefined) serviceInput.merchant = parsed.data.merchant;
      if (parsed.data.currency !== undefined) serviceInput.currency = parsed.data.currency;
      const result = await addRecurringService(
        { workspaceId: ctx.membership.workspaceId },
        serviceInput,
      );
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "invalid_amount") return reply.code(400).send({ error: "invalid_amount" });
      if (msg === "invalid_next_date") return reply.code(400).send({ error: "invalid_next_date" });
      if (msg === "invalid_merchant") return reply.code(400).send({ error: "invalid_merchant" });
      if (msg === "invalid_body") return reply.code(400).send({ error: "invalid_body" });
      if (msg === "category_not_found") return reply.code(404).send({ error: "category_not_found" });
      throw e;
    }
  });

  app.get("/workspaces/:id/recurring", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      return await listRecurringService({ workspaceId: ctx.membership.workspaceId });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/recurring/:recurringId", async (req, reply) => {
    const params = req.params as { id: string; recurringId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const ok = await removeRecurringByIdService(
        { workspaceId: ctx.membership.workspaceId },
        { id: params.recurringId },
      );
      if (!ok) return reply.code(404).send({ error: "recurring_not_found" });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 4: Register in `apps/api/src/server.ts`**

Add the import (after `budgetsRoutes`):

```typescript
import { recurringRoutes } from "./routes/recurring.js";
```

And register inside the setup function (after `await app.register(budgetsRoutes);`, before `await app.register(chatRoutes);`):

```typescript
  await app.register(recurringRoutes);
```

- [ ] **Step 5: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/recurring.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 4.3 Commit

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/recurring.ts apps/api/src/server.ts apps/api/tests/recurring.routes.test.ts
git commit -m "feat(plan 1c-recurring-persist): HTTP routes POST/GET/DELETE /recurring"
```

---

## Task 5: addRecurring chat tool (TDD)

**Files:**
- Create: `apps/api/src/chat/tools/add-recurring.ts`
- Create: `apps/api/tests/chat.tools.add-recurring.test.ts`

### 5.1 Write the failing test

- [ ] **Step 1: Create `apps/api/tests/chat.tools.add-recurring.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let streamingCatId: string;

  beforeEach(async () => {
    const stamp = `arch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "ARCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "arch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    streamingCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Streaming" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod rejects amount=0", () => {
    const r = addRecurring.args.safeParse({
      name: "Netflix",
      amount: 0,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    expect(r.success).toBe(false);
  });

  it("Zod rejects malformed next_occurrence_date", () => {
    const r = addRecurring.args.safeParse({
      name: "Netflix",
      amount: 10,
      cadence: "monthly",
      next_occurrence_date: "not-a-date",
    });
    expect(r.success).toBe(false);
  });

  it("Zod accepts semimonthly cadence", () => {
    const r = addRecurring.args.safeParse({
      name: "Paycheck Bill",
      amount: 50,
      cadence: "semimonthly",
      next_occurrence_date: "2026-06-15",
    });
    expect(r.success).toBe(true);
  });

  it("resolves category_name case-insensitively and returns canonical categoryName", async () => {
    const out = await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
      category_name: "streaming",
    });
    expect(out.recurring.categoryId).toBe(streamingCatId);
    expect(out.recurring.categoryName).toBe("Streaming");
  });

  it("upserts on conflict: second call with same name (different case) updates the row", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await addRecurring.run(ctx, {
      name: "netflix",
      amount: 22.99,
      cadence: "monthly",
      next_occurrence_date: "2026-07-01",
    });
    expect(out.recurring.amount).toBe("22.99");
    expect(await prisma.recurringExpense.count({ where: { workspaceId: wsId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.add-recurring.test.ts --reporter=basic 2>&1 | tail -10
```

### 5.2 Implement

- [ ] **Step 3: Create `apps/api/src/chat/tools/add-recurring.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { addRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number().positive().max(99_999_999.99),
  cadence: z.enum(["monthly", "semimonthly", "biweekly", "weekly", "yearly"]),
  next_occurrence_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category_id: z.string().min(1).optional(),
  category_name: z.string().min(1).max(40).optional(),
  merchant: z.string().min(1).max(200).optional(),
  currency: z.string().length(3).optional(),
}).refine(
  (a) => !(a.category_id && a.category_name),
  { message: "Provide at most one of category_id or category_name" },
);

type Args = z.infer<typeof Args>;

export const addRecurring: ToolDef<
  Args,
  {
    recurring: {
      id: string;
      name: string;
      amount: string;
      currency: string;
      cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
      nextOccurrenceDate: string;
      categoryId: string | null;
      categoryName: string | null;
      merchantNormalized: string | null;
    };
  }
> = {
  name: "addRecurring",
  description:
    "Add a recurring expense (subscription, bill). Upserts on case-insensitive name within the workspace. Use category_id when known, else category_name (case-insensitive). cadence: monthly | semimonthly | biweekly | weekly | yearly. next_occurrence_date: YYYY-MM-DD.",
  args: Args,
  async run(ctx, args) {
    let categoryId: string | null = null;
    let categoryName: string | null = null;
    if (args.category_id) {
      const cat = await prisma.category.findFirst({
        where: { id: args.category_id, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    } else if (args.category_name) {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }

    const serviceInput: Parameters<typeof addRecurringService>[1] = {
      name: args.name,
      amount: args.amount,
      cadence: args.cadence,
      nextOccurrenceDate: args.next_occurrence_date,
    };
    if (categoryId) serviceInput.categoryId = categoryId;
    if (args.merchant) serviceInput.merchant = args.merchant;
    if (args.currency) serviceInput.currency = args.currency;

    const out = await addRecurringService({ workspaceId: ctx.workspaceId }, serviceInput);
    return {
      recurring: { ...out.recurring, categoryName },
    };
  },
};
```

Note on the `Parameters<…>[1]` pattern: builds the optional fields only when set so `tsconfig.base.json`'s `exactOptionalPropertyTypes: true` doesn't reject undefined assignments (same fix shape as `b88de06` for get-budget).

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.add-recurring.test.ts --reporter=basic 2>&1 | tail -10
```

### 5.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/add-recurring.ts apps/api/tests/chat.tools.add-recurring.test.ts
git commit -m "feat(plan 1c-recurring-persist): addRecurring chat tool"
```

---

## Task 6: listRecurring + removeRecurring chat tools (TDD)

**Files:**
- Create: `apps/api/src/chat/tools/list-recurring.ts`
- Create: `apps/api/src/chat/tools/remove-recurring.ts`
- Create: `apps/api/tests/chat.tools.list-recurring.test.ts`
- Create: `apps/api/tests/chat.tools.remove-recurring.test.ts`

### 6.1 listRecurring tests + implementation

- [ ] **Step 1: Create `apps/api/tests/chat.tools.list-recurring.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listRecurring } from "../src/chat/tools/list-recurring.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let streamingCatId: string;

  beforeEach(async () => {
    const stamp = `lrch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "LRCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "lrch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    streamingCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Streaming" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns empty array when no rows", async () => {
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring).toEqual([]);
  });

  it("hydrates categoryName for non-null categoryId rows", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
      category_id: streamingCatId,
    });
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring).toHaveLength(1);
    expect(out.recurring[0]!.categoryName).toBe("Streaming");
  });

  it("returns categoryName=null when categoryId is null", async () => {
    await addRecurring.run(ctx, {
      name: "Hydro",
      amount: 90,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring[0]!.categoryName).toBeNull();
  });
});
```

- [ ] **Step 2: Create `apps/api/src/chat/tools/list-recurring.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { listRecurringService } from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});

type Args = z.infer<typeof Args>;

export const listRecurring: ToolDef<
  Args,
  {
    recurring: Array<{
      id: string;
      name: string;
      amount: string;
      currency: string;
      cadence: "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";
      nextOccurrenceDate: string;
      categoryId: string | null;
      categoryName: string | null;
      merchantNormalized: string | null;
    }>;
  }
> = {
  name: "listRecurring",
  description:
    "List all recurring expenses in the workspace, ordered by next occurrence date. Includes the resolved category name (null if uncategorized).",
  args: Args,
  async run(ctx, _args) {
    const out = await listRecurringService({ workspaceId: ctx.workspaceId });
    const ids = out.recurring
      .map((r) => r.categoryId)
      .filter((id): id is string => id !== null);
    // Hydrate canonical category names. Filter out archived categories AND
    // scope to the workspace so an archived/cross-workspace category id
    // (defense-in-depth) yields categoryName: null — matching the listRecurring
    // test "Returns categoryName: null when … category was archived".
    const cats = ids.length
      ? await prisma.category.findMany({
          where: {
            id: { in: ids },
            workspaceId: ctx.workspaceId,
            archivedAt: null,
          },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      recurring: out.recurring.map((r) => ({
        ...r,
        categoryName: r.categoryId ? nameById.get(r.categoryId) ?? null : null,
      })),
    };
  },
};
```

- [ ] **Step 3: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.list-recurring.test.ts --reporter=basic 2>&1 | tail -10
```

### 6.2 removeRecurring tests + implementation

- [ ] **Step 4: Create `apps/api/tests/chat.tools.remove-recurring.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { removeRecurring } from "../src/chat/tools/remove-recurring.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("removeRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `rmch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RMCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "rmch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod XOR refine rejects both fields and rejects neither", () => {
    expect(removeRecurring.args.safeParse({ recurring_id: "x", name: "Netflix" }).success).toBe(false);
    expect(removeRecurring.args.safeParse({}).success).toBe(false);
  });

  it("removes by id (own row) returns {removed: true}; cross-workspace id returns {removed: false}", async () => {
    const added = await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await removeRecurring.run(ctx, { recurring_id: added.recurring.id });
    expect(out.removed).toBe(true);
    expect(await prisma.recurringExpense.count({ where: { workspaceId: wsId } })).toBe(0);

    // A second remove with the same id (now gone) returns false.
    const out2 = await removeRecurring.run(ctx, { recurring_id: added.recurring.id });
    expect(out2.removed).toBe(false);
  });

  it("removes by name (case-insensitive) returns {removed: true}; nonexistent name returns {removed: false}", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await removeRecurring.run(ctx, { name: "NETFLIX" });
    expect(out.removed).toBe(true);

    const out2 = await removeRecurring.run(ctx, { name: "DoesNotExist" });
    expect(out2.removed).toBe(false);
  });
});
```

- [ ] **Step 5: Create `apps/api/src/chat/tools/remove-recurring.ts`**

```typescript
import { z } from "zod";
import {
  removeRecurringByIdService,
  removeRecurringByNameService,
} from "../../recurring/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  recurring_id: z.string().min(1).optional(),
  name: z.string().min(1).max(100).optional(),
}).refine(
  (a) => Boolean(a.recurring_id) !== Boolean(a.name),
  { message: "Provide exactly one of recurring_id or name" },
);

type Args = z.infer<typeof Args>;

export const removeRecurring: ToolDef<Args, { removed: boolean }> = {
  name: "removeRecurring",
  description:
    "Remove a recurring expense. Hard delete. Provide exactly one of recurring_id (preferred) or name (case-insensitive resolve).",
  args: Args,
  async run(ctx, args) {
    if (args.recurring_id) {
      const removed = await removeRecurringByIdService(
        { workspaceId: ctx.workspaceId },
        { id: args.recurring_id },
      );
      return { removed };
    }
    const removed = await removeRecurringByNameService(
      { workspaceId: ctx.workspaceId },
      { name: args.name! },
    );
    return { removed };
  },
};
```

- [ ] **Step 6: Run — expect PASS for both chat-tool test files**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.list-recurring.test.ts tests/chat.tools.remove-recurring.test.ts --reporter=basic 2>&1 | tail -10
```

### 6.3 Commit

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/chat/tools/list-recurring.ts apps/api/src/chat/tools/remove-recurring.ts \
        apps/api/tests/chat.tools.list-recurring.test.ts apps/api/tests/chat.tools.remove-recurring.test.ts
git commit -m "feat(plan 1c-recurring-persist): listRecurring + removeRecurring chat tools"
```

---

## Task 7: Registry + system prompt + registry test bump

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts`
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

### 7.1 Register in tools/index.ts

- [ ] **Step 1: Edit `apps/api/src/chat/tools/index.ts`**

Add the imports (alongside the existing tool imports):

```typescript
import { addRecurring } from "./add-recurring.js";
import { listRecurring } from "./list-recurring.js";
import { removeRecurring } from "./remove-recurring.js";
```

Append three entries to the `REGISTRY: ToolDef[]` array (after the existing 18 — `mapMerchantToCategory as ToolDef,` is currently last):

```typescript
  addRecurring as ToolDef,
  listRecurring as ToolDef,
  removeRecurring as ToolDef,
```

### 7.2 Update SYSTEM_PROMPT

- [ ] **Step 2: Edit `apps/api/src/chat/turn.ts`**

Find the existing write-tool sentence (currently mentions `createCategory, addTransactionNote, setBudget, mapMerchantToCategory`). Replace ENTIRELY with:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?' or '구독 정리 좀 해줄까?'
```

(The literal in the file is a TypeScript template-string ending in a backtick. Preserve the surrounding quoting; only swap the listed content.)

### 7.3 Bump registry test

- [ ] **Step 3: Edit `apps/api/tests/chat.tools.registry.test.ts`**

a) **Update BOTH existing length assertions** to `expect(REGISTRY).toHaveLength(21);`:
- The `expect(REGISTRY).toHaveLength(17);` line inside the `REGISTRY (plan 1c-budget)` block.
- The `expect(REGISTRY).toHaveLength(18);` line inside the `REGISTRY (plan 1c-merchant-map)` block.

Both blocks were left in place by prior plans; the new total is 21 across the whole file.

b) Append a new describe block at the END of the file:

```typescript
describe("REGISTRY (plan 1c-recurring-persist)", () => {
  const EXPECTED = [
    [
      "addRecurring",
      "Add a recurring expense (subscription, bill). Upserts on case-insensitive name within the workspace. Use category_id when known, else category_name (case-insensitive). cadence: monthly | semimonthly | biweekly | weekly | yearly. next_occurrence_date: YYYY-MM-DD.",
    ],
    [
      "listRecurring",
      "List all recurring expenses in the workspace, ordered by next occurrence date. Includes the resolved category name (null if uncategorized).",
    ],
    [
      "removeRecurring",
      "Remove a recurring expense. Hard delete. Provide exactly one of recurring_id (preferred) or name (case-insensitive resolve).",
    ],
  ] as const;

  it("contains all three new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("registry has 21 tools total", () => {
    expect(REGISTRY).toHaveLength(21);
  });

  it("addRecurring, listRecurring, removeRecurring are all registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("addRecurring");
    expect(names).toContain("listRecurring");
    expect(names).toContain("removeRecurring");
  });
});
```

- [ ] **Step 4: Run registry test — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.registry.test.ts --reporter=basic 2>&1 | tail -10
```

### 7.4 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/index.ts apps/api/src/chat/turn.ts apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1c-recurring-persist): register addRecurring/listRecurring/removeRecurring + prompt"
```

---

## Task 8: Full suite verification + final sanity

**Files:** none (verification only).

### 8.1 Run the full API suite via nx

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** all files pass. Count = baseline 72 + 5 new = **77 files**. Tests = baseline 596 + ~30 new = **~626 tests** (±3 acceptable).

### 8.2 Sanity grep

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "recurringRoutes\|addRecurring\|listRecurring\|removeRecurring\|RecurringExpense" apps/api/src/ | head -20
```

**Expected:**
- `routes/recurring.ts` defines `recurringRoutes`.
- `server.ts` imports + registers `recurringRoutes`.
- `chat/tools/index.ts` imports + registers all three chat tools.
- `chat/turn.ts` SYSTEM_PROMPT mentions `addRecurring` and `removeRecurring`.
- `recurring/service.ts` exports the 4 service functions.

```bash
grep -rn "addRecurringService\|listRecurringService\|removeRecurringByIdService\|removeRecurringByNameService" apps/api/src/
```

**Expected:** defined in `recurring/service.ts`; consumed by chat tools + route handlers.

### 8.3 Typecheck

- [ ] **Step 3: Confirm no new TS errors**

```bash
./node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | grep "error TS" | head -10
```

**Expected:** the pre-existing `apps/api/src/chat/turn.ts:131` `InputJsonValue` error remains (unrelated, present on main since 1B). NO new errors involving recurring files.

If a new `exactOptionalPropertyTypes` error appears (e.g. on optional `categoryId`/`merchant`/`currency` passed to `addRecurringService`), see the fix pattern in `apps/api/src/chat/tools/get-budget.ts` (commit `b88de06`): build the input without the key unless it has a value. Task 5's implementation already uses `Parameters<typeof addRecurringService>[1]` + conditional assignment for this reason.

### 8.4 No new dependency

- [ ] **Step 4: Confirm `package.json` unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged).

---

## Self-Review Checklist (after all tasks)

Before final code review:

1. **Spec coverage:** Every spec §4 model field, §5 service function, §6 error code, §7 chat tool, §8 HTTP route, §9 system prompt is implemented by a task.
2. **`as ToolDef` cast** is present on all three new registry entries.
3. **`workspace_mismatch` check** is in all three HTTP route handlers (spec §8) and covered by the routes test.
4. **Service never throws unexpected errors** — only `invalid_amount`, `invalid_next_date`, `invalid_merchant`, `invalid_body`, `category_not_found`.
5. **`nameNormalized`** is set on every write path and used as the upsert/lookup key.
6. **`merchant` is normalized server-side** (never accepted as a pre-formed `merchantNormalized` string by HTTP).

---

## Known limitations (documented in spec §13)

- No `active` column / pause-vs-cancel — hard delete only.
- No `lastOccurrenceDate`.
- No auto-link of transactions to recurring on sync.
- `detectRecurringMerchants` does not surface "already persisted" — separate follow-up.
- No PATCH endpoint (POST upserts).
- Semi-monthly second-anchor logic deferred.
- Next-N-days forecast tool deferred (Phase 2).
- `action_intents` / `audit_events` / rich blocks belong to separate plans.
- UI changes are out of scope.

These are listed so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §13 of the spec".
