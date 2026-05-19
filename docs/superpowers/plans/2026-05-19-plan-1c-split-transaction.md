# Plan 1C-split-transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-19-plan-1c-split-transaction-design.md` (commit 46fe1a9 onwards).

**Goal:** Replace `Transaction.categoryId` with a unified `transaction_allocations` table — every transaction has ≥1 allocation row with `sum=tx.amount`. Adds split semantics (PATCH with allocations array) for both manual and posted Plaid tx.

**Architecture:** Single source of truth for category attribution. New helper `applyAllocations` enforces invariants (sum, validity, per-row source). Auto-categorize/map-merchant move to per-row atomic updates with where-clause guards (no workspace lock). Plaid sync invalidates split allocations on amount/merchant changes (N≥2) and tracks single allocation amount on N=1. Pre-launch — can rebuild data model cleanly.

**Tech Stack:** TypeScript ESM, Prisma + Postgres on `5433/fina_test`, Fastify + Better Auth, Vitest singleFork, `pg_advisory_xact_lock(hashtext(workspaceId))` for write serialization, `Prisma.Decimal(14, 2)` for amounts.

---

## Migration strategy — two-phase to keep TDD green

The spec lays out a single migration that backfills allocations AND drops the old columns. For TDD safety (every task ends with green tests), we split into **two migrations**:

1. **Migration A** (Task 1): ADD `transaction_allocations` table + indexes + `Transaction.needsReclassification` + backfill 1 allocation per existing tx. KEEP `Transaction.categoryId` and `Transaction.categorizationSource` for now.
2. **Migration B** (Task 8): After all read/write paths refactored, DROP `categoryId`, `categorizationSource`, and the workspaceId+categoryId index. Remove mirror-write code from services.

During Tasks 2-7 services write to BOTH allocations AND `tx.categoryId` (mirror-write). This lets refactor proceed file-by-file: every read path sees a consistent state because writes update both. Task 8 removes the mirror-write code as the column drop migration lands.

---

## Task Dependency Order

1. **Task 1** — Migration A + `applyAllocations` helper. Foundation; everything else depends.
2. **Task 2** — Refactor `createManualTransactionService` + `applyManualCategorize` (write paths). Mirror-write `tx.categoryId`.
3. **Task 3** — Refactor `auto-categorize` and `map-merchant` (per-row atomic). Mirror-write.
4. **Task 4** — Refactor Plaid sync (`upsertAdded`, `upsertModified`, pending→posted promotion). Mirror-write.
5. **Task 5** — Extend `editTransactionService` + PATCH route (`categoryId`/`allocations` body fields, per-field source check, `cannot_split_pending`, `conflicting_body`, `sum_mismatch`).
6. **Task 6** — Refactor read paths: budget service + chat tools that aggregate by category.
7. **Task 7** — Refactor remaining chat tools + GET `/transactions` response shape.
8. **Task 8** — Migration B (drop columns) + remove mirror-write code from all services.
9. **Task 9** — Smoke test doc.

Each task ends with a green API test suite and a single commit.

---

## Pre-flight (every task)

Test command (whole API suite):
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Specific file:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.allocations.test.ts
```

⚠ Paths are RELATIVE to `apps/api/` (pnpm sets cwd to apps/api). Do NOT use `pnpm --filter @fina/api test ...` — there is no `test` script and pnpm exits 0 with no output.

Baseline before starting: 794 tests passing across 92 files (post-merge of plan 1C-edit-delete-transaction).

If working in an isolated worktree, confirm clean baseline first:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

---

## Task 1: Migration A + `applyAllocations` helper

**Files:**
- Create: `apps/api/prisma/migrations/<ts>_add_allocations/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (add `TransactionAllocation` model, add `Transaction.needsReclassification` and `allocations` relation, add `Category.allocations` relation)
- Create: `apps/api/src/transactions/allocations.ts`
- Create: `apps/api/tests/transactions.allocations.test.ts`

**Spec refs:** §3.1, §3.4, §5.2.

### Step 1: Add schema models

Edit `apps/api/prisma/schema.prisma`:

In the `Transaction` model (currently at line 270), add the `needsReclassification` field and `allocations` relation. KEEP `categoryId`, `categorizationSource`, the `category` relation, and the `@@index([workspaceId, categoryId])` index — all to be removed in Task 8.

```prisma
model Transaction {
  // ... existing fields unchanged ...
  needsReclassification     Boolean           @default(false)

  workspace   Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  account     BankAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  plaidItem   PlaidItem?  @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)
  category    Category?   @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  allocations TransactionAllocation[]

  @@index([workspaceId, occurredAt(sort: Desc)])
  @@index([workspaceId, accountId, occurredAt(sort: Desc)])
  @@index([workspaceId, categoryId])
  @@map("transactions")
}
```

In the `Category` model (line 312), add the `allocations` relation. KEEP the existing `transactions` relation (removed in Task 8).

```prisma
model Category {
  // ... existing fields ...
  transactions Transaction[]
  allocations  TransactionAllocation[]
}
```

Add the new `TransactionAllocation` model after `Transaction` (around line 304):

```prisma
model TransactionAllocation {
  id            String                @id @default(cuid())
  transactionId String
  categoryId    String?
  amount        Decimal               @db.Decimal(14, 2)
  source        CategorizationSource?
  createdAt     DateTime              @default(now())
  updatedAt     DateTime              @updatedAt

  transaction Transaction @relation(fields: [transactionId], references: [id], onDelete: Cascade)
  category    Category?   @relation(fields: [categoryId], references: [id], onDelete: Restrict)

  @@index([transactionId])
  @@index([categoryId])
  @@index([categoryId, transactionId])
  @@map("transaction_allocations")
}
```

### Step 2: Create the migration SQL

Generate the migration via Prisma. Subagent should run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_allocations
```

If the `--create-only` flag fails in the subagent's non-interactive shell, manually create `apps/api/prisma/migrations/<ts>_add_allocations/migration.sql` with the SQL below. The timestamp can match Prisma's convention `YYYYMMDDHHMMSS`.

Migration content:

```sql
-- 1. Create the new table
CREATE TABLE "transaction_allocations" (
  "id"             TEXT PRIMARY KEY,
  "transactionId"  TEXT NOT NULL,
  "categoryId"     TEXT,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "source"         "CategorizationSource",
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "transaction_allocations_transactionId_fkey"
    FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE CASCADE,
  CONSTRAINT "transaction_allocations_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT
);
CREATE INDEX "transaction_allocations_transactionId_idx" ON "transaction_allocations"("transactionId");
CREATE INDEX "transaction_allocations_categoryId_idx"    ON "transaction_allocations"("categoryId");
CREATE INDEX "transaction_allocations_categoryId_transactionId_idx"
  ON "transaction_allocations"("categoryId", "transactionId");

-- 2. Add the new flag on transactions
ALTER TABLE "transactions" ADD COLUMN "needsReclassification" BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Backfill: one allocation per existing tx (matches current categoryId + categorizationSource)
INSERT INTO "transaction_allocations"
  ("id", "transactionId", "categoryId", "amount", "source", "createdAt", "updatedAt")
SELECT
  'allo_' || replace(gen_random_uuid()::text, '-', '')  AS id,
  t."id"                                                AS "transactionId",
  t."categoryId",
  t."amount",
  t."categorizationSource"                              AS "source",
  COALESCE(t."createdAt", CURRENT_TIMESTAMP),
  COALESCE(t."updatedAt", CURRENT_TIMESTAMP)
FROM "transactions" t;

-- 4. Safety guard: invariant sum(allocations.amount) === tx.amount per tx
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM (
    SELECT t."id", t."amount" AS tx_amount, COALESCE(SUM(a."amount"), 0) AS alloc_sum
    FROM "transactions" t
    LEFT JOIN "transaction_allocations" a ON a."transactionId" = t."id"
    GROUP BY t."id", t."amount"
  ) s
  WHERE s.alloc_sum <> s.tx_amount;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Allocation backfill mismatch: % rows have sum(allocations.amount) != tx.amount. Aborting migration.', bad_count;
  END IF;
END $$;
```

⚠ This migration is PHASE A — it does NOT drop `Transaction.categoryId` or `Transaction.categorizationSource`. Task 8 adds Migration B for the drop.

### Step 3: Run migration in test DB to verify backfill works

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma generate
```

Expected: migration applies cleanly, Prisma client regenerates with `TransactionAllocation`.

### Step 4: Run full suite to confirm no regression

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: 794 tests still pass. The migration adds a new table + column but doesn't change existing column behavior.

### Step 5: Write failing tests for `applyAllocations` helper

Create `apps/api/tests/transactions.allocations.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { withWorkspaceLock } from "../src/locks/workspace.js";
import {
  applyAllocations,
  AllocationError,
} from "../src/transactions/allocations.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { wsId, userId: u.userId };
}

async function seedTx(wsId: string, amount: string): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
      amount, merchantRaw: "Test", merchantNormalized: "test",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false, source: "manual", rawData: {},
    },
  });
  // Wipe the auto-backfilled allocation so the helper writes are clean
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  return tx.id;
}

describe("applyAllocations", () => {
  it("rejects empty array → empty_allocations", async () => {
    const { wsId } = await setup("aa1@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", []),
      ),
    ).rejects.toMatchObject({ code: "empty_allocations" });
  });

  it("rejects sum < tx.amount → sum_mismatch", async () => {
    const { wsId } = await setup("aa2@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 5 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "sum_mismatch" });
  });

  it("rejects sum > tx.amount → sum_mismatch", async () => {
    const { wsId } = await setup("aa3@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 5 },
          { categoryId: null, amount: 6 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "sum_mismatch" });
  });

  it("rejects 0.005 fractional cent → invalid_allocation_amount", async () => {
    const { wsId } = await setup("aa4@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: null, amount: 9.995 },
          { categoryId: null, amount: 0.005 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "invalid_allocation_amount" });
  });

  it("rejects nonexistent categoryId → category_not_found", async () => {
    const { wsId } = await setup("aa5@t.co");
    const txId = await seedTx(wsId, "10");
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: "no-such-cat", amount: 10 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects archived categoryId → category_not_found", async () => {
    const { wsId } = await setup("aa6@t.co");
    const txId = await seedTx(wsId, "10");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch-aa6", archivedAt: new Date() },
    });
    await expect(
      withWorkspaceLock(wsId, async (tx) =>
        applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
          { categoryId: cat.id, amount: 10 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("happy: 1 null-cat allocation (uncategorized)", async () => {
    const { wsId } = await setup("aa7@t.co");
    const txId = await seedTx(wsId, "10");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), null, [
        { categoryId: null, amount: 10 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBeNull();
    expect(allocs[0]!.amount.toString()).toBe("10");
    expect(allocs[0]!.source).toBeNull();
  });

  it("happy: 1 categorized allocation", async () => {
    const { wsId } = await setup("aa8@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food-aa8" } });
    const txId = await seedTx(wsId, "10");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: cat.id, amount: 10 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.categoryId).toBe(cat.id);
    expect(allocs[0]!.source).toBe("manual");
  });

  it("happy: 3 allocations summing to amount", async () => {
    const { wsId } = await setup("aa9@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "Groc-aa9" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "Elec-aa9" } });
    const c3 = await prisma.category.create({ data: { workspaceId: wsId, name: "Home-aa9" } });
    const txId = await seedTx(wsId, "200");
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("200"), "manual", [
        { categoryId: c1.id, amount: 120 },
        { categoryId: c2.id, amount: 50 },
        { categoryId: c3.id, amount: 30 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(3);
    expect(allocs.map((a) => a.amount.toString()).sort()).toEqual(["120", "30", "50"]);
  });

  it("replaces existing allocations (delete + create) atomically", async () => {
    const { wsId } = await setup("aa10@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "A-aa10" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "B-aa10" } });
    const txId = await seedTx(wsId, "10");
    // Initial allocation
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: c1.id, amount: 10 },
      ]),
    );
    // Replace with two
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: c1.id, amount: 4 },
        { categoryId: c2.id, amount: 6 },
      ]),
    );
    const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(allocs).toHaveLength(2);
  });

  it("clears needsReclassification flag", async () => {
    const { wsId } = await setup("aa11@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "X-aa11" } });
    const txId = await seedTx(wsId, "10");
    await prisma.transaction.update({ where: { id: txId }, data: { needsReclassification: true } });
    await withWorkspaceLock(wsId, async (tx) =>
      applyAllocations(tx, wsId, txId, new Prisma.Decimal("10"), "manual", [
        { categoryId: cat.id, amount: 10 },
      ]),
    );
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.needsReclassification).toBe(false);
  });
});
```

### Step 6: Run, verify failure (module missing)

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.allocations.test.ts
```

Expected: FAIL — import error (`Cannot find module '../src/transactions/allocations.js'`).

### Step 7: Implement `applyAllocations`

Create `apps/api/src/transactions/allocations.ts`:

```ts
import { Prisma } from "@prisma/client";

export type AllocationInput = { categoryId: string | null; amount: number };

export type AllocationErrorCode =
  | "empty_allocations"
  | "sum_mismatch"
  | "invalid_allocation_amount"
  | "category_not_found";

export class AllocationError extends Error {
  readonly code: AllocationErrorCode;
  constructor(code: AllocationErrorCode) {
    super(code);
    this.name = "AllocationError";
    this.code = code;
  }
}

// Same Decimal(14, 2) rule as create-manual.ts: positive, ≤ MAX, ≤2 decimals,
// rejects scientific notation via string regex.
const MAX_AMOUNT = 999_999_999.99;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

function validateOneAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new AllocationError("invalid_allocation_amount");
  }
  if (!AMOUNT_RE.test(String(amount))) {
    throw new AllocationError("invalid_allocation_amount");
  }
}

export type AllocationSource = "manual" | "mapping" | "ai" | null;

/**
 * Replace all allocations for a transaction atomically. MUST be called inside
 * a withWorkspaceLock callback. Validates amounts, sum, and category existence.
 * Sets transaction.needsReclassification = false on success.
 *
 * Invariant guaranteed on return: txId has exactly `allocations.length` rows
 * in transaction_allocations, sum(amount) === txAmount, each non-null
 * categoryId is a non-archived category in the workspace.
 */
export async function applyAllocations(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  txId: string,
  txAmount: Prisma.Decimal,
  source: AllocationSource,
  allocations: AllocationInput[],
): Promise<void> {
  if (allocations.length === 0) {
    throw new AllocationError("empty_allocations");
  }

  // Validate each amount first.
  for (const a of allocations) {
    validateOneAmount(a.amount);
  }

  // Strict Decimal sum equality.
  const sum = allocations.reduce(
    (acc, a) => acc.plus(new Prisma.Decimal(a.amount)),
    new Prisma.Decimal(0),
  );
  if (!sum.equals(txAmount)) {
    throw new AllocationError("sum_mismatch");
  }

  // Validate each non-null categoryId is in workspace + not archived.
  const uniqueCatIds = Array.from(
    new Set(allocations.map((a) => a.categoryId).filter((c): c is string => c !== null)),
  );
  if (uniqueCatIds.length > 0) {
    const found = await tx.category.findMany({
      where: { id: { in: uniqueCatIds }, workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (found.length !== uniqueCatIds.length) {
      throw new AllocationError("category_not_found");
    }
  }

  // Replace allocations atomically. deleteMany + createMany inside the
  // caller-provided `tx` (which is already inside a Prisma $transaction
  // started by withWorkspaceLock).
  await tx.transactionAllocation.deleteMany({ where: { transactionId: txId } });
  await tx.transactionAllocation.createMany({
    data: allocations.map((a) => ({
      transactionId: txId,
      categoryId: a.categoryId,
      amount: new Prisma.Decimal(a.amount),
      source,
    })),
  });

  // Clear the needsReclassification flag — user has now categorized.
  await tx.transaction.update({
    where: { id: txId },
    data: { needsReclassification: false },
  });
}
```

### Step 8: Run helper tests, verify PASS

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.allocations.test.ts
```

Expected: 11 tests PASS.

### Step 9: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: 794+11 = 805 tests PASS.

### Step 10: Commit

```bash
git add apps/api/prisma/schema.prisma \
        apps/api/prisma/migrations/ \
        apps/api/src/transactions/allocations.ts \
        apps/api/tests/transactions.allocations.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): migration A + applyAllocations helper

Phase A of two-phase migration: adds transaction_allocations table
(with backfill of 1 allocation per existing tx) + Transaction.
needsReclassification. Keeps Transaction.categoryId / categorizationSource
for the duration of the refactor (dropped in Migration B at Task 8).

applyAllocations helper enforces invariants atomically inside a
withWorkspaceLock callback: ≥1 entry, sum === txAmount (Decimal-exact),
each amount > 0 ≤ MAX ≤2 decimals, non-null categories must be
non-archived workspace categories. Clears needsReclassification on
success. 11 unit tests cover every error branch + the replace-existing
case.
EOF
)"
```

---

## Task 2: Refactor `createManualTransactionService` + `applyManualCategorize`

**Files:**
- Modify: `apps/api/src/transactions/create-manual.ts`
- Modify: `apps/api/src/categorize/manual-categorize.ts`
- Modify: `apps/api/tests/transactions.create-manual.test.ts` (response shape assertions)
- Modify: `apps/api/tests/categorize.manual-service.test.ts` (allocation assertions)

**Spec refs:** §5.1, §6.3.

Strategy: write to allocations as the primary store, AND mirror-write `tx.categoryId` + `tx.categorizationSource` for backward compat (other code paths still read these until Task 6-7). Task 8 removes the mirror-write.

### Step 1: Update `createManualTransactionService`

Modify `apps/api/src/transactions/create-manual.ts`. The current function creates the tx and returns it. After Task 2:

1. Same tx creation as today (still write `categoryId` + `categorizationSource` fields to keep reads working).
2. Inside the existing `withWorkspaceLock` callback, after `tx.transaction.create(...)`, call `applyAllocations` with one entry: `[{ categoryId: input.categoryId ?? null, amount: input.amount }]` and source = `input.categoryId !== undefined ? "manual" : null`.
3. Extend `CreateManualTxResult.transaction` to include `allocations: Array<{ id, categoryId, amount, source }>` and `needsReclassification: false`. Read allocations back via `tx.transactionAllocation.findMany` after the insert.

Add imports at the top of `create-manual.ts`:

```ts
import { applyAllocations } from "./allocations.js";
```

Replace the existing `CreateManualTxResult` type with:

```ts
export type CreateManualTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;             // mirror-write; dropped in Task 8
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    needsReclassification: false;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
  };
};
```

Inside the `withWorkspaceLock` callback at the end of the function, AFTER the existing `tx.transaction.create({ ... })` call, insert the allocation write. The current return statement uses `row` (the created tx). Replace the closing block with:

```ts
    const allocSource: "manual" | null = input.categoryId !== undefined ? "manual" : null;
    await applyAllocations(
      tx,
      ctx.workspaceId,
      row.id,
      row.amount,
      allocSource,
      [{ categoryId: input.categoryId ?? null, amount: input.amount }],
    );

    const allocs = await tx.transactionAllocation.findMany({
      where: { transactionId: row.id },
      select: { id: true, categoryId: true, amount: true, source: true },
      orderBy: { createdAt: "asc" },
    });

    return {
      transaction: {
        id: row.id,
        accountId: row.accountId,
        plaidTransactionId: null,
        amount: row.amount.toString(),
        currency: workspace.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        categoryId: row.categoryId,
        occurredAt: row.occurredAt.toISOString(),
        pending: false,
        source: "manual",
        note: row.note,
        removedAt: null,
        needsReclassification: false,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        allocations: allocs.map((a) => ({
          id: a.id,
          categoryId: a.categoryId,
          amount: a.amount.toString(),
          source: a.source,
        })),
      },
    };
```

### Step 2: Update `applyManualCategorize`

Modify `apps/api/src/categorize/manual-categorize.ts`. The current implementation (after 1C-edit-delete-transaction's lock retrofit) reads tx inside the lock, then writes `tx.categoryId` + `categorizationSource` on the target + back-fills siblings.

New behavior:
- Write target via `applyAllocations` (single entry with the chosen category, amount = target tx.amount, source = "manual").
- Continue setting `tx.categoryId` + `categorizationSource` on target for mirror-compat.
- Sibling back-fill: per §6.3, target only siblings with EXACTLY 1 allocation that's null-cat OR source != "manual". Skip siblings with N≥2 allocations. Skip siblings whose existing allocation source is "manual" (don't overwrite user-confirmed).

Replace the `withWorkspaceLock` callback body in `manual-categorize.ts` (currently around line 58-117) with:

```ts
  const result = await withWorkspaceLock(input.workspaceId, async (tx) => {
    const txRow = await tx.transaction.findFirst({
      where: { id: input.txId, workspaceId: input.workspaceId },
      select: { id: true, amount: true, merchantRaw: true, merchantNormalized: true },
    });
    if (!txRow) throw new ManualCategorizeError("tx_not_found");

    const merchantNorm = txRow.merchantNormalized ?? normalizeMerchant(txRow.merchantRaw);

    // Primary: write allocations via the helper (single entry).
    await applyAllocations(
      tx,
      input.workspaceId,
      txRow.id,
      txRow.amount,
      "manual",
      [{ categoryId: category.id, amount: Number(txRow.amount.toString()) }],
    );

    // Mirror-write Transaction.categoryId / categorizationSource for reads
    // not yet refactored. Dropped in Task 8.
    await tx.transaction.update({
      where: { id: txRow.id },
      data: {
        merchantNormalized: merchantNorm,
        categoryId: category.id,
        categorizationSource: "manual",
      },
    });

    // Merchant mapping upsert (unchanged).
    await tx.merchantMapping.upsert({
      where: {
        workspaceId_merchantNormalized: {
          workspaceId: input.workspaceId,
          merchantNormalized: merchantNorm,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        categoryId: category.id,
        confidence: 1.0,
        source: "manual",
      },
      update: { categoryId: category.id, source: "manual", confidence: 1.0 },
    });

    // Sibling normalization (unchanged) — back-fills merchantNormalized for legacy NULL rows.
    const nullSiblings = await tx.transaction.findMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: null,
        merchantRaw: {
          mode: "insensitive",
          contains: trimmedName.length >= 3 ? merchantNorm.slice(0, 3) : merchantNorm,
        },
      },
      select: { id: true, merchantRaw: true },
    });
    for (const ns of nullSiblings) {
      const norm = normalizeMerchant(ns.merchantRaw);
      if (norm === merchantNorm) {
        await tx.transaction.update({ where: { id: ns.id }, data: { merchantNormalized: norm } });
      }
    }

    // Sibling category back-fill — unified rule per spec §6.3:
    //   target sibling has exactly 1 allocation; that allocation is null-cat
    //   OR source != "manual"; skip N≥2 siblings entirely.
    const siblings = await tx.transaction.findMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        id: { not: txRow.id },
        allocations: { some: {} },
      },
      include: { allocations: { select: { id: true, source: true } } },
    });
    let backfilledCount = 0;
    for (const sib of siblings) {
      if (sib.allocations.length !== 1) continue; // skip splits
      const a = sib.allocations[0]!;
      if (a.source === "manual") continue; // don't overwrite user-confirmed
      // Atomic per-row update with guard: only update if still not manual.
      const upd = await tx.transactionAllocation.updateMany({
        where: { id: a.id, source: { not: "manual" } },
        data: { categoryId: category.id, source: "mapping" },
      });
      if (upd.count > 0) {
        backfilledCount += 1;
        // Mirror-write Transaction.categoryId for compat (Task 8 removes).
        await tx.transaction.update({
          where: { id: sib.id },
          data: { categoryId: category.id, categorizationSource: "mapping" },
        });
      }
    }

    return { backfilledCount };
  });
```

The `Number(txRow.amount.toString())` conversion preserves Decimal precision through to `applyAllocations`'s `validateOneAmount` (which re-stringifies). For amounts within Decimal(14, 2), this round-trips exactly.

Also update `ManualCategorizeResult.tx` to add `allocations` and `needsReclassification`. Keep `categoryId` and `categorizationSource` for now (Task 8 drops):

```ts
export type ManualCategorizeResult = {
  tx: {
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    categoryId: string | null;             // mirror-write; dropped Task 8
    categorizationSource: "manual" | "mapping" | "ai" | null;  // dropped Task 8
    needsReclassification: boolean;
    occurredAt: Date;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
  };
  backfilledCount: number;
};
```

Update the post-lock final read to include the new fields:

```ts
  const updated = await prisma.transaction.findUniqueOrThrow({
    where: { id: input.txId },
    select: {
      id: true, amount: true, merchantRaw: true, merchantNormalized: true,
      categoryId: true, categorizationSource: true, occurredAt: true,
      needsReclassification: true,
      allocations: {
        select: { id: true, categoryId: true, amount: true, source: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return {
    tx: {
      id: updated.id,
      amount: updated.amount.toString(),
      currency: workspace.currency,
      merchantRaw: updated.merchantRaw,
      merchantNormalized: updated.merchantNormalized,
      categoryId: updated.categoryId,
      categorizationSource: updated.categorizationSource,
      needsReclassification: updated.needsReclassification,
      occurredAt: updated.occurredAt,
      allocations: updated.allocations.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        amount: a.amount.toString(),
        source: a.source,
      })),
    },
    backfilledCount: result.backfilledCount,
  };
```

### Step 3: Update create-manual tests

Extend the shape test in `apps/api/tests/transactions.create-manual.test.ts`. Find the test added in plan 1c-edit-delete-transaction that asserts the response shape and extend its assertions:

```ts
it("response includes allocations array reflecting the single category", async () => {
  const { wsId, userId } = await setupEditor("alloc-shape@t.co");
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food-shape" } });
  const { transaction: r } = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Costco", amount: 9.99, occurredAt: "2026-05-19", categoryId: cat.id },
  );
  expect(r.allocations).toHaveLength(1);
  expect(r.allocations[0]!.categoryId).toBe(cat.id);
  expect(r.allocations[0]!.amount).toBe("9.99");
  expect(r.allocations[0]!.source).toBe("manual");
  expect(r.needsReclassification).toBe(false);
});

it("response uncategorized: 1 allocation with categoryId=null, source=null", async () => {
  const { wsId, userId } = await setupEditor("alloc-uncat@t.co");
  const { transaction: r } = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Cash purchase", amount: 5, occurredAt: "2026-05-19" },
  );
  expect(r.allocations).toHaveLength(1);
  expect(r.allocations[0]!.categoryId).toBeNull();
  expect(r.allocations[0]!.source).toBeNull();
});
```

If your local `setupEditor` helper signature differs, adapt.

### Step 4: Update applyManualCategorize tests

In `apps/api/tests/categorize.manual-service.test.ts`, the existing happy-path test asserts `res.tx.categoryId` etc. Add allocation-level assertions:

```ts
// Append to the existing happy test, or add a new one:
it("writes a single allocation matching the chosen category", async () => {
  const a = await seedTx("STARBUCKS #starb-alloc", "starbucks");
  await applyManualCategorize({ workspaceId: wsId, txId: a, categoryName: "Coffee" });
  const allocs = await prisma.transactionAllocation.findMany({ where: { transactionId: a } });
  expect(allocs).toHaveLength(1);
  expect(allocs[0]!.categoryId).toBe(categoryId);
  expect(allocs[0]!.source).toBe("manual");
});

it("sibling back-fill: skips siblings with N≥2 allocations", async () => {
  const target = await seedTx("COSTCO #1", "costco");
  const splitSibling = await seedTx("COSTCO #2", "costco");
  // Split the sibling first
  const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat1-skip" } });
  const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat2-skip" } });
  // Wipe the auto-backfilled allocation and write 2 manually
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: splitSibling } });
  await prisma.transactionAllocation.createMany({
    data: [
      { transactionId: splitSibling, categoryId: c1.id, amount: "3.00", source: "manual" },
      { transactionId: splitSibling, categoryId: c2.id, amount: "2.00", source: "manual" },
    ],
  });

  await applyManualCategorize({ workspaceId: wsId, txId: target, categoryName: "Coffee" });

  const sibAllocs = await prisma.transactionAllocation.findMany({
    where: { transactionId: splitSibling },
  });
  expect(sibAllocs).toHaveLength(2); // unchanged
  expect(sibAllocs.find((a) => a.categoryId === c1.id)).toBeTruthy();
  expect(sibAllocs.find((a) => a.categoryId === c2.id)).toBeTruthy();
});
```

The exact `seedTx` helper name may differ in the file — match the local convention. Some tests use literal `prisma.transaction.create` instead of a helper.

### Step 5: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts tests/categorize.manual-service.test.ts
```

Expected: PASS (existing + new).

### Step 6: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS. The mirror-writes keep existing read paths (chat tools, budget service) consistent.

### Step 7: Commit

```bash
git add apps/api/src/transactions/create-manual.ts \
        apps/api/src/categorize/manual-categorize.ts \
        apps/api/tests/transactions.create-manual.test.ts \
        apps/api/tests/categorize.manual-service.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): allocations writes — create-manual + manual-categorize

createManualTransactionService and applyManualCategorize now write
allocations via applyAllocations (single entry covering the full tx
amount). Response shapes extended with allocations array and
needsReclassification.

Mirror-writes to Transaction.categoryId / categorizationSource
preserved during the refactor so unrefactored read paths still see
consistent state. Dropped in Task 8 alongside Migration B.

Sibling back-fill in applyManualCategorize follows spec §6.3:
skip N≥2 allocation siblings entirely; for N=1 siblings with
source != "manual", update via per-row updateMany with guard.
EOF
)"
```

---

## Task 3: Refactor auto-categorize + map-merchant

**Files:**
- Modify: `apps/api/src/categorize/service.ts` (Steps 2 mapping + Step 3 Gemini)
- Modify: `apps/api/src/categorize/map-merchant.ts` (mapping application)
- Modify: `apps/api/tests/categorize.service.test.ts` (allocation assertions)
- Modify: `apps/api/tests/categorize.map-merchant.test.ts` (allocation assertions)

**Spec refs:** §5.3, §6.1, §6.2.

Strategy: per-row atomic update with where-clause guard. NO workspace lock. Where-clause guard (`categoryId: null, source: null`) makes the update idempotent and concurrency-safe against user PATCH.

### Step 1: Update `categorize/service.ts` — Step 1 load filter + Step 2 mapping

Open `apps/api/src/categorize/service.ts`. The function currently runs in 3 stages:
1. Load `newTxIds` filtered by `categoryId: null` (today, around line 33).
2. Apply merchant mappings to those tx (Step 2 mapping loop).
3. Call Gemini for remaining tx (Step 3, around line 87-90 + 136-139).

ALL THREE stages reference `Transaction.categoryId`. They must be rewritten so Step 1's load filter does not break after Task 8 drops the column.

**1a. Rewrite the Step 1 load filter (around line 33):**

Replace the existing filter:
```ts
// BEFORE:
where: { id: { in: newTxIds }, workspaceId, categoryId: null },
```
with allocation-based equivalent:
```ts
// AFTER:
where: {
  id: { in: newTxIds },
  workspaceId,
  allocations: { some: {}, every: { categoryId: null, source: null } },
},
include: { allocations: { select: { id: true } } },
```

Then filter the returned list in JS to keep only tx with `allocations.length === 1` (per §6.2 — Prisma can't natively express "exactly one allocation, null cat, null source").

**1b. Update Step 2 mapping section** (currently filters tx by `merchantNormalized: m.merchantNormalized` and `categoryId: null`).

Find the `categorize` (or similarly named) function. The Step 2 mapping loop iterates over `merchantMappings` and updates tx with matching `merchantNormalized` AND `categoryId: null`. Replace that update logic with:

```ts
// Step 2: mapping application — find tx with N=1 null-cat allocation
//         matching merchantNormalized, update via per-row guard.
for (const m of mappings) {
  const candidates = await prisma.transaction.findMany({
    where: {
      workspaceId,
      merchantNormalized: m.merchantNormalized,
      removedAt: null,
      allocations: { some: {}, every: { categoryId: null, source: null } },
    },
    include: { allocations: { select: { id: true } } },
  });
  for (const c of candidates) {
    if (c.allocations.length !== 1) continue;
    const a = c.allocations[0]!;
    // Idempotent atomic write — only fires if the allocation is still null/null.
    const upd = await prisma.transactionAllocation.updateMany({
      where: { id: a.id, categoryId: null, source: null },
      data: { categoryId: m.categoryId, source: "mapping" },
    });
    if (upd.count > 0) {
      // Mirror-write Transaction.categoryId for compat (Task 8 removes).
      await prisma.transaction.update({
        where: { id: c.id },
        data: { categoryId: m.categoryId, categorizationSource: "mapping" },
      });
    }
  }
}
```

The exact existing variable names (`mappings`, `m.merchantNormalized`, `m.categoryId`) may differ — match local conventions.

### Step 2: Update `categorize/service.ts` Step 3 (Gemini)

The Step 3 loop iterates over Gemini results and updates each tx's `categoryId`. Replace with:

```ts
// Step 3: Gemini results — write to the single null-cat allocation per tx
//         via per-row guard. Skip tx that are already split or already
//         categorized (where-clause filter handles this idempotently).
for (const r of geminiResults) {
  const tx = await prisma.transaction.findFirst({
    where: { id: r.tx_id, workspaceId },
    include: { allocations: { select: { id: true, categoryId: true, source: true } } },
  });
  if (!tx || tx.allocations.length !== 1) continue;
  const a = tx.allocations[0]!;
  if (a.categoryId !== null || a.source !== null) continue;

  const aiCatId = categoryByLower.get(r.category.toLowerCase());
  if (!aiCatId) continue;

  const upd = await prisma.transactionAllocation.updateMany({
    where: { id: a.id, categoryId: null, source: null },
    data: { categoryId: aiCatId, source: "ai" },
  });
  if (upd.count > 0) {
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { categoryId: aiCatId, categorizationSource: "ai" },
    });
  }
}
```

Adapt local variable names (`geminiResults`, `categoryByLower`, etc.) to match.

### Step 3: Update `map-merchant.ts`

Open `apps/api/src/categorize/map-merchant.ts`. This service applies a single mapping (when user maps a merchant to a category via chat tool). It currently updates `tx.categoryId` directly for matching tx.

Find the back-fill loop (around line 65-80 today). Replace the bulk-update with per-row atomic logic mirroring Task 3 Step 1:

```ts
const candidates = await prisma.transaction.findMany({
  where: {
    workspaceId: input.workspaceId,
    merchantNormalized,
    removedAt: null,
    allocations: { some: {}, every: { categoryId: null, source: null } },
  },
  include: { allocations: { select: { id: true } } },
});
let backfilledCount = 0;
for (const c of candidates) {
  if (c.allocations.length !== 1) continue;
  const a = c.allocations[0]!;
  const upd = await prisma.transactionAllocation.updateMany({
    where: { id: a.id, categoryId: null, source: null },
    data: { categoryId: input.categoryId, source: "mapping" },
  });
  if (upd.count > 0) {
    await prisma.transaction.update({
      where: { id: c.id },
      data: { categoryId: input.categoryId, categorizationSource: "mapping" },
    });
    backfilledCount += 1;
  }
}
```

### Step 4: Update categorize.service.test.ts

In `apps/api/tests/categorize.service.test.ts`, the existing tests assert `tx.categoryId` after categorize. Extend the happy tests with allocation assertions. Example:

```ts
it("mapping application writes a single allocation with source=mapping", async () => {
  // ... setup: workspace, merchant mapping, an uncategorized tx that matches ...
  await runCategorizeBatch(...);  // existing entrypoint name in your file
  const allocs = await prisma.transactionAllocation.findMany({
    where: { transactionId: txId },
  });
  expect(allocs).toHaveLength(1);
  expect(allocs[0]!.categoryId).toBe(mappingCategoryId);
  expect(allocs[0]!.source).toBe("mapping");
});

it("Gemini result writes a single allocation with source=ai", async () => {
  // ... setup: workspace, an uncategorized tx ...
  // ... mock or inject Gemini response ...
  await runCategorizeBatch(...);
  const allocs = await prisma.transactionAllocation.findMany({
    where: { transactionId: txId },
  });
  expect(allocs).toHaveLength(1);
  expect(allocs[0]!.source).toBe("ai");
});

it("split tx (N≥2) is NOT clobbered by auto-categorize", async () => {
  // Set up a tx with 2 manual allocations
  const c1 = await prisma.category.create({ data: { workspaceId, name: "C1-noclobber" } });
  const c2 = await prisma.category.create({ data: { workspaceId, name: "C2-noclobber" } });
  const acct = await prisma.bankAccount.create({ data: { workspaceId, name: "A", type: "depository" } });
  const tx = await prisma.transaction.create({
    data: { workspaceId, accountId: acct.id, amount: "10", merchantRaw: "X",
            merchantNormalized: "x", occurredAt: new Date(), pending: false,
            source: "plaid", rawData: {}, plaidTransactionId: "p-noclobber" },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: [
      { transactionId: tx.id, categoryId: c1.id, amount: "4", source: "manual" },
      { transactionId: tx.id, categoryId: c2.id, amount: "6", source: "manual" },
    ],
  });
  // Even with a matching mapping or Gemini result, the split tx must not be touched.
  // ... trigger auto-categorize batch ...
  const after = await prisma.transactionAllocation.findMany({ where: { transactionId: tx.id } });
  expect(after).toHaveLength(2);
  expect(after.every((a) => a.source === "manual")).toBe(true);
});
```

Adapt the helper invocation to your file's existing test pattern.

### Step 5: Update map-merchant.test.ts

In `apps/api/tests/categorize.map-merchant.test.ts`, extend the back-fill happy test with allocation assertion (similar pattern as Step 4).

### Step 6: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/categorize.service.test.ts tests/categorize.map-merchant.test.ts tests/chat.tools.map-merchant-to-category.test.ts
```

Expected: PASS.

### Step 7: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 8: Commit

```bash
git add apps/api/src/categorize/service.ts \
        apps/api/src/categorize/map-merchant.ts \
        apps/api/tests/categorize.service.test.ts \
        apps/api/tests/categorize.map-merchant.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): allocations writes — auto-categorize + map-merchant

Both paths now write to transaction_allocations via per-row atomic
updateMany with where-clause guard (categoryId: null, source: null) —
no workspace lock, idempotent against concurrent user PATCH. Split tx
(N≥2 allocations) are excluded from the batch lookup so they cannot
be silently clobbered by auto-categorize.

Mirror-writes to Transaction.categoryId / categorizationSource preserved
for read-path compat (removed in Task 8).
EOF
)"
```

---

## Task 4: Refactor Plaid sync

**Files:**
- Modify: `apps/api/src/plaid/sync.ts` (`upsertAdded` fresh-insert + promotion branch, `upsertModified`)
- Modify: `apps/api/tests/plaid.sync.test.ts` (or similar; existing sync tests)
- Create: `apps/api/tests/plaid.sync.unified-alloc.test.ts` (new sync-edge tests per spec §8.5)

**Spec refs:** §5.4, §8.5.

### Step 1: Update `upsertAdded` fresh-insert path

In `apps/api/src/plaid/sync.ts`, find `upsertAdded` (around line 250). The fresh-insert path uses `tx.transaction.create(...)`. AFTER the create, add the allocation insert:

```ts
const created = await tx.transaction.create({
  data: {
    workspaceId, accountId, plaidItemId,
    plaidTransactionId: t.transaction_id,
    plaidPendingTransactionId: t.pending_transaction_id ?? null,
    amount: t.amount,
    merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
    occurredAt: plaidOccurredAt(t),
    postedAt: plaidPostedAt(t),
    pending: t.pending,
    rawData: t as unknown as Prisma.InputJsonValue,
  },
  select: { id: true, amount: true },
});
await tx.transactionAllocation.create({
  data: {
    transactionId: created.id,
    categoryId: null,
    amount: created.amount,
    source: null,
  },
});
return { kind: "inserted", localId: created.id };
```

### Step 2: Update `upsertAdded` promotion branch

The promotion branch (around line 215-238) finds a pending tx by `plaidPendingTransactionId` and updates fields including `removedAt: null`. New behavior per spec §5.4:

```ts
if (t.pending_transaction_id) {
  const promotion = await tx.transaction.findFirst({
    where: {
      workspaceId,
      plaidPendingTransactionId: t.pending_transaction_id,
      pending: true,
    },
    include: { allocations: { select: { id: true } } },
  });
  if (promotion) {
    const newAmount = new Prisma.Decimal(t.amount);
    // Paranoid check: pending tx must have N=1 allocation (cannot_split_pending
    // blocks user splits). If N != 1, log + skip the allocation update.
    if (promotion.allocations.length === 1) {
      await tx.transactionAllocation.update({
        where: { id: promotion.allocations[0]!.id },
        data: { amount: newAmount },
      });
    } else {
      console.warn("plaid sync promotion: unexpected allocation count", {
        txId: promotion.id,
        count: promotion.allocations.length,
      });
    }
    await tx.transaction.update({
      where: { id: promotion.id },
      data: {
        plaidTransactionId: t.transaction_id,
        plaidPendingTransactionId: t.pending_transaction_id,
        pending: false,
        occurredAt: plaidOccurredAt(t),
        postedAt: plaidPostedAt(t),
        amount: newAmount,
        merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
        rawData: t as unknown as Prisma.InputJsonValue,
        removedAt: null,
      },
    });
    return { kind: "updated", localId: promotion.id };
  }
}
```

### Step 3: Update `upsertModified`

Replace the body of `upsertModified` (currently a single `tx.transaction.updateMany(...)` around line 287-303):

```ts
export async function upsertModified(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  workspaceId: string,
): Promise<void> {
  // Note: no removedAt filter — matches today's updateMany scope; soft-removed
  // rows still get field updates for state consistency.
  const existing = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId: t.transaction_id },
    include: { allocations: { select: { id: true, amount: true } } },
  });
  if (!existing) return; // matches today's no-op for missing row

  const oldAmount = existing.amount;
  const newAmount = new Prisma.Decimal(t.amount);
  const amountChanged = !oldAmount.equals(newAmount);
  const newMerchantRaw = t.merchant_name ?? t.name ?? "Unknown";
  const merchantChanged = existing.merchantRaw !== newMerchantRaw;
  const N = existing.allocations.length;

  const txDataBase = {
    amount: newAmount,
    merchantRaw: newMerchantRaw,
    occurredAt: plaidOccurredAt(t),
    postedAt: plaidPostedAt(t),
    pending: t.pending,
    rawData: t as unknown as Prisma.InputJsonValue,
  };

  if (N >= 2 && (amountChanged || merchantChanged)) {
    // Invalidate split: replace allocations with 1 null-cat row + set flag.
    await tx.transactionAllocation.deleteMany({ where: { transactionId: existing.id } });
    await tx.transactionAllocation.create({
      data: {
        transactionId: existing.id,
        categoryId: null,
        amount: newAmount,
        source: null,
      },
    });
    await tx.transaction.update({
      where: { id: existing.id },
      data: { ...txDataBase, needsReclassification: true, categoryId: null, categorizationSource: null },
    });
  } else {
    // N=1 (any change) OR N≥2 with only metadata changes: preserve allocations.
    if (amountChanged && N === 1) {
      await tx.transactionAllocation.update({
        where: { id: existing.allocations[0]!.id },
        data: { amount: newAmount },
      });
    }
    await tx.transaction.update({
      where: { id: existing.id },
      data: txDataBase,
    });
  }
}
```

Note the `categoryId: null, categorizationSource: null` mirror-write on invalidation — keeps the legacy column consistent with the new allocation state.

### Step 4: Write new sync-edge tests

Create `apps/api/tests/plaid.sync.unified-alloc.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { upsertModified } from "../src/plaid/sync.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
  });
  return { wsId, userId: u.userId, acctId: acct.id };
}

async function seedPlaidTx(wsId: string, acctId: string, opts: {
  amount: string; pending?: boolean; allocations: Array<{ categoryId: string | null; amount: string; source: "manual" | "mapping" | "ai" | null }>;
}): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acctId,
      plaidTransactionId: `p_${Math.random()}`,
      amount: opts.amount,
      merchantRaw: "Costco", merchantNormalized: "costco",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending ?? false,
      source: "plaid", rawData: {},
    },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: opts.allocations.map((a) => ({
      transactionId: tx.id,
      categoryId: a.categoryId,
      amount: a.amount,
      source: a.source,
    })),
  });
  return tx.id;
}

describe("Plaid sync — unified allocations edge cases", () => {
  it("upsertModified: N=1, amount changed → tx.amount + allocation.amount both update", async () => {
    const { wsId, acctId } = await setup("ps1@t.co");
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100", allocations: [{ categoryId: null, amount: "100", source: null }],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 150, date: "2026-05-19",
        pending: false,
        merchant_name: "Costco", name: "Costco",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.amount.toString()).toBe("150");
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]!.amount.toString()).toBe("150");
    expect(after.needsReclassification).toBe(false);
  });

  it("upsertModified: N=1, only postedAt changes → no allocation update", async () => {
    const { wsId, acctId } = await setup("ps2@t.co");
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "50", allocations: [{ categoryId: null, amount: "50", source: null }],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const beforeAllocId = (await prisma.transactionAllocation.findFirstOrThrow({
      where: { transactionId: txId }, select: { id: true, updatedAt: true },
    }));
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 50, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
        datetime: "2026-05-20T12:00:00Z",
      } as any, wsId),
    );
    const afterAllocs = await prisma.transactionAllocation.findMany({ where: { transactionId: txId } });
    expect(afterAllocs).toHaveLength(1);
    expect(afterAllocs[0]!.id).toBe(beforeAllocId.id);
  });

  it("upsertModified: N=2, amount changed → allocations invalidated + needsReclassification true", async () => {
    const { wsId, acctId } = await setup("ps3@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps3" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps3" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "200",
      allocations: [
        { categoryId: c1.id, amount: "120", source: "manual" },
        { categoryId: c2.id, amount: "80", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 215, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.amount.toString()).toBe("215");
    expect(after.allocations).toHaveLength(1);
    expect(after.allocations[0]!.categoryId).toBeNull();
    expect(after.allocations[0]!.source).toBeNull();
    expect(after.allocations[0]!.amount.toString()).toBe("215");
    expect(after.needsReclassification).toBe(true);
  });

  it("upsertModified: N=2, merchant changed but amount same → allocations invalidated (per spec)", async () => {
    const { wsId, acctId } = await setup("ps4@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps4" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps4" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100",
      allocations: [
        { categoryId: c1.id, amount: "60", source: "manual" },
        { categoryId: c2.id, amount: "40", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 100, date: "2026-05-19",
        pending: false, merchant_name: "Costco Wholesale", name: "Costco Wholesale",
      } as any, wsId),
    );
    const after = await prisma.transaction.findUniqueOrThrow({
      where: { id: txId },
      include: { allocations: true },
    });
    expect(after.merchantRaw).toBe("Costco Wholesale");
    expect(after.allocations).toHaveLength(1);
    expect(after.needsReclassification).toBe(true);
  });

  it("upsertModified: N=2, only postedAt changed → allocations preserved", async () => {
    const { wsId, acctId } = await setup("ps5@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ps5" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ps5" } });
    const txId = await seedPlaidTx(wsId, acctId, {
      amount: "100",
      allocations: [
        { categoryId: c1.id, amount: "60", source: "manual" },
        { categoryId: c2.id, amount: "40", source: "manual" },
      ],
    });
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    await prisma.$transaction(async (db) =>
      upsertModified(db, {
        transaction_id: tx.plaidTransactionId!,
        account_id: "x", amount: 100, date: "2026-05-19",
        pending: false, merchant_name: "Costco", name: "Costco",
        datetime: "2026-05-22T12:00:00Z",
      } as any, wsId),
    );
    const after = await prisma.transactionAllocation.findMany({
      where: { transactionId: txId }, orderBy: { amount: "desc" },
    });
    expect(after).toHaveLength(2);
    expect(after[0]!.categoryId).toBe(c1.id);
    expect(after[1]!.categoryId).toBe(c2.id);
  });

  it("upsertAdded fresh insert creates 1 null-cat allocation", async () => {
    // Skip — covered by existing sync tests once they're updated to assert
    // allocation presence. See Step 5 below.
  });
});
```

### Step 5: Update existing sync test assertions

In existing `apps/api/tests/plaid.sync.*.test.ts` files (find them with `ls apps/api/tests/plaid.sync*`), the happy-path tests that exercise `upsertAdded` should now also assert the allocation was created. Add `expect((await prisma.transactionAllocation.findMany({ where: { transactionId: created.id } })).length).toBe(1);` after the insertion assertions.

### Step 6: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/plaid.sync.unified-alloc.test.ts tests/plaid.sync.test.ts
```

(Replace `plaid.sync.test.ts` with whatever your existing sync test file is named — check `ls apps/api/tests/plaid.sync*` first.)

Expected: PASS.

### Step 7: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 8: Commit

```bash
git add apps/api/src/plaid/sync.ts \
        apps/api/tests/plaid.sync.unified-alloc.test.ts \
        apps/api/tests/plaid.sync.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): plaid sync — allocations writes + invalidation

upsertAdded fresh-insert creates 1 null-cat allocation. Promotion branch
(pending→posted) updates the existing single allocation's amount with a
paranoid length===1 check (cannot_split_pending blocks user splits, so
N MUST be 1 here; log + skip if not).

upsertModified branches per spec §5.4:
- N≥2 + amount or merchant changed → invalidate (delete allocations,
  create 1 null-cat row), set needsReclassification=true.
- N=1 + amount changed → update the single allocation's amount.
- Other cases → preserve allocations, update tx fields normally.

findFirst does NOT filter by removedAt (preserves today's updateMany
scope where soft-removed rows still receive sync updates).
EOF
)"
```

---

## Task 5: Extend `editTransactionService` + PATCH route

**Files:**
- Modify: `apps/api/src/transactions/edit.ts` (`EditTxInput`, `EditTxErrorCode`, validation, per-field source check)
- Modify: `apps/api/src/routes/transactions.ts` (PATCH body Zod schema + error mapping)
- Modify: `apps/api/tests/transactions.edit.service.test.ts` (new cases)
- Modify: `apps/api/tests/transactions.edit.route.test.ts` (new cases)

**Spec refs:** §4.1, §4.1.1, §5.5.

### Step 1: Extend `EditTxInput`, `EditTxResult`, `EditTxErrorCode`

In `apps/api/src/transactions/edit.ts`, update the exported types:

```ts
export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  note?: string | null;
  // NEW: single-category shortcut (mutually exclusive with allocations).
  categoryId?: string | null;
  // NEW: full allocations replacement.
  allocations?: Array<{ categoryId: string | null; amount: number }>;
};

// Type signal that the caller used the categoryId field (the route layer
// must set this when present so the service can validate exclusivity).
export type EditTxInputFlags = {
  categoryIdProvided?: boolean;
  allocationsProvided?: boolean;
  manualOnlyFieldProvided?: boolean;
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "cannot_split_pending"
  | "category_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note"
  | "invalid_allocation_amount"
  | "sum_mismatch"
  | "empty_allocations"
  | "conflicting_body";
```

Update `EditTxResult.transaction` shape to include `allocations` and `needsReclassification`:

```ts
export type EditTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: string | null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;             // mirror-write; dropped Task 8
    occurredAt: string;
    pending: boolean;
    source: "manual" | "plaid" | "csv";    // widen from "manual" — Plaid posted can PATCH allocations
    note: string | null;
    removedAt: null;
    needsReclassification: boolean;
    createdAt: string;
    updatedAt: string;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
  };
};
```

### Step 2: Update `editTransactionService` signature + body

The service signature changes — the route passes flags to disambiguate `note: null` from "note not provided":

```ts
export async function editTransactionService(
  ctx: { workspaceId: string },
  txId: string,
  input: EditTxInput,
  flags: EditTxInputFlags,
): Promise<EditTxResult>;
```

Inside the service:

1. **Conflicting body check**: if `flags.categoryIdProvided && flags.allocationsProvided` → throw `EditTxError("conflicting_body")`.

2. **Validate input fields** (amount/merchantRaw/occurredAt/note) using existing validators, rethrowing `TxValidationError` as `EditTxError`.

3. **Workspace read outside lock**:
```ts
const workspace = await prisma.workspace.findUniqueOrThrow({
  where: { id: ctx.workspaceId },
  select: { currency: true },
});
```

4. **Inside `withWorkspaceLock`**:
   - Read tx with allocations:
```ts
const row = await tx.transaction.findFirst({
  where: { id: txId, workspaceId: ctx.workspaceId },
  select: {
    id: true, accountId: true, plaidTransactionId: true, amount: true,
    merchantRaw: true, merchantNormalized: true, categoryId: true,
    occurredAt: true, pending: true, source: true, note: true,
    removedAt: true, needsReclassification: true, createdAt: true, updatedAt: true,
  },
});
if (!row) throw new EditTxError("not_found");
```

   - **Pre-check 2 (per-field source)**: use key presence:
```ts
if (flags.manualOnlyFieldProvided && row.source !== "manual") {
  throw new EditTxError("not_editable");
}
```

   - `removedAt !== null` → throw `already_removed`.

   - **`cannot_split_pending` gate** (only when allocations or categoryId provided):
```ts
const willWriteAllocations = flags.categoryIdProvided || flags.allocationsProvided;
if (willWriteAllocations && row.pending === true && row.plaidTransactionId !== null) {
  throw new EditTxError("cannot_split_pending");
}
```

   - **Build update payload** for tx fields (same as current edit.ts logic for amount/merchantRaw/occurredAt/note). KEEP existing logic that updates `categoryId` + `categorizationSource` directly for the categoryId-shortcut path (mirror-write). When `allocations` is provided, set `categoryId: null, categorizationSource: null` on tx mirror.

   - **Apply allocations** (if provided):
```ts
if (flags.allocationsProvided) {
  // Use the NEW amount if the same PATCH also changed amount; else current row.amount.
  const effectiveAmount = data.amount instanceof Prisma.Decimal ? data.amount : row.amount;
  try {
    await applyAllocations(
      tx, ctx.workspaceId, txId, effectiveAmount, "manual",
      input.allocations!,
    );
  } catch (e) {
    if (e instanceof AllocationError) {
      // Map AllocationError codes to EditTxError 1:1 (they overlap on the relevant codes).
      throw new EditTxError(e.code as EditTxErrorCode);
    }
    throw e;
  }
  // Mirror-write: clear tx.categoryId since the source of truth is allocations now.
  data.categoryId = null;
  data.categorizationSource = null;
}
if (flags.categoryIdProvided && !flags.allocationsProvided) {
  const effectiveAmount = data.amount instanceof Prisma.Decimal ? data.amount : row.amount;
  try {
    await applyAllocations(
      tx, ctx.workspaceId, txId, effectiveAmount, "manual",
      [{ categoryId: input.categoryId ?? null, amount: Number(effectiveAmount.toString()) }],
    );
  } catch (e) {
    if (e instanceof AllocationError) throw new EditTxError(e.code as EditTxErrorCode);
    throw e;
  }
  // Mirror-write tx.categoryId for compat (already set via the existing data.categoryId path).
}
```

   - Execute `tx.transaction.update` IF `Object.keys(data).length > 0`; else no-op return current shape.

5. **Read back allocations for response**:
```ts
const finalRow = await tx.transaction.findUniqueOrThrow({
  where: { id: txId },
  select: { /* TX_SELECT + needsReclassification + allocations(orderBy createdAt) */ },
});
return { transaction: shape(finalRow, workspace.currency) };
```

(Update `TX_SELECT` const at the top of edit.ts to include `needsReclassification` and `allocations: { select: { id, categoryId, amount, source }, orderBy: { createdAt: 'asc' } }`.)

Also import the new dependencies at the top:
```ts
import { applyAllocations, AllocationError } from "./allocations.js";
```

### Step 3: Update PATCH route handler

In `apps/api/src/routes/transactions.ts`, find the existing `PatchTxBody` schema and the PATCH handler.

Extend the Zod schema:

```ts
const PatchTxBody = z
  .object({
    amount: z.number().optional(),
    merchantRaw: z.string().optional(),
    occurredAt: z.string().optional(),
    note: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    allocations: z
      .array(z.object({
        categoryId: z.string().nullable(),
        amount: z.number(),
      }))
      .optional(),
  })
  .strict();
```

In the PATCH handler, compute flags from `req.body` BEFORE parsing into `input`. Note: `req.body` is `unknown`; cast safely after parse-success check:

```ts
const parsed = PatchTxBody.safeParse(req.body);
if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
const body = req.body as Record<string, unknown>;
const flags: EditTxInputFlags = {
  manualOnlyFieldProvided:
    "amount" in body || "merchantRaw" in body || "occurredAt" in body || "note" in body,
  categoryIdProvided: "categoryId" in body,
  allocationsProvided: "allocations" in body,
};

const d = parsed.data;
const input: EditTxInput = {};
if (d.amount       !== undefined) input.amount       = d.amount;
if (d.merchantRaw  !== undefined) input.merchantRaw  = d.merchantRaw;
if (d.occurredAt   !== undefined) input.occurredAt   = d.occurredAt;
if (d.note         !== undefined) input.note         = d.note;
if (flags.categoryIdProvided)     input.categoryId   = d.categoryId ?? null;
if (flags.allocationsProvided)    input.allocations  = d.allocations ?? [];

const result = await editTransactionService(
  { workspaceId: ctx.membership.workspaceId },
  req.params.txId,
  input,
  flags,
);
```

Update the error-status helper to handle the new codes:

```ts
function editTxErrorStatus(code: EditTxError["code"]): number {
  if (code === "not_found" || code === "category_not_found") return 404;
  return 400; // not_editable | already_removed | cannot_split_pending |
              // conflicting_body | sum_mismatch | empty_allocations | invalid_*
}
```

### Step 4: Add new tests to `transactions.edit.service.test.ts`

Append these tests after the existing ones:

```ts
it("happy: PATCH with allocations array (split) → DB has multiple alloc rows", async () => {
  const { wsId, userId } = await setupEditor("ea-split@t.co");
  const txId = await seedManual(wsId, userId);
  // Seed tx amount = 10 from seedManual; split into 4+6.
  const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-split" } });
  const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-split" } });
  const r = await editTransactionService(
    { workspaceId: wsId }, txId,
    { allocations: [{ categoryId: c1.id, amount: 4 }, { categoryId: c2.id, amount: 6 }] },
    { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
  );
  expect(r.transaction.allocations).toHaveLength(2);
});

it("happy: PATCH with categoryId shortcut writes single allocation = tx.amount", async () => {
  const { wsId, userId } = await setupEditor("ea-shortcut@t.co");
  const txId = await seedManual(wsId, userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-shortcut" } });
  const r = await editTransactionService(
    { workspaceId: wsId }, txId,
    { categoryId: cat.id },
    { categoryIdProvided: true, manualOnlyFieldProvided: false, allocationsProvided: false },
  );
  expect(r.transaction.allocations).toHaveLength(1);
  expect(r.transaction.allocations[0]!.categoryId).toBe(cat.id);
  expect(r.transaction.allocations[0]!.source).toBe("manual");
});

it("conflicting_body: both categoryId and allocations provided", async () => {
  const { wsId, userId } = await setupEditor("ea-conflict@t.co");
  const txId = await seedManual(wsId, userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-conf" } });
  await expect(
    editTransactionService(
      { workspaceId: wsId }, txId,
      { categoryId: cat.id, allocations: [{ categoryId: cat.id, amount: 10 }] },
      { categoryIdProvided: true, allocationsProvided: true, manualOnlyFieldProvided: false },
    ),
  ).rejects.toMatchObject({ code: "conflicting_body" });
});

it("empty_allocations: PATCH allocations: []", async () => {
  const { wsId, userId } = await setupEditor("ea-empty@t.co");
  const txId = await seedManual(wsId, userId);
  await expect(
    editTransactionService(
      { workspaceId: wsId }, txId,
      { allocations: [] },
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    ),
  ).rejects.toMatchObject({ code: "empty_allocations" });
});

it("sum_mismatch: allocations don't sum to tx.amount", async () => {
  const { wsId, userId } = await setupEditor("ea-summismatch@t.co");
  const txId = await seedManual(wsId, userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-sum" } });
  await expect(
    editTransactionService(
      { workspaceId: wsId }, txId,
      { allocations: [{ categoryId: cat.id, amount: 5 }] },  // tx.amount = 10
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    ),
  ).rejects.toMatchObject({ code: "sum_mismatch" });
});

it("sum tracks new amount when PATCH also changes amount", async () => {
  const { wsId, userId } = await setupEditor("ea-newamount@t.co");
  const txId = await seedManual(wsId, userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-newamt" } });
  const r = await editTransactionService(
    { workspaceId: wsId }, txId,
    { amount: 25, allocations: [{ categoryId: cat.id, amount: 25 }] },
    { allocationsProvided: true, manualOnlyFieldProvided: true, categoryIdProvided: false },
  );
  expect(r.transaction.amount).toBe("25");
  expect(r.transaction.allocations[0]!.amount).toBe("25");
});

it("cannot_split_pending: PATCH allocations on pending Plaid tx", async () => {
  const { wsId } = await setupEditor("ea-pending@t.co");
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_pending",
      amount: "10", merchantRaw: "X", merchantNormalized: "x",
      occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
    },
  });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-pending" } });
  await expect(
    editTransactionService(
      { workspaceId: wsId }, tx.id,
      { allocations: [{ categoryId: cat.id, amount: 10 }] },
      { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
    ),
  ).rejects.toMatchObject({ code: "cannot_split_pending" });
});

it("Plaid posted tx accepts allocations-only PATCH", async () => {
  const { wsId } = await setupEditor("ea-plaidposted@t.co");
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted",
      amount: "10", merchantRaw: "X", merchantNormalized: "x",
      occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
    },
  });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-posted" } });
  const r = await editTransactionService(
    { workspaceId: wsId }, tx.id,
    { allocations: [{ categoryId: cat.id, amount: 10 }] },
    { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
  );
  expect(r.transaction.allocations).toHaveLength(1);
});

it("Plaid posted tx rejects amount edit (per-field rule)", async () => {
  const { wsId } = await setupEditor("ea-plaidamt@t.co");
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted2",
      amount: "10", merchantRaw: "X", merchantNormalized: "x",
      occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
    },
  });
  await expect(
    editTransactionService(
      { workspaceId: wsId }, tx.id,
      { amount: 20 },
      { manualOnlyFieldProvided: true, allocationsProvided: false, categoryIdProvided: false },
    ),
  ).rejects.toMatchObject({ code: "not_editable" });
});

it("Plaid posted tx rejects note:null edit (per-field key-presence rule)", async () => {
  const { wsId } = await setupEditor("ea-plaidnote@t.co");
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_posted3",
      amount: "10", merchantRaw: "X", merchantNormalized: "x",
      occurredAt: new Date(), pending: false, source: "plaid", rawData: {},
    },
  });
  await expect(
    editTransactionService(
      { workspaceId: wsId }, tx.id,
      { note: null },
      { manualOnlyFieldProvided: true, allocationsProvided: false, categoryIdProvided: false },
    ),
  ).rejects.toMatchObject({ code: "not_editable" });
});

it("PATCH allocations clears needsReclassification flag", async () => {
  const { wsId, userId } = await setupEditor("ea-needsrc@t.co");
  const txId = await seedManual(wsId, userId);
  await prisma.transaction.update({
    where: { id: txId }, data: { needsReclassification: true },
  });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-needsrc" } });
  await editTransactionService(
    { workspaceId: wsId }, txId,
    { allocations: [{ categoryId: cat.id, amount: 10 }] },
    { allocationsProvided: true, manualOnlyFieldProvided: false, categoryIdProvided: false },
  );
  const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
  expect(row.needsReclassification).toBe(false);
});
```

Note: existing service tests that call `editTransactionService(ctx, txId, input)` (without flags) will fail to compile because of the new required `flags` argument. Update those callers to pass `flags`, deriving via KEY PRESENCE (matching the spec §4.1.1 rule — so `note: null` is correctly classified as a manual-only edit):

```ts
// At each existing test call site:
{
  manualOnlyFieldProvided: "amount" in input || "merchantRaw" in input
                        || "occurredAt" in input || "note" in input,
  categoryIdProvided: "categoryId" in input,
  allocationsProvided: "allocations" in input,
}
```

This matches the route handler's flag derivation in Step 3 (also `in body`).

### Step 5: Add new route tests to `transactions.edit.route.test.ts`

Append:

```ts
it("PATCH with allocations array → 200, response.allocations matches", async () => {
  const { cookie, wsId } = await setupEditor("ep-alloc@t.co");
  const txId = await seedManual(cookie, wsId);
  const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ep-alloc" } });
  const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ep-alloc" } });
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${wsId}/transactions/${txId}`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({
      allocations: [
        { categoryId: c1.id, amount: 4 },
        { categoryId: c2.id, amount: 6 },
      ],
    }),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().transaction.allocations).toHaveLength(2);
});

it("PATCH categoryId shortcut → response has 1 allocation", async () => {
  const { cookie, wsId } = await setupEditor("ep-shortcut@t.co");
  const txId = await seedManual(cookie, wsId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-shortcut" } });
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${wsId}/transactions/${txId}`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ categoryId: cat.id }),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().transaction.allocations).toHaveLength(1);
  expect(res.json().transaction.allocations[0].categoryId).toBe(cat.id);
});

it("PATCH both categoryId and allocations → 400 conflicting_body", async () => {
  const { cookie, wsId } = await setupEditor("ep-conflict@t.co");
  const txId = await seedManual(cookie, wsId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-conf" } });
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${wsId}/transactions/${txId}`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({
      categoryId: cat.id,
      allocations: [{ categoryId: cat.id, amount: 10 }],
    }),
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("conflicting_body");
});

it("PATCH allocations sum mismatch → 400 sum_mismatch", async () => {
  const { cookie, wsId } = await setupEditor("ep-sum@t.co");
  const txId = await seedManual(cookie, wsId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-sum" } });
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${wsId}/transactions/${txId}`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ allocations: [{ categoryId: cat.id, amount: 5 }] }),
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("sum_mismatch");
});

it("PATCH allocations on pending Plaid → 400 cannot_split_pending", async () => {
  const { cookie, wsId } = await setupEditor("ep-pending@t.co");
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_ep_pending",
      amount: "10", merchantRaw: "X", merchantNormalized: "x",
      occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
    },
  });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-pending" } });
  const res = await app.inject({
    method: "PATCH",
    url: `/workspaces/${wsId}/transactions/${tx.id}`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ allocations: [{ categoryId: cat.id, amount: 10 }] }),
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("cannot_split_pending");
});
```

### Step 6: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.service.test.ts tests/transactions.edit.route.test.ts
```

Expected: PASS (existing + new).

### Step 7: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 8: Commit

```bash
git add apps/api/src/transactions/edit.ts \
        apps/api/src/routes/transactions.ts \
        apps/api/tests/transactions.edit.service.test.ts \
        apps/api/tests/transactions.edit.route.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): PATCH allocations + per-field source check

editTransactionService accepts categoryId (shortcut) or allocations
(full replace) — mutually exclusive (conflicting_body). Per-field
source check uses key presence semantics so note:null on a Plaid
posted tx still triggers not_editable; allocations/categoryId-only
PATCH succeeds on posted Plaid (cannot_split_pending blocks pending).

PATCH body Zod schema gains allocations array (.strict() still rejects
unknown keys). Route handler derives EditTxInputFlags from req.body
key presence before parse-cast — required to distinguish "field
omitted" from "field present with null/empty value".

Error mapping: conflicting_body | sum_mismatch | empty_allocations |
cannot_split_pending | invalid_allocation_amount all → 400.
EOF
)"
```

---

## Task 6: Refactor read paths — budget service + chat tools group A

**Files:**
- Modify: `apps/api/src/budgets/service.ts` (compareSpendingVsBudget)
- Modify: `apps/api/src/chat/tools/get-category-breakdown.ts`
- Modify: `apps/api/src/chat/tools/get-spending-summary.ts`
- Modify: `apps/api/src/chat/tools/compare-spending-periods.ts`
- Modify: `apps/api/src/chat/tools/find-uncategorized-transactions.ts`
- Modify: `apps/api/src/chat/tools/find-transactions.ts`
- Modify matching test files

**Spec refs:** §5.1.1, §5.1.2, §7.

### Step 1: Budget service

In `apps/api/src/budgets/service.ts`, find `compareSpendingVsBudgetService`. The current `groupBy` on `prisma.transaction` by `categoryId`. Replace with allocations-based query:

```ts
const sums = await prisma.transactionAllocation.groupBy({
  by: ["categoryId"],
  where: {
    categoryId: { in: budgetCategoryIds },
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
```

The downstream `spentByCat` Map construction stays the same.

### Step 2: Chat tools group A

Each chat tool's category-aware query needs the same shift. Concrete examples:

**`get-category-breakdown.ts`** — find the `prisma.transaction.groupBy({ by: ["categoryId"], ... })` call. Replace with the `transactionAllocation.groupBy` pattern:

```ts
const sums = await prisma.transactionAllocation.groupBy({
  by: ["categoryId"],
  where: {
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
```

Then JOIN to fetch category names by id. The shape returned to the LLM should preserve today's: `[{ categoryId, categoryName, total }, ...]`. Null-categoryId rows (uncategorized) appear as a single entry — keep or skip per existing behavior.

**`get-spending-summary.ts`** — similar pattern.

**`compare-spending-periods.ts`** — uses groupBy across two periods; convert both to allocations groupBy.

**`find-uncategorized-transactions.ts`** — replace `categoryId: null` filter with:

```ts
// Mode 'uncategorized':
const where = {
  workspaceId: ctx.workspaceId,
  removedAt: null,
  allocations: { some: { categoryId: null } },
};

// Mode 'not_manual' (per spec §5.1.2):
const where = {
  workspaceId: ctx.workspaceId,
  removedAt: null,
  allocations: {
    some: {
      OR: [
        { source: { not: "manual" } },
        { categoryId: null },
      ],
    },
  },
};
```

Use whichever existing variable holds the mode (look at the current arg parsing).

**`find-transactions.ts`** — the existing filter resolves category names to a `categoryIds` array, then uses `categoryId: { in: categoryIds }` (around line 176). Replace with allocations predicate preserving the `in` semantics:

```ts
where: {
  workspaceId: ctx.workspaceId,
  removedAt: null,
  // ... other filters ...
  allocations: { some: { categoryId: { in: categoryIds } } },
}
```

Single-category and multi-category lookups both flow through this same pattern (`in` with a one-element array is fine).

### Step 3: Update each tool's test

For each refactored tool, the matching test in `apps/api/tests/chat.tools.<tool>.test.ts` should still pass because the mirror-write keeps `tx.categoryId` matching `allocations[0].categoryId` for the N=1 case. Run them all and verify; if any explicit assertion needs updating to "look at allocations", do so.

### Step 4: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts \
  tests/budgets.service.test.ts \
  tests/chat.tools.get-category-breakdown.test.ts \
  tests/chat.tools.get-spending-summary.test.ts \
  tests/chat.tools.compare-spending-periods.test.ts \
  tests/chat.tools.find-uncategorized-transactions.test.ts \
  tests/chat.tools.find-transactions.test.ts
```

Expected: all PASS. Add a new test in `budgets.service.test.ts` that exercises a SPLIT tx (manually inserted with 2 allocations) and verifies both categories appear correctly in the breakdown:

```ts
it("split tx allocates across multiple budget categories", async () => {
  // ... setup workspace, two categories with budgets, one tx split across both ...
  const acct = await prisma.bankAccount.create({ data: { workspaceId, name: "A", type: "depository" } });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId, accountId: acct.id,
      plaidTransactionId: null,
      amount: "200", merchantRaw: "Costco", merchantNormalized: "costco",
      occurredAt: new Date("2026-05-15T12:00:00Z"),
      pending: false, source: "manual", rawData: {},
    },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: [
      { transactionId: tx.id, categoryId: groceriesCat.id, amount: "120", source: "manual" },
      { transactionId: tx.id, categoryId: householdCat.id, amount: "80", source: "manual" },
    ],
  });

  const result = await compareSpendingVsBudgetService(
    { workspaceId, userId },
    { period: "this_month" },
  );
  const g = result.items.find((i) => i.categoryId === groceriesCat.id)!;
  const h = result.items.find((i) => i.categoryId === householdCat.id)!;
  expect(g.spent).toBe("120.00");
  expect(h.spent).toBe("80.00");
});
```

### Step 5: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 6: Commit

```bash
git add apps/api/src/budgets/service.ts \
        apps/api/src/chat/tools/get-category-breakdown.ts \
        apps/api/src/chat/tools/get-spending-summary.ts \
        apps/api/src/chat/tools/compare-spending-periods.ts \
        apps/api/src/chat/tools/find-uncategorized-transactions.ts \
        apps/api/src/chat/tools/find-transactions.ts \
        apps/api/tests/budgets.service.test.ts \
        apps/api/tests/chat.tools.*.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): read paths — budget + chat tools group A

Budget service groupBy now on TransactionAllocation.categoryId with
nested transaction filter for workspace/period/removedAt. Chat tools
that aggregate by category (get-category-breakdown, get-spending-summary,
compare-spending-periods) follow the same pattern. Filters for
category (find-transactions) and uncategorized (find-uncategorized-
transactions, both modes) use allocation-side predicates.

Split tx are correctly attributed across budget categories — covered
by a new test in budgets.service.test.ts.
EOF
)"
```

---

## Task 7: Read paths group B + GET response shape

**Files:**
- Modify: `apps/api/src/chat/tools/list-transactions.ts`
- Modify: `apps/api/src/chat/tools/get-transaction-details.ts`
- Modify: `apps/api/src/chat/tools/categorize-transaction.ts` (result shape only)
- Modify: `apps/api/src/routes/transactions.ts` (GET response shape)
- Modify: corresponding test files

**Spec refs:** §4.4, §5.1.1.

### Step 1: GET `/transactions` response shape

In `apps/api/src/routes/transactions.ts`, find the GET handler. Update the response mapping to include `allocations` and `needsReclassification`. Use Prisma `include` to fetch allocations alongside the tx page:

```ts
const rows = await prisma.transaction.findMany({
  where,
  orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  take: q.limit + 1,
  include: {
    allocations: {
      select: { id: true, categoryId: true, amount: true, source: true },
      orderBy: { createdAt: "asc" },
    },
  },
});
// ... existing pagination logic ...
return {
  transactions: page.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    plaidTransactionId: t.plaidTransactionId,
    amount: t.amount.toString(),
    currency: workspace.currency,
    merchantRaw: t.merchantRaw,
    merchantNormalized: t.merchantNormalized,
    categoryId: t.categoryId,                       // mirror; dropped Task 8
    occurredAt: t.occurredAt.toISOString(),
    postedAt: t.postedAt?.toISOString() ?? null,
    pending: t.pending,
    source: t.source,
    note: t.note,
    removedAt: t.removedAt?.toISOString() ?? null,
    needsReclassification: t.needsReclassification,
    allocations: t.allocations.map((a) => ({
      id: a.id,
      categoryId: a.categoryId,
      amount: a.amount.toString(),
      source: a.source,
    })),
  })),
  nextCursor,
};
```

Update the `categoryId` query filter to use allocation predicate:

```ts
const where = {
  workspaceId: ctx.membership.workspaceId,
  ...(q.accountId ? { accountId: q.accountId } : {}),
  // ... date range as before ...
  ...(q.includeRemoved ? {} : { removedAt: null }),
  ...(q.uncategorizedOnly
    ? { allocations: { some: { categoryId: null } } }
    : {}),
  ...(q.categoryId
    ? { allocations: { some: { categoryId: q.categoryId } } }
    : {}),
  // ... cursor logic as before ...
};
```

Note: the existing QuerySchema has `categoryId` as undefined unless explicitly supported. If your current code doesn't have a `?categoryId=` filter, add it to the schema:

```ts
const QuerySchema = z.object({
  // ... existing fields ...
  categoryId: z.string().optional(),
});
```

### Step 2: `list-transactions.ts` chat tool

Mirror the GET pattern. Include allocations in the response, drop top-level categoryId if currently returned. Match local conventions.

### Step 3: `get-transaction-details.ts`

Include allocations array in the tool result. Drop top-level categoryId.

### Step 4: `categorize-transaction.ts` (chat tool wrapping `applyManualCategorize`)

The tool's `Result` type currently references `ManualCategorizeResult["tx"]`. Since that shape was updated in Task 2, no code change here — just verify the tool compiles after Task 2. Optionally add a test that the tool result contains an `allocations` array.

### Step 5: Update tests

For each tool, update tests to:
- Assert `allocations` in the tool result.
- Where today's test asserts `t.categoryId === X`, also assert `t.allocations[0].categoryId === X` for N=1 cases.
- Add at least one test per tool that exercises a split tx (N=2) returning both allocations.

### Step 5b: Create new GET route test file

The existing test files cover PATCH (`transactions.edit.route.test.ts`) and POST manual create. There is **no test file for the GET `/transactions` endpoint** — the route's response shape change here is otherwise untested.

Create `apps/api/tests/transactions.list.route.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedTxWithAllocations(
  wsId: string,
  amount: string,
  allocs: Array<{ categoryId: string | null; amount: string; source: "manual" | null }>,
): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Test", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: null,
      amount, merchantRaw: "Test", merchantNormalized: "test",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false, source: "manual", rawData: {},
    },
  });
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.createMany({
    data: allocs.map((a) => ({
      transactionId: tx.id,
      categoryId: a.categoryId,
      amount: a.amount,
      source: a.source,
    })),
  });
  return tx.id;
}

describe("GET /workspaces/:id/transactions", () => {
  it("response includes allocations array and needsReclassification per tx", async () => {
    const { cookie, wsId } = await setup("tl1@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-tl1" } });
    await seedTxWithAllocations(wsId, "20", [{ categoryId: cat.id, amount: "20", source: "manual" }]);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].allocations).toHaveLength(1);
    expect(body.transactions[0].allocations[0].categoryId).toBe(cat.id);
    expect(body.transactions[0].needsReclassification).toBe(false);
  });

  it("split tx returns multiple allocations", async () => {
    const { cookie, wsId } = await setup("tl2@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-tl2" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-tl2" } });
    await seedTxWithAllocations(wsId, "100", [
      { categoryId: c1.id, amount: "60", source: "manual" },
      { categoryId: c2.id, amount: "40", source: "manual" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions[0].allocations).toHaveLength(2);
  });

  it("filter ?categoryId=X matches via allocation predicate (incl. split tx)", async () => {
    const { cookie, wsId } = await setup("tl3@t.co");
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-tl3" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-tl3" } });
    // Single-category tx
    await seedTxWithAllocations(wsId, "10", [{ categoryId: c1.id, amount: "10", source: "manual" }]);
    // Split tx (c1+c2)
    await seedTxWithAllocations(wsId, "20", [
      { categoryId: c1.id, amount: "5", source: "manual" },
      { categoryId: c2.id, amount: "15", source: "manual" },
    ]);
    // Unrelated tx
    await seedTxWithAllocations(wsId, "5", [{ categoryId: c2.id, amount: "5", source: "manual" }]);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?categoryId=${c1.id}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions).toHaveLength(2); // single c1 + split c1+c2
  });

  it("filter ?uncategorizedOnly=true matches tx with ≥1 null-cat allocation", async () => {
    const { cookie, wsId } = await setup("tl4@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-tl4" } });
    await seedTxWithAllocations(wsId, "10", [{ categoryId: null, amount: "10", source: null }]);
    await seedTxWithAllocations(wsId, "20", [{ categoryId: cat.id, amount: "20", source: "manual" }]);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].allocations[0].categoryId).toBeNull();
  });
});
```

### Step 6: Run targeted tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts \
  tests/chat.tools.list-transactions.test.ts \
  tests/chat.tools.get-transaction-details.test.ts \
  tests/chat.tools.categorize-transaction.test.ts \
  tests/transactions.list.route.test.ts
```

Expected: PASS.

### Step 7: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 8: Commit

```bash
git add apps/api/src/chat/tools/list-transactions.ts \
        apps/api/src/chat/tools/get-transaction-details.ts \
        apps/api/src/chat/tools/categorize-transaction.ts \
        apps/api/src/routes/transactions.ts \
        apps/api/tests/chat.tools.list-transactions.test.ts \
        apps/api/tests/chat.tools.get-transaction-details.test.ts \
        apps/api/tests/chat.tools.categorize-transaction.test.ts \
        apps/api/tests/transactions.list.route.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): read paths — chat tools group B + GET response

GET /workspaces/:id/transactions response now includes allocations
array and needsReclassification flag per tx. ?categoryId=X filter
matches via allocations predicate; same for ?uncategorizedOnly=true.
list-transactions and get-transaction-details chat tools return the
same shape. categorize-transaction tool inherits the updated
ManualCategorizeResult shape from Task 2.

All read paths now see split tx correctly: each allocation appears
as its own row in category breakdowns.
EOF
)"
```

---

## Task 8: Migration B — drop legacy columns + remove mirror writes

**Files:**
- Create: `apps/api/prisma/migrations/<ts>_drop_legacy_categoryId/migration.sql`
- Modify: `apps/api/prisma/schema.prisma` (remove `Transaction.categoryId`, `Transaction.categorizationSource`, `Transaction.category` relation, `Category.transactions` relation, `@@index([workspaceId, categoryId])`)
- Modify: `apps/api/src/transactions/create-manual.ts` (drop mirror-write + drop `categoryId` from response)
- Modify: `apps/api/src/transactions/edit.ts` (drop mirror-write + drop `categoryId` from response)
- Modify: `apps/api/src/categorize/manual-categorize.ts` (drop mirror-write + drop `categoryId`/`categorizationSource` from result)
- Modify: `apps/api/src/categorize/service.ts` (drop mirror-write)
- Modify: `apps/api/src/categorize/map-merchant.ts` (drop mirror-write)
- Modify: `apps/api/src/plaid/sync.ts` (drop categoryId/categorizationSource from updateMany/update data)
- Modify: `apps/api/src/routes/transactions.ts` (drop categoryId from GET response)
- Modify: `apps/api/src/chat/tools/find-transactions.ts` (drop `categorizationSource` from result type + response, drop `tx.categoryId` field if present)
- Modify: `apps/api/src/chat/tools/get-transaction-details.ts` (drop `categorizationSource` + top-level `categoryId` from result; rely on `allocations`)
- Modify: `apps/api/src/chat/tools/find-uncategorized-transactions.ts` (drop `categorizationSource` from result type + response)
- Modify: `apps/api/src/chat/tools/list-transactions.ts` (drop top-level `categoryId`/`categorizationSource` if present)
- Modify: all corresponding test files (drop assertions on the dropped fields)

**Spec refs:** §3.2, §3.4 (final drop), §10 reviewer checklist line 762.

### Step 1: Update schema

Edit `apps/api/prisma/schema.prisma`:

In `Transaction` (line 270):
- Remove `categoryId String?`
- Remove `categorizationSource CategorizationSource?`
- Remove `category Category? @relation(...)`
- Remove `@@index([workspaceId, categoryId])`

In `Category` (line 312):
- Remove `transactions Transaction[]` relation

### Step 2: Create Migration B

Create `apps/api/prisma/migrations/<ts>_drop_legacy_categoryId/migration.sql`:

```sql
-- Sanity guard: every tx still must have at least one allocation summing to tx.amount
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM (
    SELECT t."id", t."amount" AS tx_amount, COALESCE(SUM(a."amount"), 0) AS alloc_sum
    FROM "transactions" t
    LEFT JOIN "transaction_allocations" a ON a."transactionId" = t."id"
    GROUP BY t."id", t."amount"
  ) s
  WHERE s.alloc_sum <> s.tx_amount;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Allocation invariant broken: % rows have sum(allocations.amount) != tx.amount. Aborting migration B.', bad_count;
  END IF;
END $$;

-- Drop the column FK first (Prisma created it as transactions_categoryId_fkey)
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_categoryId_fkey";
DROP INDEX IF EXISTS "transactions_workspaceId_categoryId_idx";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "categoryId";
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "categorizationSource";
```

Run via:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate dev --create-only --name drop_legacy_categoryId
```

If the manual creation route is needed (subagent shell limitations), name the migration directory with the timestamp pattern `<YYYYMMDDHHMMSS>_drop_legacy_categoryId` to match Prisma's convention.

Apply:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma generate
```

### Step 3: Remove mirror-writes from services

This is the big sweep. Each service that wrote `tx.categoryId` or `categorizationSource` must stop. Removal sites:

**`create-manual.ts`:**
- In the `tx.transaction.create({ data: {...} })` call, ensure `categoryId` and `categorizationSource` are NOT in the data object. Today they aren't set explicitly there (manual tx is created uncategorized), so no change beyond removing from response — search for them in the response construction and delete.

**`edit.ts`:**
- In the `data: Prisma.TransactionUncheckedUpdateInput` building block, remove any `data.categoryId` / `data.categorizationSource` assignments — these existed in the categoryId shortcut path.

**`manual-categorize.ts`:**
- In both the target `tx.transaction.update` and the sibling back-fill update, remove `categoryId: ...` and `categorizationSource: ...` from the data field.
- Update `ManualCategorizeResult.tx` to drop `categoryId` and `categorizationSource` (now redundant with allocations).
- Final post-lock read: drop `categoryId: true, categorizationSource: true` from `select`.

**`categorize/service.ts`:**
- Remove the mirror-write `prisma.transaction.update(...)` calls after each allocation update (both Step 2 mapping and Step 3 Gemini).

**`categorize/map-merchant.ts`:**
- Remove the mirror-write `prisma.transaction.update(...)` calls.

**`plaid/sync.ts`:**
- In `upsertModified` invalidation branch, remove `categoryId: null, categorizationSource: null` from the data field.
- In `upsertAdded` and promotion branches, check there are no lingering categoryId references.

### Step 4: Update response shapes — services + route

**`create-manual.ts`**: drop `categoryId: string | null` from `CreateManualTxResult.transaction`. Drop the field from the response construction.

**`edit.ts`**: drop `categoryId: string | null` from `EditTxResult.transaction`. Drop from `TX_SELECT`. Drop from `shape()` helper.

**`routes/transactions.ts`** GET handler: drop `categoryId` from response item construction.

**`manual-categorize.ts`**: drop `categoryId` and `categorizationSource` from `ManualCategorizeResult.tx`. Drop from the post-lock final read `select` and from the response builder.

### Step 4b: Update chat tool response shapes

Several chat tools today expose `tx.categoryId` and/or `tx.categorizationSource` in their tool result. Drop these references; rely on `tx.allocations` as the sole category surface:

- **`apps/api/src/chat/tools/find-transactions.ts`** (lines ~70-72, ~229-231 today): drop `categorizationSource` from `Result` type AND from the per-tx response mapping. If `categoryId` appears at the tx top level, drop it too.
- **`apps/api/src/chat/tools/get-transaction-details.ts`** (lines ~26, ~83 today): drop `categoryId` and `categorizationSource` from `Result.tx` type; drop from response builder. `tx.allocations` already includes per-allocation `categoryId` + `source`.
- **`apps/api/src/chat/tools/find-uncategorized-transactions.ts`** (lines ~41, ~93 today): drop `categorizationSource` from `Result` type + response.
- **`apps/api/src/chat/tools/list-transactions.ts`**: same — drop any top-level `categoryId`/`categorizationSource` from `Result` and response. (Allocations array already added in Task 7.)

For each tool, verify with `grep -n "categoryId\|categorizationSource" apps/api/src/chat/tools/<file>.ts` that no lingering references remain post-edit.

### Step 5: Update tests

Across all test files, remove assertions on the dropped fields:

```bash
grep -rln "categorizationSource\|t\.categoryId\|\.categoryId\s*===\s*" apps/api/tests/
```

For each file, replace top-level `t.categoryId === X` assertions with `t.allocations[0].categoryId === X` (for N=1) or appropriate split-tx assertion. Drop assertions on `categorizationSource` — that data lives on the allocation now.

### Step 6: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS. If anything fails, it's most likely a test still asserting on `categoryId` / `categorizationSource` at the tx level — fix per Step 5.

### Step 7: Commit

```bash
git add apps/api/prisma/schema.prisma \
        apps/api/prisma/migrations/ \
        apps/api/src/transactions/ \
        apps/api/src/categorize/ \
        apps/api/src/plaid/sync.ts \
        apps/api/src/routes/transactions.ts \
        apps/api/tests/
git commit -m "$(cat <<'EOF'
feat(plan 1c-split-transaction): migration B + drop mirror writes

Drop Transaction.categoryId, Transaction.categorizationSource, the
@@index([workspaceId, categoryId]), and Transaction.category /
Category.transactions relations. Allocations is now the single source
of truth for tx→category attribution.

Migration B includes a DO-block sanity guard that fails if any tx still
has a sum mismatch (defense against state corruption since Migration A).

All services stop mirror-writing the dropped columns. Response shapes
on create-manual, edit, manual-categorize, list-transactions,
get-transaction-details, GET /transactions, and the auto-categorize /
map-merchant code paths are unified: allocations array is the only
category attribution surface.
EOF
)"
```

---

## Task 9: Smoke test doc

**Files:**
- Create: `docs/superpowers/smoke-tests/2026-05-19-plan-1c-split-transaction.md`

**Spec refs:** §8.10.

- [ ] **Step 1: Create the smoke doc**

````markdown
# Smoke Test — Plan 1C-split-transaction

**Goal:** validate the unified allocations model end-to-end against a
running local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$TX`, `$CAT` below.

## Setup — create a manual tx (no category)

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchantRaw":"Costco","amount":200,"occurredAt":"2026-05-19"}'
```

Expected: 200, response includes `allocations: [{categoryId: null, amount: "200", source: null}]`, no top-level `categoryId`.
Capture `transaction.id` → `$TX`.

## 1. Create three categories

```bash
for n in Groceries Electronics Household; do
  curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
    -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
    -d "{\"name\":\"$n\"}"
done
```

Capture each category id → `$G`, `$E`, `$H`.

## 2. PATCH with categoryId shortcut

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 200, `transaction.allocations` has 1 entry with `categoryId === $G`, `amount === "200"`, `source === "manual"`.

## 3. PATCH split — 3 allocations summing to 200

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":120},{\"categoryId\":\"$E\",\"amount\":50},{\"categoryId\":\"$H\",\"amount\":30}]}"
```

Expected: 200, `transaction.allocations` has 3 entries summing to 200.

## 4. PATCH back to single via shortcut

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 200, allocations replaced with 1 entry covering full 200.

## 5. PATCH sum_mismatch

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":100}]}"
```

Expected: 400, `error === "sum_mismatch"`.

## 6. PATCH conflicting_body

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\",\"allocations\":[{\"categoryId\":\"$G\",\"amount\":200}]}"
```

Expected: 400, `error === "conflicting_body"`.

## 7. PATCH amount and allocations atomically

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":250,\"allocations\":[{\"categoryId\":\"$G\",\"amount\":150},{\"categoryId\":\"$E\",\"amount\":100}]}"
```

Expected: 200, `transaction.amount === "250"`, allocations sum to 250.

## 8. PATCH on Plaid pending tx (if available)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$PENDING_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 400, `error === "cannot_split_pending"`.

## 9. PATCH on Plaid posted tx with allocations

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$POSTED_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":<plaid_tx_amount>}]}"
```

Expected: 200 (per-field rule allows allocations on posted Plaid).

## 10. PATCH on Plaid posted tx with amount (per-field rule rejects)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$POSTED_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":99.99}"
```

Expected: 400, `error === "not_editable"`.

## 11. GET tx — verify response shape

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?from=2026-05-01&to=2026-05-31" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions[] | select(.id=="'"$TX"'") | {allocations,needsReclassification}'
```

Expected: each tx has `allocations` array and `needsReclassification` boolean; NO top-level `categoryId`.

## 12. GET filter by category

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?categoryId=$G" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions | length'
```

Expected: count includes split tx attributed to $G AND single-category tx where $G is the only allocation.

## Result

Record a PASS/FAIL for each of the 12 steps. All PASS = ship.
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/smoke-tests/2026-05-19-plan-1c-split-transaction.md
git commit -m "$(cat <<'EOF'
docs(plan 1c-split-transaction): smoke test doc

Twelve curl-based steps covering: manual tx create with allocations
shape, categoryId shortcut, split PATCH, sum_mismatch, conflicting_body,
amount+allocations atomic update, cannot_split_pending (Plaid pending),
per-field rule (Plaid posted accepts allocations but rejects amount),
GET shape, ?categoryId= filter via allocations.
EOF
)"
```

---

## Plan Self-Review

**Spec coverage check** (§-by-§ against the spec):

| Spec section | Implemented in |
|---|---|
| §1 Goal / out of scope | Tasks 1-8 implement; out-of-scope (UI, chat splitTransaction tool, HTTP audit log) NOT touched by any task |
| §2 Decisions table | Mapped row-by-row across all tasks |
| §3.1 New table + composite index | Task 1 Steps 1-2 |
| §3.2 Transaction model changes (drop categoryId/categorizationSource, add needsReclassification + allocations relation) | Phased: Task 1 adds new fields; Task 8 drops legacy |
| §3.3 Category model | Phased: Task 1 adds new relation; Task 8 drops `transactions` relation |
| §3.4 Migration SQL | Phased: Migration A in Task 1; Migration B in Task 8 (DO-block safety guard in both) |
| §4.1 PATCH endpoint (new fields, conflicting_body, sum_mismatch, cannot_split_pending) | Task 5 |
| §4.1.1 Per-field source check (key presence) | Task 5 Step 2 |
| §4.1.2 PATCH response shape | Task 5 + Task 8 (drop categoryId mirror) |
| §4.2 DELETE — unchanged | (no task needed) |
| §4.3 Categorize endpoint behavior change (works on split tx, response shape includes allocations) | Task 2 (service) + Task 7 (chat tool shape) |
| §4.4 GET allocations + filter | Task 7 Step 1 |
| §5.1 File list | Each row maps to a task as documented |
| §5.1.1 Chat tools list | Task 6 (group A) + Task 7 (group B) |
| §5.1.2 find-uncategorized-transactions modes | Task 6 Step 2 |
| §5.2 applyAllocations helper signature + behavior | Task 1 Step 7 |
| §5.3 Locking decisions | Tasks 2-5 use withWorkspaceLock; Tasks 3 / 6 / 7 use per-row atomic (no lock) per §5.3 |
| §5.4 Plaid sync (upsertModified + promotion) | Task 4 |
| §5.5 Service signatures | Task 2 (CreateManualTxResult) + Task 5 (EditTx*) |
| §6.1 Auto-categorize per-row atomic | Task 3 Steps 1-2 |
| §6.2 Map-merchant per-row atomic | Task 3 Step 3 |
| §6.3 applyManualCategorize sibling back-fill | Task 2 Step 2 |
| §7 Budget query | Task 6 Step 1 |
| §8.1-8.10 Testing strategy | Each task's test step covers the matching spec test section |
| §9 Migration & rollout | Two-phase (Tasks 1 + 8) deviation documented in plan header |
| §10 Reviewer checklist | All items map to specific task assertions or commit messages |

**Placeholder scan:** no "TBD" / "TODO" / "fill in" — every code block is concrete. The instruction "Replace `plaid.sync.test.ts` with whatever your existing sync test file is named — check `ls apps/api/tests/plaid.sync*` first" is an unavoidable runtime discovery; the subagent has the exact command.

**Type consistency:**
- `AllocationInput` (Task 1) shape matches the body schema in Task 5 PATCH (`{ categoryId: string | null, amount: number }`).
- `AllocationSource = "manual" | "mapping" | "ai" | null` consistent across `applyAllocations` (Task 1), `Plaid sync` (Task 4 — uses `null` on insert/invalidation), and `applyManualCategorize` (Task 2 — uses `"manual"`).
- `EditTxInputFlags` (Task 5) is used in service + route + service tests — all match.
- `EditTxErrorCode` union (Task 5) covers all error paths from `applyAllocations` (Task 1) via direct mapping in `editTransactionService`.
- `ManualCategorizeResult.tx` shape (Task 2) is unified after Task 8 drops the deprecated fields.
- `Prisma.Decimal` is used consistently for amounts; `toString()` for serialization; the helper validates against string regex.

No issues found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-plan-1c-split-transaction.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec + quality) between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints for review.

Which approach?
