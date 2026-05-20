# Plan 1C-scheduled-spend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-20-plan-1c-scheduled-spend-design.md` (commit `f4d11cd` or later).

**Goal:** Add `ScheduledSpend` — category-only, single-shot future expense expectations with auto-match cron and budget integration.

**Architecture:** New `scheduled_spends` table (category-only, no merchant). Cron auto-matches schedules to real tx on the same date+category each day. Budget `compareSpendingVsBudget` adds a `planned` aggregate via a cardinality-aware per-bucket anti-join. Soft-removed tx triggers a cleanup hook clearing the schedule's match. State is derived from two nullable columns (matchedTxId, dismissedAt) — no enum.

**Tech Stack:** TypeScript ESM monorepo, Prisma + Postgres on `5433/fina_test`, Fastify + Better Auth, Vitest singleFork, `withWorkspaceLock` advisory lock per workspace, `dateKeyInTz` from `apps/api/src/chat/tools/periods.ts` for user-tz boundaries.

---

## Task Dependency Order

1. **Task 1** — Schema migration + Prisma client regenerate. Foundation; everything else depends.
2. **Task 2** — `schedules/service.ts`: add/list/dismiss/remove + unit tests.
3. **Task 3** — `schedules/match.ts` + cron job + scheduler registration.
4. **Task 4** — Tx soft-removal cleanup hook (`removeTransactionService` + Plaid `markRemoved` + shared helper).
5. **Task 5** — HTTP routes + server registration + route tests.
6. **Task 6** — 5 chat tools (`add`, `list`, `listUnresolved`, `dismiss`, `remove`).
7. **Task 7** — Confirmation/audit registration in `intents/service.ts` + `audit/service.ts` + `present-confirm-card.ts`.
8. **Task 8** — Budget integration: `planned` field via per-bucket anti-join in `compareSpendingVsBudgetService` + chat tool Result extension.
9. **Task 9** — Smoke test doc.

Each task ends with a green API suite + single commit.

---

## Pre-flight (every task)

Test commands (paths RELATIVE to `apps/api/`):

Whole suite:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Specific file:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>.test.ts
```

⚠ `pnpm --filter @fina/api test` is a no-op (no `test` script).

Baseline before starting: ~850 tests passing (post plan 1C-split-transaction merge). Confirm with the whole-suite command if entering a fresh worktree.

If working in an isolated worktree (recommended via `EnterWorktree`), first do:
```bash
git merge main --ff-only
pnpm install --frozen-lockfile
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma generate
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all tests pass — clean baseline.

---

## Task 1: Schema + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (add `ScheduledSpend` model + back-relations on `Workspace`, `Category`, `Transaction`)
- Create: `apps/api/prisma/migrations/<ts>_add_scheduled_spends/migration.sql`

**Spec refs:** §3.1, §3.3.

### Step 1: Add `ScheduledSpend` model + back-relations

Edit `apps/api/prisma/schema.prisma`.

**1a.** Add the new model. Insert after the `TransactionAllocation` model (around line 320):

```prisma
model ScheduledSpend {
  id            String   @id @default(cuid())
  workspaceId   String
  categoryId    String
  amount        Decimal  @db.Decimal(14, 2)
  scheduledDate DateTime @db.Date
  note          String?
  matchedTxId   String?
  dismissedAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  workspace Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category  Category     @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  matchedTx Transaction? @relation("ScheduledSpendMatch", fields: [matchedTxId], references: [id], onDelete: SetNull)

  @@index([workspaceId, scheduledDate])
  @@index([workspaceId, categoryId, scheduledDate])
  @@index([matchedTxId])
  @@map("scheduled_spends")
}
```

**1b.** Add the back-relation on `Workspace` (around line 113, between `auditEvents` and the closing brace):

```prisma
model Workspace {
  // ... existing fields unchanged ...
  actionIntents      ActionIntent[]
  auditEvents        AuditEvent[]
  scheduledSpends    ScheduledSpend[]  // NEW

  @@map("workspaces")
}
```

**1c.** Add the back-relation on `Category` (find the existing back-relations block):

```prisma
model Category {
  // ... existing fields unchanged ...
  allocations  TransactionAllocation[]
  scheduledSpends ScheduledSpend[]  // NEW
}
```

**1d.** Add the named back-relation on `Transaction`:

```prisma
model Transaction {
  // ... existing fields unchanged ...
  allocations TransactionAllocation[]
  matchedSchedules ScheduledSpend[] @relation("ScheduledSpendMatch")  // NEW
}
```

### Step 2: Create the migration SQL

Try the Prisma generator first:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_scheduled_spends
```

If the non-interactive shell rejects `--create-only` (prior plans hit this), manually create `apps/api/prisma/migrations/<YYYYMMDDHHMMSS>_add_scheduled_spends/migration.sql` (timestamp matching Prisma convention, e.g., `20260520120000_add_scheduled_spends`) with this content:

```sql
CREATE TABLE "scheduled_spends" (
  "id"             TEXT PRIMARY KEY,
  "workspaceId"    TEXT NOT NULL,
  "categoryId"     TEXT NOT NULL,
  "amount"         NUMERIC(14, 2) NOT NULL,
  "scheduledDate"  DATE NOT NULL,
  "note"           TEXT,
  "matchedTxId"    TEXT,
  "dismissedAt"    TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "scheduled_spends_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_spends_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_spends_matchedTxId_fkey"
    FOREIGN KEY ("matchedTxId") REFERENCES "transactions"("id") ON DELETE SET NULL
);

CREATE INDEX "scheduled_spends_workspaceId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "scheduledDate");
CREATE INDEX "scheduled_spends_workspaceId_categoryId_scheduledDate_idx"
  ON "scheduled_spends"("workspaceId", "categoryId", "scheduledDate");
CREATE INDEX "scheduled_spends_matchedTxId_idx"
  ON "scheduled_spends"("matchedTxId");
```

### Step 3: Apply migration + regenerate client

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma generate
```

Expected: migration applies cleanly; Prisma client gains `ScheduledSpend` model.

### Step 4: Verify schema with a smoke insert via psql

```bash
docker exec fina-postgres-dev psql -U fina -d fina_test -c "INSERT INTO workspaces (id, name, currency, \"createdAt\", \"updatedAt\") VALUES ('ws_t1', 'test', 'CAD', NOW(), NOW()); INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\", \"updatedAt\") VALUES ('cat_t1', 'ws_t1', 'Test', NOW(), NOW()); INSERT INTO scheduled_spends (id, \"workspaceId\", \"categoryId\", amount, \"scheduledDate\", \"updatedAt\") VALUES ('sch_t1', 'ws_t1', 'cat_t1', 100.00, '2026-05-25', NOW()); SELECT id, \"scheduledDate\", \"matchedTxId\", \"dismissedAt\" FROM scheduled_spends WHERE id = 'sch_t1'; DELETE FROM workspaces WHERE id = 'ws_t1';"
```

Expected: rows insert and select correctly; matchedTxId and dismissedAt are NULL. Cleanup via the cascade.

### Step 5: Run full suite — no regression

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all existing tests still pass (~850 + 1 todo).

### Step 6: Commit

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): schema + migration

Adds ScheduledSpend model with 3 indexes (workspaceId+scheduledDate,
workspaceId+categoryId+scheduledDate, matchedTxId). Back-relations on
Workspace, Category, and Transaction (named "ScheduledSpendMatch").

Pure additive migration — no risk to existing data.
EOF
)"
```

---

## Task 2: schedules/service.ts (CRUD)

**Files:**
- Create: `apps/api/src/schedules/service.ts`
- Create: `apps/api/tests/schedules.service.test.ts`

**Spec refs:** §4.1 (chat tool shapes), §7.1 (service signatures), §8.1 (test cases).

### Step 1: Write failing service unit tests

Create `apps/api/tests/schedules.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import {
  addScheduledSpendService,
  listScheduledSpendsService,
  dismissScheduledSpendService,
  removeScheduledSpendService,
  ScheduledSpendError,
} from "../src/schedules/service.js";

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

async function setup(email: string): Promise<{ wsId: string; userId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { wsId, userId: u.userId, categoryId: cat.id };
}

describe("addScheduledSpendService", () => {
  it("happy: creates schedule with all fields", async () => {
    const { wsId, categoryId } = await setup("ss-add@t.co");
    const r = await addScheduledSpendService({
      workspaceId: wsId,
      categoryId,
      amount: 100,
      scheduledDate: "2026-05-25",
      note: "dental",
    });
    expect(r.schedule.id).toMatch(/^c/); // cuid prefix
    expect(r.schedule.categoryId).toBe(categoryId);
    expect(r.schedule.amount).toBe("100");
    expect(r.schedule.scheduledDate).toBe("2026-05-25");
    expect(r.schedule.note).toBe("dental");
  });

  it("rejects amount 0.005 → invalid_amount", async () => {
    const { wsId, categoryId } = await setup("ss-amt@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 0.005, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects amount 0 → invalid_amount", async () => {
    const { wsId, categoryId } = await setup("ss-amt0@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 0, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects invalid date 2026-13-01 → invalid_date", async () => {
    const { wsId, categoryId } = await setup("ss-date@t.co");
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("rejects archived category → category_not_found", async () => {
    const { wsId } = await setup("ss-arch@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch", archivedAt: new Date() },
    });
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects category in different workspace → category_not_found", async () => {
    const { wsId } = await setup("ss-xws@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "Other" } });
    await expect(
      addScheduledSpendService({ workspaceId: wsId, categoryId: otherCat.id, amount: 50, scheduledDate: "2026-05-25" }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("accepts past scheduledDate (backfill use case)", async () => {
    const { wsId, categoryId } = await setup("ss-past@t.co");
    const r = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2025-01-01",
    });
    expect(r.schedule.scheduledDate).toBe("2025-01-01");
  });

  it("rejects 1001-char note → invalid_note", async () => {
    const { wsId, categoryId } = await setup("ss-note@t.co");
    await expect(
      addScheduledSpendService({
        workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
        note: "x".repeat(1001),
      }),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });
});

describe("listScheduledSpendsService", () => {
  it("returns all schedules with derived status", async () => {
    const { wsId, userId, categoryId } = await setup("ss-list@t.co");
    // 1 upcoming
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    // 1 unresolved (past, not matched, not dismissed)
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules).toHaveLength(2);
    const statuses = r.schedules.map((s) => s.status).sort();
    expect(statuses).toEqual(["unresolved", "upcoming"]);
  });

  it("filters by status=upcoming", async () => {
    const { wsId, userId, categoryId } = await setup("ss-upc@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });
    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "upcoming" });
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.status).toBe("upcoming");
  });

  it("filters by status=unresolved", async () => {
    const { wsId, userId, categoryId } = await setup("ss-unr@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2099-01-01" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2020-01-01" });
    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "unresolved" });
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.status).toBe("unresolved");
  });

  it("filters by from/to date range", async () => {
    const { wsId, userId, categoryId } = await setup("ss-range@t.co");
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-15" });
    await addScheduledSpendService({ workspaceId: wsId, categoryId, amount: 30, scheduledDate: "2026-06-15" });
    const r = await listScheduledSpendsService(
      { workspaceId: wsId, userId },
      { from: new Date("2026-05-01"), to: new Date("2026-05-31"), status: "all" },
    );
    expect(r.schedules).toHaveLength(1);
    expect(r.schedules[0]!.scheduledDate).toBe("2026-05-15");
  });

  it("returns resolved-matched status when matched tx still active", async () => {
    const { wsId, userId, categoryId } = await setup("ss-rm@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules[0]!.status).toBe("resolved-matched");
  });

  it("treats matched-tx-soft-removed as unresolved", async () => {
    const { wsId, userId, categoryId } = await setup("ss-rmtx@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2020-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
        removedAt: new Date(),  // soft-removed
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2020-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });

    const r = await listScheduledSpendsService({ workspaceId: wsId, userId }, { status: "all" });
    expect(r.schedules[0]!.status).toBe("unresolved");
  });
});

describe("dismissScheduledSpendService", () => {
  it("happy: sets dismissedAt", async () => {
    const { wsId, categoryId } = await setup("ss-dis@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const r = await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toMatchObject({ schedule: { id: schedule.id } });
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.dismissedAt).not.toBeNull();
  });

  it("idempotent: already-dismissed returns alreadyDismissed=true", async () => {
    const { wsId, categoryId } = await setup("ss-disid@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    const r = await dismissScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toEqual({ dismissed: false, alreadyDismissed: true });
  });

  it("rejects already-matched with active tx → already_matched", async () => {
    const { wsId, categoryId } = await setup("ss-dismatched@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "100", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: tx.id } });
    await expect(
      dismissScheduledSpendService({ workspaceId: wsId }, schedule.id),
    ).rejects.toMatchObject({ code: "already_matched" });
  });

  it("404 not_found", async () => {
    const { wsId } = await setup("ss-dis404@t.co");
    await expect(
      dismissScheduledSpendService({ workspaceId: wsId }, "no-such-id"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("removeScheduledSpendService", () => {
  it("happy: hard delete returns removed=true", async () => {
    const { wsId, categoryId } = await setup("ss-rem@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const r = await removeScheduledSpendService({ workspaceId: wsId }, schedule.id);
    expect(r).toEqual({ removed: true });
    const row = await prisma.scheduledSpend.findUnique({ where: { id: schedule.id } });
    expect(row).toBeNull();
  });

  it("idempotent: missing id returns alreadyRemoved=true (NOT 404)", async () => {
    const { wsId } = await setup("ss-remid@t.co");
    const r = await removeScheduledSpendService({ workspaceId: wsId }, "no-such-id");
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("wrong-workspace returns alreadyRemoved=true (treats as missing)", async () => {
    const { wsId, categoryId } = await setup("ss-remxws@t.co");
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 50, scheduledDate: "2026-05-25",
    });
    const otherWs = await prisma.workspace.create({ data: { name: "other-remxws" } });
    const r = await removeScheduledSpendService({ workspaceId: otherWs.id }, schedule.id);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
    // Real schedule still exists
    const row = await prisma.scheduledSpend.findUnique({ where: { id: schedule.id } });
    expect(row).not.toBeNull();
  });
});
```

### Step 2: Run, verify failure (module missing)

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.service.test.ts
```

Expected: FAIL — import error.

### Step 3: Implement `schedules/service.ts`

Create `apps/api/src/schedules/service.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import {
  TxValidationError,
  validateAmount,
  validateNote,
  parseOccurredAt,  // YYYY-MM-DD validator
} from "../transactions/validators.js";

export type ScheduledSpendStatus =
  | "upcoming"
  | "unresolved"
  | "resolved-matched"
  | "resolved-dismissed";

export type ScheduledSpendErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_note"
  | "category_not_found"
  | "not_found"
  | "already_matched";

export class ScheduledSpendError extends Error {
  readonly code: ScheduledSpendErrorCode;
  constructor(code: ScheduledSpendErrorCode) {
    super(code);
    this.name = "ScheduledSpendError";
    this.code = code;
  }
}

function rethrowValidation<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new ScheduledSpendError(e.code as ScheduledSpendErrorCode);
    throw e;
  }
}

export type AddScheduledSpendInput = {
  workspaceId: string;
  categoryId: string;
  amount: number;
  scheduledDate: string;  // YYYY-MM-DD
  note?: string;
};

type ScheduleDTO = {
  id: string;
  categoryId: string;
  amount: string;
  scheduledDate: string;  // YYYY-MM-DD
  note: string | null;
  matchedTxId: string | null;
  dismissedAt: string | null;
  status: ScheduledSpendStatus;
};

export type AddScheduledSpendResult = {
  schedule: ScheduleDTO;
};

type ScheduleRow = Prisma.ScheduledSpendGetPayload<{
  include: { matchedTx: { select: { removedAt: true } } };
}>;

// Note: `parseOccurredAt` (from validators.ts) returns a Date at noon UTC
// (`+T12:00:00Z`). Postgres `@db.Date` truncates to the date component on
// storage; reads return midnight UTC. So we never see the noon-UTC instant
// after a round trip — but if reading `scheduledDate` straight from input
// before storage, treat the noon-UTC quirk as benign (date components match
// the user's intent in every supported tz).

function deriveStatus(row: ScheduleRow, today: Date): ScheduledSpendStatus {
  // matched and tx still active → resolved-matched
  if (row.matchedTxId && row.matchedTx && row.matchedTx.removedAt === null) {
    return "resolved-matched";
  }
  // dismissed (and not resolved-matched) → resolved-dismissed
  if (row.dismissedAt !== null) {
    return "resolved-dismissed";
  }
  // matched-tx-removed or no match — date determines upcoming vs unresolved
  // Compare scheduledDate against today as DATE wall-clock (both are date-only).
  // todayKey = today's UTC date string (or just compare via Date.getTime, but to
  // match Postgres DATE semantics, use day-only comparison).
  const schedDayMs = Date.UTC(
    row.scheduledDate.getUTCFullYear(),
    row.scheduledDate.getUTCMonth(),
    row.scheduledDate.getUTCDate(),
  );
  const todayDayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return schedDayMs >= todayDayMs ? "upcoming" : "unresolved";
}

function toDTO(row: ScheduleRow, today: Date): ScheduleDTO {
  return {
    id: row.id,
    categoryId: row.categoryId,
    amount: row.amount.toString(),
    scheduledDate: row.scheduledDate.toISOString().slice(0, 10),
    note: row.note,
    matchedTxId: row.matchedTxId,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    status: deriveStatus(row, today),
  };
}

export async function addScheduledSpendService(
  input: AddScheduledSpendInput,
): Promise<AddScheduledSpendResult> {
  rethrowValidation(() => validateAmount(input.amount));
  const parsedDate = rethrowValidation(() => parseOccurredAt(input.scheduledDate));
  const normalizedNote = rethrowValidation(() => validateNote(input.note));

  return await withWorkspaceLock(input.workspaceId, async (tx) => {
    // Re-check category inside lock — defensive against archive race.
    const cat = await tx.category.findFirst({
      where: { id: input.categoryId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cat) throw new ScheduledSpendError("category_not_found");

    const row = await tx.scheduledSpend.create({
      data: {
        workspaceId: input.workspaceId,
        categoryId: input.categoryId,
        amount: new Prisma.Decimal(input.amount),
        scheduledDate: parsedDate,
        note: normalizedNote,
      },
      include: { matchedTx: { select: { removedAt: true } } },
    });
    return { schedule: toDTO(row, new Date()) };
  });
}

export type ListFilter = {
  from?: Date;
  to?: Date;
  status?: ScheduledSpendStatus | "all";
};

export type ListResult = {
  schedules: ScheduleDTO[];
};

export async function listScheduledSpendsService(
  ctx: { workspaceId: string; userId: string },
  filter: ListFilter,
): Promise<ListResult> {
  const where: Prisma.ScheduledSpendWhereInput = { workspaceId: ctx.workspaceId };
  if (filter.from || filter.to) {
    where.scheduledDate = {};
    if (filter.from) (where.scheduledDate as Prisma.DateTimeFilter).gte = filter.from;
    if (filter.to) (where.scheduledDate as Prisma.DateTimeFilter).lte = filter.to;
  }
  const rows = await prisma.scheduledSpend.findMany({
    where,
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { matchedTx: { select: { removedAt: true } } },
  });

  const today = new Date();
  let dtos = rows.map((r) => toDTO(r, today));
  if (filter.status && filter.status !== "all") {
    dtos = dtos.filter((d) => d.status === filter.status);
  }
  return { schedules: dtos };
}

export type DismissResult =
  | { schedule: { id: string; dismissedAt: string } }
  | { dismissed: false; alreadyDismissed: true };

export async function dismissScheduledSpendService(
  ctx: { workspaceId: string },
  id: string,
): Promise<DismissResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.scheduledSpend.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { matchedTx: { select: { removedAt: true } } },
    });
    if (!row) throw new ScheduledSpendError("not_found");
    if (row.dismissedAt !== null) {
      return { dismissed: false, alreadyDismissed: true } as const;
    }
    // Reject dismiss on active matched schedule (matched + matchedTx not soft-removed).
    if (row.matchedTxId && row.matchedTx && row.matchedTx.removedAt === null) {
      throw new ScheduledSpendError("already_matched");
    }

    const updated = await tx.scheduledSpend.update({
      where: { id },
      data: { dismissedAt: new Date() },
      select: { id: true, dismissedAt: true },
    });
    return { schedule: { id: updated.id, dismissedAt: updated.dismissedAt!.toISOString() } };
  });
}

export type RemoveResult =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export async function removeScheduledSpendService(
  ctx: { workspaceId: string },
  id: string,
): Promise<RemoveResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const result = await tx.scheduledSpend.deleteMany({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (result.count === 0) {
      return { removed: false, alreadyRemoved: true } as const;
    }
    return { removed: true } as const;
  });
}
```

### Step 4: Run service tests, verify PASS

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.service.test.ts
```

Expected: all tests PASS.

### Step 5: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 6: Commit

```bash
git add apps/api/src/schedules/service.ts apps/api/tests/schedules.service.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): CRUD service

addScheduledSpendService, listScheduledSpendsService,
dismissScheduledSpendService, removeScheduledSpendService.

Status derivation: matched + matchedTx active → resolved-matched;
dismissedAt → resolved-dismissed; else date >= today → upcoming;
else unresolved. Matched-tx-soft-removed correctly degrades to
unresolved per spec §3.2.

Dismiss rejects already-matched (active) with 400 already_matched.
Remove is idempotent — alreadyRemoved: true on missing/wrong-workspace
instead of 404.

All writes inside withWorkspaceLock; category re-checked inside lock
for archive race protection.
EOF
)"
```

---

## Task 3: schedules/match.ts + cron job

**Files:**
- Create: `apps/api/src/schedules/match.ts`
- Create: `apps/api/src/cron/jobs/scheduled-spend-match.ts`
- Modify: `apps/api/src/cron/scheduler.ts` (add new cron entry)
- Create: `apps/api/tests/schedules.match.test.ts`

**Spec refs:** §5.2 (algorithm), §5.3 (edge cases), §8.2 (test cases).

### Step 1: Write failing match tests

Create `apps/api/tests/schedules.match.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { matchScheduledSpends } from "../src/schedules/match.js";
import { addScheduledSpendService } from "../src/schedules/service.js";

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

async function setup(email: string): Promise<{ wsId: string; userId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { wsId, userId: u.userId, categoryId: cat.id };
}

async function seedTx(wsId: string, opts: {
  categoryId: string | null;
  amount: string;
  occurredAt: Date;
  removedAt?: Date;
}): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
      amount: opts.amount, merchantRaw: "Seed", merchantNormalized: "seed",
      occurredAt: opts.occurredAt,
      pending: false, source: "manual", rawData: {},
      removedAt: opts.removedAt ?? null,
    },
  });
  // Wipe auto-backfill allocation then set the one we want.
  await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: tx.id,
      categoryId: opts.categoryId,
      amount: opts.amount,
      source: opts.categoryId ? "manual" : null,
    },
  });
  return tx.id;
}

describe("matchScheduledSpends", () => {
  it("no schedules → no-op", async () => {
    const { wsId } = await setup("mt-noop@t.co");
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25"));
    expect(r).toEqual({ matched: 0, unresolved: 0 });
  });

  it("schedule today + matching tx → matchedTxId set", async () => {
    const { wsId, categoryId } = await setup("mt-1@t.co");
    const occ = new Date("2026-05-25T12:00:00Z");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: occ });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    expect(r.matched).toBe(1);
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBe(txId);
  });

  it("schedule today + tx different category → no match", async () => {
    const { wsId, categoryId } = await setup("mt-cat@t.co");
    const otherCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Other" } });
    await seedTx(wsId, { categoryId: otherCat.id, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + tx different day → no match", async () => {
    const { wsId, categoryId } = await setup("mt-day@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-24T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + matching tx soft-removed → no match", async () => {
    const { wsId, categoryId } = await setup("mt-rm@t.co");
    await seedTx(wsId, {
      categoryId, amount: "50",
      occurredAt: new Date("2026-05-25T12:00:00Z"),
      removedAt: new Date(),
    });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule today + negative-amount tx → no match (refund excluded)", async () => {
    const { wsId, categoryId } = await setup("mt-refund@t.co");
    await seedTx(wsId, { categoryId, amount: "-50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("schedule in the future → skipped", async () => {
    const { wsId, categoryId } = await setup("mt-future@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-30T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-30",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();  // future schedule skipped
  });

  it("schedule already matched → cron leaves alone", async () => {
    const { wsId, categoryId } = await setup("mt-idem@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { matchedTxId: txId } });
    const r = await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    expect(r.matched).toBe(0);  // already matched, not re-counted
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBe(txId);  // unchanged
  });

  it("dismissed schedule → cron leaves alone", async () => {
    const { wsId, categoryId } = await setup("mt-dis@t.co");
    await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const { schedule } = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await prisma.scheduledSpend.update({ where: { id: schedule.id }, data: { dismissedAt: new Date() } });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const row = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } });
    expect(row.matchedTxId).toBeNull();
  });

  it("two schedules same day+cat, one tx → first (by createdAt) matches; second stays unresolved", async () => {
    const { wsId, categoryId } = await setup("mt-1to1@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    // wait a millisecond to ensure createdAt ordering
    await new Promise((r) => setTimeout(r, 10));
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowA = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect(rowA.matchedTxId).toBe(txId);
    expect(rowB.matchedTxId).toBeNull();
  });

  it("two schedules same day+cat, two tx → each consumes a distinct tx", async () => {
    const { wsId, categoryId } = await setup("mt-2to2@t.co");
    const tx1 = await seedTx(wsId, { categoryId, amount: "30", occurredAt: new Date("2026-05-25T10:00:00Z") });
    const tx2 = await seedTx(wsId, { categoryId, amount: "70", occurredAt: new Date("2026-05-25T14:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await new Promise((r) => setTimeout(r, 10));
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowA = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: a.schedule.id } });
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect([rowA.matchedTxId, rowB.matchedTxId].sort()).toEqual([tx1, tx2].sort());
  });

  it("split tx (Health $60 + Grocery $40) covers one schedule in EACH category", async () => {
    const { wsId } = await setup("mt-split@t.co");
    const healthCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Health" } });
    const groceryCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Grocery" } });

    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "100", merchantRaw: "Costco", merchantNormalized: "costco",
        occurredAt: new Date("2026-05-25T12:00:00Z"),
        pending: false, source: "manual", rawData: {},
      },
    });
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: [
        { transactionId: tx.id, categoryId: healthCat.id, amount: "60", source: "manual" },
        { transactionId: tx.id, categoryId: groceryCat.id, amount: "40", source: "manual" },
      ],
    });

    const h = await addScheduledSpendService({
      workspaceId: wsId, categoryId: healthCat.id, amount: 200, scheduledDate: "2026-05-25",
    });
    const g = await addScheduledSpendService({
      workspaceId: wsId, categoryId: groceryCat.id, amount: 50, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));
    const rowH = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: h.schedule.id } });
    const rowG = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: g.schedule.id } });
    expect(rowH.matchedTxId).toBe(tx.id);
    expect(rowG.matchedTxId).toBe(tx.id);
  });

  it("cross-run dedupe — second run does not match tx already claimed by prior run", async () => {
    const { wsId, categoryId } = await setup("mt-crossrun@t.co");
    const txId = await seedTx(wsId, { categoryId, amount: "50", occurredAt: new Date("2026-05-25T12:00:00Z") });
    const a = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 100, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T18:00:00Z"));  // matches A
    // Add a second schedule AFTER run 1 — and verify cron run 2 does NOT also match it to the same tx.
    const b = await addScheduledSpendService({
      workspaceId: wsId, categoryId, amount: 60, scheduledDate: "2026-05-25",
    });
    await matchScheduledSpends(wsId, new Date("2026-05-25T19:00:00Z"));
    const rowB = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: b.schedule.id } });
    expect(rowB.matchedTxId).toBeNull();  // tx already claimed by A in run 1
  });
});
```

### Step 2: Run, verify failure (module missing)

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.match.test.ts
```

Expected: FAIL — module not found.

### Step 3: Implement `schedules/match.ts`

Create `apps/api/src/schedules/match.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { resolveUserTz, partsInTz } from "../chat/tools/periods.js";

/**
 * Match unresolved past-or-today schedules to real tx in the same workspace.
 *
 * For each candidate schedule (ordered scheduledDate asc, createdAt asc, id asc):
 *   - Find tx in workspace + occurredAt in the schedule's day (workspace-owner tz) +
 *     positive amount + ≥1 positive allocation in the schedule's category.
 *   - Skip already-consumed (txId, categoryId) pairs (per-category one-to-one).
 *   - Set matchedTxId on first available match.
 *
 * Returns counts for logging/observability.
 */
export async function matchScheduledSpends(
  workspaceId: string,
  today: Date,
): Promise<{ matched: number; unresolved: number }> {
  return await withWorkspaceLock(workspaceId, async (tx) => {
    // 1. Resolve workspace owner's tz (used to compute day boundaries).
    const owner = await tx.membership.findFirst({
      where: { workspaceId, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    const ownerTz = owner ? await resolveUserTz(owner.userId) : "America/Toronto";

    // 2. Pre-load already-matched (txId, categoryId) pairs for cross-run dedupe.
    const alreadyMatched = await tx.scheduledSpend.findMany({
      where: { workspaceId, matchedTxId: { not: null } },
      select: { matchedTxId: true, categoryId: true },
    });
    const usedTxAllocations = new Set<string>(
      alreadyMatched.map((r) => `${r.matchedTxId}|${r.categoryId}`),
    );

    // 3. Load candidates: past-or-today, unmatched, undismissed.
    // today is a Date instant; compare against scheduledDate (DATE wall-clock).
    // We use UTC date components from `today` for the comparison since scheduledDate
    // is stored as Postgres DATE (no tz). For the canonical "today" we use the
    // workspace-owner-tz date and convert it to a UTC midnight Date for the SQL bound.
    const todayParts = partsInTz(today, ownerTz);
    const todayDateOnly = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));

    const candidates = await tx.scheduledSpend.findMany({
      where: {
        workspaceId,
        matchedTxId: null,
        dismissedAt: null,
        scheduledDate: { lte: todayDateOnly },
      },
      orderBy: [
        { scheduledDate: "asc" },
        { createdAt: "asc" },
        { id: "asc" },
      ],
    });

    let matched = 0;
    let unresolved = 0;
    for (const candidate of candidates) {
      // Compute the schedule's day in workspace-owner tz → UTC half-open instant range.
      const yyyy = candidate.scheduledDate.getUTCFullYear();
      const mm = candidate.scheduledDate.getUTCMonth();
      const dd = candidate.scheduledDate.getUTCDate();
      // Wall-clock day {yyyy-mm-dd} in workspace tz → start/end instants.
      // We compute by finding the UTC instant whose ownerTz-local parts match the date.
      const dayStart = utcMidnightInTz(yyyy, mm + 1, dd, ownerTz);
      const nextDayStart = utcMidnightInTz(yyyy, mm + 1, dd + 1, ownerTz);

      const matches = await tx.transaction.findMany({
        where: {
          workspaceId,
          removedAt: null,
          amount: { gt: 0 },
          occurredAt: { gte: dayStart, lt: nextDayStart },
          allocations: {
            some: { categoryId: candidate.categoryId, amount: { gt: 0 } },
          },
        },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const picked = matches.find(
        (m) => !usedTxAllocations.has(`${m.id}|${candidate.categoryId}`),
      );
      if (picked) {
        await tx.scheduledSpend.update({
          where: { id: candidate.id },
          data: { matchedTxId: picked.id },
        });
        usedTxAllocations.add(`${picked.id}|${candidate.categoryId}`);
        matched += 1;
      } else {
        unresolved += 1;
      }
    }
    return { matched, unresolved };
  });
}

// Reuse the existing helper from periods.ts. It is currently unexported —
// before importing it here, export it from apps/api/src/chat/tools/periods.ts
// (one-line edit: add `export` to the `function localMidnightToUtc(...)` definition
// at periods.ts:70). Then import it at the top of this file:
//   import { resolveUserTz, partsInTz, localMidnightToUtc } from "../chat/tools/periods.js";
// and use it directly in place of the inline duplication.
```

**As part of this task, also export `localMidnightToUtc`** from `apps/api/src/chat/tools/periods.ts` — change `function localMidnightToUtc(...)` to `export function localMidnightToUtc(...)`. The function already exists (around line 70) and handles the DST/tz iteration correctly; duplicating it in `match.ts` invites drift.

Then in `match.ts`, replace the day-range computation with:

```ts
const dayStart = localMidnightToUtc(yyyy, mm + 1, dd, ownerTz);
const nextDayStart = localMidnightToUtc(yyyy, mm + 1, dd + 1, ownerTz);
```

### Step 4: Run match tests, verify PASS

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.match.test.ts
```

Expected: 12 tests PASS.

### Step 5: Create the cron job

Create `apps/api/src/cron/jobs/scheduled-spend-match.ts`:

```ts
import { prisma } from "../../db.js";
import { matchScheduledSpends } from "../../schedules/match.js";
import type { Env } from "../../env.js";

/**
 * Iterate active workspaces and run match. Errors per workspace are caught
 * so one bad workspace doesn't stop the rest.
 */
export async function runScheduledSpendMatch(_env: Env): Promise<void> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const today = new Date();
  let totalMatched = 0;
  let totalUnresolved = 0;
  for (const ws of workspaces) {
    try {
      const r = await matchScheduledSpends(ws.id, today);
      totalMatched += r.matched;
      totalUnresolved += r.unresolved;
    } catch (e) {
      console.error("scheduled-spend-match: workspace failed", { workspaceId: ws.id, err: e });
    }
  }
  console.info("scheduled-spend-match: complete", { totalMatched, totalUnresolved });
}
```

### Step 6: Register the cron job

Modify `apps/api/src/cron/scheduler.ts`. Add the import and the new entry:

```ts
import { Cron } from "croner";
import type { Env } from "../env.js";
import { runDailyRefresh } from "./jobs/daily-refresh.js";
import { runRetryUnprocessed } from "./jobs/retry-unprocessed.js";
import { runCleanupEvents } from "./jobs/cleanup-events.js";
import { runScheduledSpendMatch } from "./jobs/scheduled-spend-match.js";  // NEW

let jobs: Cron[] = [];

export function startScheduler(env: Env): void {
  if (!env.CRON_ENABLED) return;

  jobs = [
    new Cron("0 9 * * *",    { protect: true, name: "daily-refresh" },     () => safe("daily-refresh",     () => runDailyRefresh(env))),
    new Cron("*/10 * * * *", { protect: true, name: "retry-unprocessed" }, () => safe("retry-unprocessed", () => runRetryUnprocessed(env))),
    new Cron("0 3 * * *",    { protect: true, name: "cleanup-events" },    () => safe("cleanup-events",    () => runCleanupEvents(env))),
    new Cron("5 9 * * *",    { protect: true, name: "scheduled-spend-match" }, () => safe("scheduled-spend-match", () => runScheduledSpendMatch(env))),  // NEW: 5 min after daily-refresh
  ];

  console.info("cron scheduler started", { jobs: jobs.map((j) => j.name) });
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
}

async function safe(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("cron job uncaught", { jobName: name, err: e });
  }
}
```

### Step 7: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 8: Commit

```bash
git add apps/api/src/schedules/match.ts \
        apps/api/src/cron/jobs/scheduled-spend-match.ts \
        apps/api/src/cron/scheduler.ts \
        apps/api/tests/schedules.match.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): match cron + scheduler entry

matchScheduledSpends(workspaceId, today) finds tx in same workspace
+ same day (workspace owner tz) + same category + positive amount.
Per-category one-to-one consumption via usedTxAllocations keyed by
(txId, categoryId). Pre-loads existing matches for cross-run dedupe.

Registered as separate cron entry "5 9 * * *" (09:05 UTC, 5 min after
daily-refresh). 12 tests cover: no-op, happy match, wrong category,
wrong day, soft-removed tx, refund tx, future schedule, idempotent
already-matched, dismissed schedule skip, one-to-one with one tx,
two-to-two with two tx, split tx covering two categories, cross-run
dedupe.
EOF
)"
```

---

## Task 4: Tx soft-removal cleanup hook

**Files:**
- Modify: `apps/api/src/transactions/remove.ts` (clear schedule.matchedTxId)
- Modify: `apps/api/src/plaid/sync.ts` `markRemoved` (clear schedule.matchedTxId)
- Create: `apps/api/src/schedules/cleanup.ts` (shared helper)
- Modify: `apps/api/tests/transactions.remove.service.test.ts` (new test)
- Modify: `apps/api/tests/plaid.sync.*.test.ts` (new test for markRemoved)

**Spec refs:** §5.4.

### Step 1: Write failing test in transactions.remove.service.test.ts

Find the test file at `apps/api/tests/transactions.remove.service.test.ts`. Append:

```ts
it("clears matchedTxId on scheduled_spends that referenced the removed tx", async () => {
  const { wsId, userId } = await setupEditor("rm-sched@t.co");
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-rm-sched" } });
  const r = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "X", amount: 50, occurredAt: "2026-05-25" },
  );
  const sched = await prisma.scheduledSpend.create({
    data: {
      workspaceId: wsId, categoryId: cat.id,
      amount: "100", scheduledDate: new Date("2026-05-25T00:00:00Z"),
      matchedTxId: r.transaction.id,
    },
  });
  await removeTransactionService({ workspaceId: wsId }, r.transaction.id);
  const after = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: sched.id } });
  expect(after.matchedTxId).toBeNull();
});
```

### Step 2: Run, verify failure

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.remove.service.test.ts
```

Expected: FAIL — the new test fails because removeTransactionService doesn't clear matchedTxId yet.

### Step 3: Create the shared helper

Create `apps/api/src/schedules/cleanup.ts`:

```ts
import { Prisma } from "@prisma/client";

/**
 * Clear matchedTxId on any ScheduledSpend that referenced the given tx id.
 * Called when a tx is soft-removed (removedAt set). MUST be invoked from
 * inside a Prisma $transaction or workspace lock so reads+writes are atomic.
 */
export async function clearScheduleMatch(
  tx: Prisma.TransactionClient,
  txId: string,
): Promise<void> {
  await tx.scheduledSpend.updateMany({
    where: { matchedTxId: txId },
    data: { matchedTxId: null },
  });
}
```

### Step 4: Modify removeTransactionService to invoke the helper

Edit `apps/api/src/transactions/remove.ts`. Inside the existing `withWorkspaceLock` callback, after the `tx.transaction.update(...)` call that sets `removedAt`, add the cleanup:

```ts
import { clearScheduleMatch } from "../schedules/cleanup.js";

// ... existing code ...

// Inside withWorkspaceLock callback, after setting removedAt:
await tx.transaction.update({
  where: { id: txId },
  data: { removedAt: new Date() },
});
await clearScheduleMatch(tx, txId);  // NEW: clear stale schedule matches
return { removed: true } as const;
```

(Adapt the surrounding code structure to match the actual file — only the `clearScheduleMatch` call is new.)

### Step 5: Verify the remove test passes

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.remove.service.test.ts
```

Expected: PASS.

### Step 6: Modify Plaid markRemoved with the same helper

Edit `apps/api/src/plaid/sync.ts`. Find `markRemoved` (around line 305-320). It currently looks up the tx by `(workspaceId, plaidTransactionId, removedAt: null)` and runs `updateMany`. Refactor to also clear schedule matches:

```ts
import { clearScheduleMatch } from "../schedules/cleanup.js";

// ... existing markRemoved code ...

export async function markRemoved(
  tx: Prisma.TransactionClient,
  plaidTransactionId: string,
  workspaceId: string,
): Promise<void> {
  // First select the local tx to get its id (so we can clear schedule matches).
  const target = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId, removedAt: null },
    select: { id: true },
  });
  if (!target) return;  // nothing to remove
  await clearScheduleMatch(tx, target.id);  // NEW: clear stale schedule matches
  await tx.transaction.update({
    where: { id: target.id },
    data: { removedAt: new Date() },
  });
}
```

### Step 7: Write Plaid markRemoved schedule-cleanup test

Find the existing plaid sync test file (`apps/api/tests/plaid.sync.test.ts` or similar — confirm with `ls apps/api/tests/plaid.sync*`). Append:

```ts
it("markRemoved clears matchedTxId on ScheduledSpend referencing the removed tx", async () => {
  // Setup: workspace + category + tx (with plaidTransactionId) + a schedule matched to it
  const u = await signUpAndGetCookie(app, { email: "plaid-sched-rm@t.co" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-plaid-sched" } });
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository", status: "active" },
  });
  const ptx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: "p_sched_rm",
      amount: "50", merchantRaw: "PX", merchantNormalized: "px",
      occurredAt: new Date("2026-05-25T12:00:00Z"),
      pending: false, source: "plaid", rawData: {},
    },
  });
  const sched = await prisma.scheduledSpend.create({
    data: {
      workspaceId: wsId, categoryId: cat.id,
      amount: "100", scheduledDate: new Date("2026-05-25T00:00:00Z"),
      matchedTxId: ptx.id,
    },
  });

  // Invoke markRemoved through a Prisma transaction (mimics sync.ts flow)
  await prisma.$transaction(async (tx) => {
    const { markRemoved } = await import("../src/plaid/sync.js");
    await markRemoved(tx, "p_sched_rm", wsId);
  });

  const after = await prisma.scheduledSpend.findUniqueOrThrow({ where: { id: sched.id } });
  expect(after.matchedTxId).toBeNull();
  const txAfter = await prisma.transaction.findUniqueOrThrow({ where: { id: ptx.id } });
  expect(txAfter.removedAt).not.toBeNull();
});
```

### Step 8: Run all tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.remove.service.test.ts $(ls apps/api/tests/plaid.sync* | sed 's|apps/api/||g' | tr '\n' ' ')
```

Expected: PASS.

Then full suite:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 9: Commit

```bash
git add apps/api/src/schedules/cleanup.ts \
        apps/api/src/transactions/remove.ts \
        apps/api/src/plaid/sync.ts \
        apps/api/tests/transactions.remove.service.test.ts \
        apps/api/tests/plaid.sync*.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): tx soft-removal cleanup hook

clearScheduleMatch(tx, txId) helper clears matchedTxId on any
ScheduledSpend referencing the given tx. Invoked from both
removeTransactionService AND Plaid markRemoved (which now does a
lookup-first to find the local tx id before the soft-remove).

Restores the schedule to unresolved state — the next cron run will
attempt to re-match if applicable.
EOF
)"
```

---

## Task 5: HTTP routes + server registration

**Files:**
- Create: `apps/api/src/routes/schedules.ts`
- Modify: `apps/api/src/server.ts` (register route)
- Create: `apps/api/tests/schedules.route.test.ts`

**Spec refs:** §4.2, §8.5.

### Step 1: Write failing route tests

Create `apps/api/tests/schedules.route.test.ts`:

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

async function setup(email: string): Promise<{ cookie: string; wsId: string; categoryId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: `Cat-${email}` } });
  return { cookie: u.cookie, wsId, categoryId: cat.id };
}

describe("POST /workspaces/:id/schedules", () => {
  it("201 happy", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-add@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 100, scheduledDate: "2026-05-25", note: "x" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.schedule.id).toBeTruthy();
    expect(body.schedule.amount).toBe("100");
  });

  it("400 invalid_body bad JSON", async () => {
    const { cookie, wsId } = await setup("sr-badbody@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: "not-a-number" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_amount", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-amt@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 0, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });

  it("404 category_not_found (archived)", async () => {
    const { cookie, wsId } = await setup("sr-arch@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Arch", archivedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-wmm@t.co");
    const other = await prisma.workspace.create({ data: { name: "other-wmm" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${other.id}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("401 no session", async () => {
    const { wsId, categoryId } = await setup("sr-401@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 viewer", async () => {
    const owner = await signUpAndGetCookie(app, { email: "sr-403-owner@t.co" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C403" } });
    const viewer = await signUpAndGetCookie(app, { email: "sr-403-viewer@t.co" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: cat.id, amount: 50, scheduledDate: "2026-05-25" }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});

describe("GET /workspaces/:id/schedules", () => {
  it("happy returns array with derived status", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-list@t.co");
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2099-05-25" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].status).toBe("upcoming");
  });

  it("filter status=upcoming", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-stfilt@t.co");
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2099-05-25" }),
    });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 30, scheduledDate: "2020-01-01" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/schedules?status=upcoming`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = res.json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0].status).toBe("upcoming");
  });
});

describe("POST /workspaces/:id/schedules/:scheduleId/dismiss", () => {
  it("happy 200", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-dis@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedule.id).toBe(id);
  });

  it("idempotent already dismissed", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-disid@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/${id}/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ dismissed: false, alreadyDismissed: true });
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setup("sr-dis404@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/schedules/no-such/dismiss`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

describe("DELETE /workspaces/:id/schedules/:scheduleId", () => {
  it("happy 200 removed=true", async () => {
    const { cookie, wsId, categoryId } = await setup("sr-rm@t.co");
    const create = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/schedules`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId, amount: 50, scheduledDate: "2026-05-25" }),
    });
    const id = create.json().schedule.id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/schedules/${id}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("idempotent missing returns alreadyRemoved=true (no 404)", async () => {
    const { cookie, wsId } = await setup("sr-rmid@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/schedules/no-such-id`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false, alreadyRemoved: true });
  });
});
```

### Step 2: Run, verify failure (no route)

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.route.test.ts
```

Expected: FAIL — 404 from missing routes.

### Step 3: Implement routes

Create `apps/api/src/routes/schedules.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import {
  addScheduledSpendService,
  listScheduledSpendsService,
  dismissScheduledSpendService,
  removeScheduledSpendService,
  ScheduledSpendError,
  type AddScheduledSpendInput,
  type ScheduledSpendStatus,
} from "../schedules/service.js";

const StatusFilter = z.enum(["upcoming", "unresolved", "resolved-matched", "resolved-dismissed", "all"]);

const PostBody = z.object({
  categoryId: z.string().min(1),
  amount: z.number(),
  scheduledDate: z.string(),
  note: z.string().optional(),
}).strict();

const QuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  status: StatusFilter.optional(),
});

function statusFromCode(code: ScheduledSpendError["code"]): number {
  if (code === "not_found" || code === "category_not_found") return 404;
  return 400;  // invalid_*, already_matched
}

export async function schedulesRoutes(app: FastifyInstance): Promise<void> {
  // POST /workspaces/:id/schedules
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/schedules",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = PostBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

        const input: AddScheduledSpendInput = {
          workspaceId: ctx.membership.workspaceId,
          categoryId: parsed.data.categoryId,
          amount: parsed.data.amount,
          scheduledDate: parsed.data.scheduledDate,
        };
        if (parsed.data.note !== undefined) input.note = parsed.data.note;

        const result = await addScheduledSpendService(input);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof ScheduledSpendError) return reply.code(statusFromCode(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  // GET /workspaces/:id/schedules
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/schedules",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const q = QuerySchema.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: "invalid_query" });

        const filter: Parameters<typeof listScheduledSpendsService>[1] = {};
        if (q.data.from) filter.from = new Date(q.data.from);
        if (q.data.to) filter.to = new Date(q.data.to);
        if (q.data.status) filter.status = q.data.status as ScheduledSpendStatus | "all";

        const result = await listScheduledSpendsService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          filter,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );

  // POST /workspaces/:id/schedules/:scheduleId/dismiss
  app.post<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId/dismiss",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await dismissScheduledSpendService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.scheduleId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof ScheduledSpendError) return reply.code(statusFromCode(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  // DELETE /workspaces/:id/schedules/:scheduleId
  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await removeScheduledSpendService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.scheduleId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );
}
```

### Step 4: Register routes in server.ts

Edit `apps/api/src/server.ts`. Add the import and register:

```ts
import { schedulesRoutes } from "./routes/schedules.js";  // NEW

// ... existing imports ...

// Inside buildApp, where other routes are registered:
await app.register(schedulesRoutes);
```

(Match the exact registration pattern of other routes like `transactionsRoutes` — usually `await app.register(routesFn);` or `app.register(routesFn);`.)

### Step 5: Run route tests, verify PASS

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/schedules.route.test.ts
```

Expected: all PASS.

### Step 6: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 7: Commit

```bash
git add apps/api/src/routes/schedules.ts apps/api/src/server.ts apps/api/tests/schedules.route.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): HTTP routes

POST /workspaces/:id/schedules         (editor+, 201 on create)
GET  /workspaces/:id/schedules         (viewer+, ?from=&to=&status=)
POST /workspaces/:id/schedules/:id/dismiss  (editor+)
DELETE /workspaces/:id/schedules/:id   (editor+, idempotent)

DELETE is idempotent (returns alreadyRemoved: true, not 404) matching
the removeTransactionService pattern.
EOF
)"
```

---

## Task 6: Chat tools (5 of them)

**Files:**
- Create: `apps/api/src/chat/tools/add-scheduled-spend.ts`
- Create: `apps/api/src/chat/tools/list-scheduled-spends.ts`
- Create: `apps/api/src/chat/tools/list-unresolved-schedules.ts`
- Create: `apps/api/src/chat/tools/dismiss-scheduled-spend.ts`
- Create: `apps/api/src/chat/tools/remove-scheduled-spend.ts`
- Modify: `apps/api/src/chat/tools/index.ts` (register the 5 tools)
- Create: `apps/api/tests/chat.tools.scheduled-spends.test.ts`

**Spec refs:** §4.1.

### Step 1: Write a smoke chat-tool test

Create `apps/api/tests/chat.tools.scheduled-spends.test.ts`:

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
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Test-Cat" } });
  return { cookie: u.cookie, wsId, userId: u.userId, categoryName: cat.name, categoryId: cat.id };
}

describe("addScheduledSpend chat tool", () => {
  it("happy: resolves category by name and creates schedule", async () => {
    const { wsId, userId, categoryName } = await setup("ct-add@t.co");
    const { addScheduledSpend } = await import("../src/chat/tools/add-scheduled-spend.js");
    const result = await addScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { category: categoryName, amount: 100, scheduled_date: "2026-05-25", note: "x" },
    );
    expect(result.schedule.categoryName).toBe(categoryName);
    expect(result.schedule.amount).toBe("100");
  });

  it("category name unknown → category_not_found", async () => {
    const { wsId, userId } = await setup("ct-add-unknown@t.co");
    const { addScheduledSpend } = await import("../src/chat/tools/add-scheduled-spend.js");
    await expect(
      addScheduledSpend.run(
        { workspaceId: wsId, userId, env: env as any },
        { category: "Unknown-Cat", amount: 100, scheduled_date: "2026-05-25" },
      ),
    ).rejects.toThrow();
  });
});

describe("listScheduledSpends chat tool", () => {
  it("returns schedules with derived status", async () => {
    const { wsId, userId, categoryId } = await setup("ct-list@t.co");
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId,
        amount: "50", scheduledDate: new Date("2099-05-25T00:00:00Z"),
      },
    });
    const { listScheduledSpends } = await import("../src/chat/tools/list-scheduled-spends.js");
    const result = await listScheduledSpends.run(
      { workspaceId: wsId, userId, env: env as any },
      { status: "all" },
    );
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]!.status).toBe("upcoming");
  });
});

describe("listUnresolvedSchedules chat tool", () => {
  it("returns past schedules without match", async () => {
    const { wsId, userId, categoryId } = await setup("ct-listun@t.co");
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId,
        amount: "30", scheduledDate: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const { listUnresolvedSchedules } = await import("../src/chat/tools/list-unresolved-schedules.js");
    const result = await listUnresolvedSchedules.run(
      { workspaceId: wsId, userId, env: env as any },
      {},
    );
    expect(result.schedules).toHaveLength(1);
  });
});

describe("dismissScheduledSpend chat tool", () => {
  it("happy: sets dismissedAt", async () => {
    const { wsId, userId, categoryId } = await setup("ct-dis@t.co");
    const sched = await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId, amount: "50", scheduledDate: new Date("2026-05-25T00:00:00Z") },
    });
    const { dismissScheduledSpend } = await import("../src/chat/tools/dismiss-scheduled-spend.js");
    const result = await dismissScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { schedule_id: sched.id },
    );
    expect("schedule" in result || "dismissed" in result).toBe(true);
  });
});

describe("removeScheduledSpend chat tool", () => {
  it("happy: deletes the row", async () => {
    const { wsId, userId, categoryId } = await setup("ct-rem@t.co");
    const sched = await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId, amount: "50", scheduledDate: new Date("2026-05-25T00:00:00Z") },
    });
    const { removeScheduledSpend } = await import("../src/chat/tools/remove-scheduled-spend.js");
    const result = await removeScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { schedule_id: sched.id },
    );
    expect(result.removed).toBe(true);
  });
});
```

### Step 2: Run, verify failure

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.scheduled-spends.test.ts
```

Expected: FAIL — modules missing.

### Step 3: Implement chat tools

Look at an existing chat tool like `apps/api/src/chat/tools/add-recurring.ts` for the exact `ToolDef` pattern + category-by-name resolution. Then create the 5 files. Below is the structure for the first one; the others follow the same pattern.

`apps/api/src/chat/tools/add-scheduled-spend.ts`:

```ts
import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { addScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  category: z.string().min(1).max(80).describe("Category name (case-insensitive)"),
  amount: z.number().positive().describe("Planned amount"),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});

type Result = {
  schedule: {
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
  };
};

export const addScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "addScheduledSpend",
  description:
    "Schedule a one-time future expense for a category on a specific date. " +
    "Fina will look for a matching transaction on that day and mark the schedule resolved automatically.",
  args: Args,
  async run(ctx, args) {
    const cat = await prisma.category.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        archivedAt: null,
        name: { equals: args.category, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (!cat) throw new Error("category_not_found");

    const result = await addScheduledSpendService({
      workspaceId: ctx.workspaceId,
      categoryId: cat.id,
      amount: args.amount,
      scheduledDate: args.scheduled_date,
      ...(args.note !== undefined ? { note: args.note } : {}),
    });
    return {
      schedule: {
        id: result.schedule.id,
        categoryId: result.schedule.categoryId,
        categoryName: cat.name,
        amount: result.schedule.amount,
        scheduledDate: result.schedule.scheduledDate,
        note: result.schedule.note,
      },
    };
  },
};
```

`apps/api/src/chat/tools/list-scheduled-spends.ts`:

```ts
import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { listScheduledSpendsService, type ScheduledSpendStatus } from "../../schedules/service.js";

const Args = z.object({
  from: z.string().optional().describe("YYYY-MM-DD inclusive"),
  to: z.string().optional().describe("YYYY-MM-DD inclusive"),
  status: z.enum(["upcoming", "unresolved", "resolved-matched", "resolved-dismissed", "all"]).optional(),
});

type Result = {
  schedules: Array<{
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
    matchedTxId: string | null;
    dismissedAt: string | null;
    status: ScheduledSpendStatus;
  }>;
};

export const listScheduledSpends: ToolDef<z.infer<typeof Args>, Result> = {
  name: "listScheduledSpends",
  description:
    "List scheduled future expenses. Filter by date range or status " +
    "(upcoming/unresolved/resolved-matched/resolved-dismissed/all).",
  args: Args,
  async run(ctx, args) {
    const filter: Parameters<typeof listScheduledSpendsService>[1] = {};
    if (args.from) filter.from = new Date(args.from);
    if (args.to) filter.to = new Date(args.to);
    if (args.status) filter.status = args.status;

    const r = await listScheduledSpendsService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      filter,
    );

    // Resolve category names for the LLM.
    const catIds = Array.from(new Set(r.schedules.map((s) => s.categoryId)));
    const cats = await prisma.category.findMany({
      where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
      select: { id: true, name: true },
    });
    const catNameById = new Map(cats.map((c) => [c.id, c.name]));

    return {
      schedules: r.schedules.map((s) => ({
        ...s,
        categoryName: catNameById.get(s.categoryId) ?? "Unknown",
      })),
    };
  },
};
```

`apps/api/src/chat/tools/list-unresolved-schedules.ts`:

```ts
import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { listScheduledSpendsService } from "../../schedules/service.js";

const Args = z.object({});

type Result = {
  schedules: Array<{
    id: string;
    categoryId: string;
    categoryName: string;
    amount: string;
    scheduledDate: string;
    note: string | null;
  }>;
};

export const listUnresolvedSchedules: ToolDef<z.infer<typeof Args>, Result> = {
  name: "listUnresolvedSchedules",
  description:
    "List unresolved past-due scheduled spends — schedules whose date has passed " +
    "without a matching transaction. Used by the daily brief to ask about missing expenses.",
  args: Args,
  async run(ctx, _args) {
    const r = await listScheduledSpendsService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { status: "unresolved" },
    );
    const catIds = Array.from(new Set(r.schedules.map((s) => s.categoryId)));
    const cats = await prisma.category.findMany({
      where: { id: { in: catIds }, workspaceId: ctx.workspaceId },
      select: { id: true, name: true },
    });
    const catNameById = new Map(cats.map((c) => [c.id, c.name]));
    return {
      schedules: r.schedules.map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        categoryName: catNameById.get(s.categoryId) ?? "Unknown",
        amount: s.amount,
        scheduledDate: s.scheduledDate,
        note: s.note,
      })),
    };
  },
};
```

`apps/api/src/chat/tools/dismiss-scheduled-spend.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "./types.js";
import { dismissScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  schedule_id: z.string().min(1),
});

type Result =
  | { schedule: { id: string; dismissedAt: string } }
  | { dismissed: false; alreadyDismissed: true };

export const dismissScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "dismissScheduledSpend",
  description: "Dismiss a scheduled spend that didn't happen — marks it resolved without finding a matching transaction.",
  args: Args,
  async run(ctx, args) {
    return await dismissScheduledSpendService(
      { workspaceId: ctx.workspaceId },
      args.schedule_id,
    );
  },
};
```

`apps/api/src/chat/tools/remove-scheduled-spend.ts`:

```ts
import { z } from "zod";
import type { ToolDef } from "./types.js";
import { removeScheduledSpendService } from "../../schedules/service.js";

const Args = z.object({
  schedule_id: z.string().min(1),
});

type Result =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export const removeScheduledSpend: ToolDef<z.infer<typeof Args>, Result> = {
  name: "removeScheduledSpend",
  description: "Permanently delete a scheduled spend. Use when the user wants the schedule entirely gone (vs. just dismissed).",
  args: Args,
  async run(ctx, args) {
    return await removeScheduledSpendService(
      { workspaceId: ctx.workspaceId },
      args.schedule_id,
    );
  },
};
```

### Step 4: Register tools in chat/tools/index.ts

Edit `apps/api/src/chat/tools/index.ts`. Add the 5 imports and add to the `REGISTRY` export:

```ts
import { addScheduledSpend } from "./add-scheduled-spend.js";
import { listScheduledSpends } from "./list-scheduled-spends.js";
import { listUnresolvedSchedules } from "./list-unresolved-schedules.js";
import { dismissScheduledSpend } from "./dismiss-scheduled-spend.js";
import { removeScheduledSpend } from "./remove-scheduled-spend.js";

// ... existing imports ...

export const REGISTRY: ToolDef[] = [
  // ... existing tools ...
  addScheduledSpend as ToolDef,
  listScheduledSpends as ToolDef,
  listUnresolvedSchedules as ToolDef,
  dismissScheduledSpend as ToolDef,
  removeScheduledSpend as ToolDef,
];
```

(Match the exact style of the existing registry — the `as ToolDef` cast pattern is from `categorize-transaction` registration. If the file uses a different pattern, follow that.)

### Step 5: Run tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.scheduled-spends.test.ts
```

Expected: all PASS.

### Step 6: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 7: Commit

```bash
git add apps/api/src/chat/tools/add-scheduled-spend.ts \
        apps/api/src/chat/tools/list-scheduled-spends.ts \
        apps/api/src/chat/tools/list-unresolved-schedules.ts \
        apps/api/src/chat/tools/dismiss-scheduled-spend.ts \
        apps/api/src/chat/tools/remove-scheduled-spend.ts \
        apps/api/src/chat/tools/index.ts \
        apps/api/tests/chat.tools.scheduled-spends.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): chat tools

5 new chat tools: addScheduledSpend (resolves category by name),
listScheduledSpends (with status filter), listUnresolvedSchedules
(daily-brief entry point), dismissScheduledSpend, removeScheduledSpend.

Registered in chat/tools/index.ts REGISTRY.
EOF
)"
```

---

## Task 7: Confirmation / audit registration

**Files:**
- Modify: `apps/api/src/intents/service.ts` (add 3 write tools to `CONFIRMABLE_TOOLS`)
- Modify: `apps/api/src/audit/service.ts` (add 3 entries to `AUDIT_WRITE_TOOLS` + `TARGET_TYPE_MAP` + `extractTargetId` switch)
- Modify: `apps/api/src/chat/tools/present-confirm-card.ts` (extend the description text enumerating confirmable tools)
- Modify (existing tests touching the lists)

**Spec refs:** §4.3, §7 (file list).

### Step 1: Update CONFIRMABLE_TOOLS

Edit `apps/api/src/intents/service.ts`. Extend the tuple:

```ts
export const CONFIRMABLE_TOOLS = [
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
  "addScheduledSpend",        // NEW
  "dismissScheduledSpend",    // NEW
  "removeScheduledSpend",     // NEW
] as const;
```

### Step 2: Update audit service

Edit `apps/api/src/audit/service.ts`:

```ts
export const AUDIT_WRITE_TOOLS = new Set([
  "categorizeTransaction",
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
  "addScheduledSpend",        // NEW
  "dismissScheduledSpend",    // NEW
  "removeScheduledSpend",     // NEW
]);

const TARGET_TYPE_MAP: Record<string, string> = {
  categorizeTransaction: "transaction",
  createCategory: "category",
  addTransactionNote: "transaction",
  setBudget: "budget",
  mapMerchantToCategory: "merchant_mapping",
  addRecurring: "recurring_expense",
  removeRecurring: "recurring_expense",
  addScheduledSpend: "scheduled_spend",        // NEW
  dismissScheduledSpend: "scheduled_spend",    // NEW
  removeScheduledSpend: "scheduled_spend",     // NEW
};
```

In `extractTargetId`, add cases:

```ts
export function extractTargetId(action: string, result: unknown): string | null {
  // ... existing cases unchanged ...

  if (action === "addScheduledSpend") {
    const s = (result as any)?.schedule as Record<string, unknown> | undefined;
    return typeof s?.id === "string" ? s.id : null;
  }
  if (action === "dismissScheduledSpend") {
    // result is either { schedule: {id} } or { dismissed: false }
    const s = (result as any)?.schedule as Record<string, unknown> | undefined;
    return typeof s?.id === "string" ? s.id : null;
  }
  if (action === "removeScheduledSpend") {
    // result is { removed: bool, alreadyRemoved?: true } — no id returned.
    // Best-effort: pull from the original intent's args if it ever lands here.
    // For v1, return null (audit row is still created, just without targetId).
    return null;
  }
  return null;
}
```

### Step 3: Update present-confirm-card description

Edit `apps/api/src/chat/tools/present-confirm-card.ts`. The file contains a literal description string (around line 21) of the form:

```
"... accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring. Server validates ..."
```

Splice the three new tool names into the comma list (after `removeRecurring`, before the period):

```
"... accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring, addScheduledSpend, dismissScheduledSpend, removeScheduledSpend. Server validates ..."
```

Preserve the surrounding text exactly — only the comma-list inside the sentence is extended.

### Step 4: Run intent + audit tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/intents.service.test.ts tests/audit.service.test.ts
```

Expected: all PASS. If any test asserts the size or contents of the lists, update it to include the new entries.

### Step 5: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 6: Commit

```bash
git add apps/api/src/intents/service.ts \
        apps/api/src/audit/service.ts \
        apps/api/src/chat/tools/present-confirm-card.ts \
        apps/api/tests/intents.service.test.ts \
        apps/api/tests/audit.service.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): register write tools in confirmation + audit

CONFIRMABLE_TOOLS gains addScheduledSpend, dismissScheduledSpend,
removeScheduledSpend so the LLM routes them through the existing
intent/confirmation flow. AUDIT_WRITE_TOOLS + TARGET_TYPE_MAP +
extractTargetId switch updated for audit coverage parity with
other write tools (target_type = "scheduled_spend").
EOF
)"
```

---

## Task 8: Budget integration (planned field)

**Files:**
- Modify: `apps/api/src/budgets/service.ts` (`compareSpendingVsBudgetService` adds planned aggregation)
- Modify: `apps/api/src/chat/tools/compare-spending-vs-budget.ts` (Result type + serialization)
- Modify: `apps/api/tests/budgets.service.test.ts` (new tests for planned)

**Spec refs:** §6.

### Step 1: Write failing budget tests

Append to `apps/api/tests/budgets.service.test.ts`:

```ts
describe("compareSpendingVsBudget — planned aggregation", () => {
  it("includes upcoming schedule in planned", async () => {
    const { wsId, userId } = await setupEditor("bp-up@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BPcat" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 200, period: "this_month" });
    // Compute today + 1 day to keep it in current month
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "60", scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === cat.id)!;
    expect(item.planned).toBe("60.00");
    expect(item.plannedPct).toBeGreaterThan(0);
  });

  it("excludes past-unresolved from planned", async () => {
    const { wsId, userId } = await setupEditor("bp-past@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BPpast" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 200, period: "this_month" });
    // Past unresolved schedule (1 day ago)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "70", scheduledDate: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === cat.id)!;
    expect(item.planned).toBe("0.00");
  });

  it("excludes dismissed from planned", async () => {
    const { wsId, userId } = await setupEditor("bp-dis@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BPdis" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 200, period: "this_month" });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "40", scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
        dismissedAt: new Date(),
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === cat.id)!;
    expect(item.planned).toBe("0.00");
  });

  it("excludes matched (active tx) from planned", async () => {
    const { wsId, userId } = await setupEditor("bp-matched@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BPmatched" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 200, period: "this_month" });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "55", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 12, 0, 0)),
        pending: false, source: "manual", rawData: {},
      },
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id,
        amount: "55", scheduledDate: new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
        matchedTxId: tx.id,
      },
    });
    const r = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === cat.id)!;
    expect(item.planned).toBe("0.00");
  });

  it("anti-join: today schedule with covering tx → planned=0; with NO covering tx → planned=amount", async () => {
    const { wsId, userId } = await setupEditor("bp-antij@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BPantij" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 200, period: "this_month" });
    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    // Case 1: schedule for today, NO covering tx → planned = 80
    await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId: cat.id, amount: "80", scheduledDate: todayUTC },
    });
    const r1 = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item1 = r1.items.find((i) => i.categoryId === cat.id)!;
    expect(item1.planned).toBe("80.00");

    // Case 2: add a covering tx → planned = 0 (anti-join filters it out)
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "80", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0)),
        pending: false, source: "manual", rawData: {},
      },
    });
    const r2 = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item2 = r2.items.find((i) => i.categoryId === cat.id)!;
    expect(item2.planned).toBe("0.00");
  });

  it("two same-day same-cat schedules + one covering tx → second still planned", async () => {
    const { wsId, userId } = await setupEditor("bp-2to1@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "BP2to1" } });
    await setBudgetService({ workspaceId: wsId, userId }, { categoryId: cat.id, amount: 500, period: "this_month" });
    const today = new Date();
    const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: null,
        amount: "30", merchantRaw: "T", merchantNormalized: "t",
        occurredAt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12, 0, 0)),
        pending: false, source: "manual", rawData: {},
      },
    });

    // First schedule matched (cron-equivalent)
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id, amount: "100",
        scheduledDate: todayUTC, matchedTxId: tx.id,
      },
    });
    // Second schedule unmatched
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId: cat.id, amount: "60",
        scheduledDate: todayUTC,
      },
    });

    const r = await compareSpendingVsBudgetService({ workspaceId: wsId, userId }, { period: "this_month" });
    const item = r.items.find((i) => i.categoryId === cat.id)!;
    // The matched tx is consumed by the first schedule; second schedule's $60 still contributes.
    expect(item.planned).toBe("60.00");
  });
});
```

### Step 2: Run, verify failure

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/budgets.service.test.ts
```

Expected: FAIL — `planned`/`plannedPct` fields don't exist yet.

### Step 3: Extend compareSpendingVsBudgetService

Edit `apps/api/src/budgets/service.ts`. Update the response type:

```ts
export type CompareSpendingOutput = {
  period: { start: string; end: string };
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;
    spent: string;
    planned: string;           // NEW
    remaining: string;
    spentPct: number;
    plannedPct: number;        // NEW
    todayPct: number;
    status: "on-pace" | "over-pace";
  }>;
};
```

Find `compareSpendingVsBudgetService`. After the existing `sums` groupBy (around line 162-175), add the planned aggregation. Note: the existing function already computes `periodStart`, `gte`, `lt`, and resolves user tz indirectly. Use those.

Add to the existing imports at the top of `apps/api/src/budgets/service.ts`:
```ts
import { resolveUserTz, dateKeyInTz, partsInTz } from "../chat/tools/periods.js";
```

After the existing `sums` groupBy that computes spent, append the planned aggregation:

```ts

// 1. Compute schedule date bounds (calendar DATE, not tx instant range).
const tz = await resolveUserTz(ctx.userId);
const todayParts = partsInTz(new Date(), tz);
const todayDateOnly = new Date(Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day));
// periodStart and the spent range gte/lt are already computed earlier in this function.
// For next_month, periodStart is set such that `lt = periodStart` makes the tx range
// zero-length. Schedule bounds need their own calendar DATEs:
const scheduleLowerBound = todayDateOnly >= periodStart ? todayDateOnly : periodStart;
// scheduleUpperBound = first-of-month of (periodStart + 1 month), as a UTC DATE.
// daysInMonth already exists; compute via Date.UTC arithmetic.
const psYear = periodStart.getUTCFullYear();
const psMonth = periodStart.getUTCMonth();  // 0-11
const scheduleUpperBound = new Date(Date.UTC(psYear, psMonth + 1, 1));

let plannedByCat = new Map<string, Prisma.Decimal>();
if (scheduleLowerBound < scheduleUpperBound) {
  // 2. Load candidate schedules.
  const candidates = await prisma.scheduledSpend.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      categoryId: { in: budgetCategoryIds },
      scheduledDate: { gte: scheduleLowerBound, lt: scheduleUpperBound },
      matchedTxId: null,
      dismissedAt: null,
    },
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, categoryId: true, scheduledDate: true, amount: true },
  });

  if (candidates.length > 0) {
    const scheduleBucketKey = (d: Date, catId: string) =>
      `${d.toISOString().slice(0, 10)}|${catId}`;
    const txBucketKey = (occurredAt: Date, catId: string) =>
      `${dateKeyInTz(occurredAt, tz)}|${catId}`;
    const uniqueBuckets = new Set(candidates.map((s) => scheduleBucketKey(s.scheduledDate, s.categoryId)));

    // 3. Load tx allocations covering the candidate days.
    const txLowerBound = new Date(scheduleLowerBound.getTime() - 24 * 60 * 60 * 1000);
    const txUpperBound = new Date(scheduleUpperBound.getTime() + 24 * 60 * 60 * 1000);
    const allocs = await prisma.transactionAllocation.findMany({
      where: {
        categoryId: { in: budgetCategoryIds },
        amount: { gt: 0 },
        transaction: {
          workspaceId: ctx.workspaceId,
          removedAt: null,
          amount: { gt: 0 },
          occurredAt: { gte: txLowerBound, lt: txUpperBound },
        },
      },
      select: {
        categoryId: true,
        transaction: { select: { id: true, occurredAt: true } },
      },
    });

    const txIdsByBucket = new Map<string, Set<string>>();
    for (const a of allocs) {
      const key = txBucketKey(a.transaction.occurredAt, a.categoryId);
      if (!uniqueBuckets.has(key)) continue;
      if (!txIdsByBucket.has(key)) txIdsByBucket.set(key, new Set());
      txIdsByBucket.get(key)!.add(a.transaction.id);
    }

    // 3b. Subtract tx ids already consumed by matched schedules in the same date range.
    const matchedSchedules = await prisma.scheduledSpend.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        matchedTxId: { not: null },
        categoryId: { in: budgetCategoryIds },
        matchedTx: { occurredAt: { gte: txLowerBound, lt: txUpperBound } },
      },
      select: {
        matchedTxId: true,
        categoryId: true,
        matchedTx: { select: { occurredAt: true } },
      },
    });
    for (const m of matchedSchedules) {
      if (!m.matchedTx) continue;
      const key = txBucketKey(m.matchedTx.occurredAt, m.categoryId);
      txIdsByBucket.get(key)?.delete(m.matchedTxId!);
    }

    // 4. Per-bucket consumption.
    const schedulesByBucket = new Map<string, typeof candidates>();
    for (const s of candidates) {
      const key = scheduleBucketKey(s.scheduledDate, s.categoryId);
      if (!schedulesByBucket.has(key)) schedulesByBucket.set(key, []);
      schedulesByBucket.get(key)!.push(s);
    }
    for (const [bucket, schedules] of schedulesByBucket) {
      const T = txIdsByBucket.get(bucket)?.size ?? 0;
      for (const s of schedules.slice(T)) {
        plannedByCat.set(s.categoryId, (plannedByCat.get(s.categoryId) ?? new Prisma.Decimal(0)).plus(s.amount));
      }
    }
  }
}

// 5. Plug planned into the items mapping.
const items = budgets.map((b) => {
  const spent = spentByCat.get(b.categoryId) ?? new Prisma.Decimal(0);
  const planned = plannedByCat.get(b.categoryId) ?? new Prisma.Decimal(0);
  const remaining = b.amount.minus(spent).minus(planned);
  const spentPct = b.amount.greaterThan(0)
    ? Number(spent.div(b.amount).times(100).toFixed(2))
    : 0;
  const plannedPct = b.amount.greaterThan(0)
    ? Number(planned.div(b.amount).times(100).toFixed(2))
    : 0;
  const status: "on-pace" | "over-pace" = spentPct <= todayPct * 1.05 ? "on-pace" : "over-pace";
  return {
    categoryId: b.categoryId,
    categoryName: b.category.name,
    amount: b.amount.toFixed(2),
    spent: spent.toFixed(2),
    planned: planned.toFixed(2),
    remaining: remaining.toFixed(2),
    spentPct,
    plannedPct,
    todayPct,
    status,
  };
});
```

The `computeMonthEnd` and `offsetFor` helpers should already exist in `budgets/service.ts` (they're used for the existing tx range). If not, factor a small helper.

### Step 4: Extend chat tool Result type

Edit `apps/api/src/chat/tools/compare-spending-vs-budget.ts`. Find the `Result` type and add `planned` + `plannedPct`:

```ts
type Result = {
  period: { start: string; end: string };
  items: Array<{
    categoryId: string;
    categoryName: string;
    amount: string;
    spent: string;
    planned: string;         // NEW
    remaining: string;
    spentPct: number;
    plannedPct: number;      // NEW
    todayPct: number;
    status: "on-pace" | "over-pace";
  }>;
};
```

The tool's `run` function already passes the full service result through; no other code changes needed unless the tool was hand-mapping fields.

### Step 5: Run budget tests

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/budgets.service.test.ts tests/chat.tools.compare-spending-vs-budget.test.ts
```

Expected: all PASS.

### Step 6: Run full suite

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

### Step 7: Commit

```bash
git add apps/api/src/budgets/service.ts \
        apps/api/src/chat/tools/compare-spending-vs-budget.ts \
        apps/api/tests/budgets.service.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-scheduled-spend): planned aggregation in compareSpendingVsBudget

Adds `planned` + `plannedPct` to CompareSpendingOutput.items. Uses
per-bucket anti-join: candidate schedules (matchedTxId NULL,
dismissedAt NULL, scheduledDate in [max(today, periodStart),
scheduleUpperBound)) grouped by (date, categoryId); covering tx counted
per bucket with Set<txId> dedup; subtract tx ids already consumed by
matched schedules (using matchedTx.occurredAt + caller's tz for the
bucket key); first min(T, S) schedules covered, rest contribute to
planned.

Past unresolved schedules are NOT counted (would inflate planned
indefinitely). Refund tx excluded (amount > 0 on both tx and
allocation).

compare-spending-vs-budget chat tool Result type extended.
EOF
)"
```

---

## Task 9: Smoke test doc

**Files:**
- Create: `docs/superpowers/smoke-tests/2026-05-20-plan-1c-scheduled-spend.md`

### Step 1: Create smoke doc

````markdown
# Smoke Test — Plan 1C-scheduled-spend

**Goal:** validate ScheduledSpend end-to-end against a running local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$CAT_ID` below.

## Setup — create a category

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"name":"Dental"}'
```
Capture id → `$CAT_ID`.

## 1. POST create schedule

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":300,\"scheduledDate\":\"2099-12-25\",\"note\":\"dental visit\"}"
```
Expected: 201, body has `schedule.id`, `amount: "300"`, `scheduledDate: "2099-12-25"`.
Capture id → `$SCH`.

## 2. GET list — derived status

```bash
curl -sS "http://localhost:3001/workspaces/$WS/schedules?status=all" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: the schedule appears with `status: "upcoming"`.

## 3. Manual tx in same category + date

Create a manual tx matching the schedule's category + date:
```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"merchantRaw\":\"Dentist\",\"amount\":300,\"occurredAt\":\"2099-12-25\",\"categoryId\":\"$CAT_ID\"}"
```
Expected: 201.

## 4. Trigger cron manually

Open the API process, OR temporarily call the match function via a one-shot script:
```bash
DATABASE_URL=... pnpm --filter @fina/api exec tsx -e "import('./apps/api/src/schedules/match.js').then(({matchScheduledSpends}) => matchScheduledSpends('$WS', new Date('2099-12-25')))"
```
(Or restart the dev server with cron enabled and wait until 09:05 UTC.)

## 5. GET list again — matched status

```bash
curl -sS "http://localhost:3001/workspaces/$WS/schedules?status=all" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: schedule's `status` is `"resolved-matched"`, `matchedTxId` is set.

## 6. Dismiss flow on a different schedule

Create a second past schedule and dismiss it.
```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":50,\"scheduledDate\":\"2020-01-01\"}"
# capture id → $SCH2
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules/$SCH2/dismiss" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `schedule.dismissedAt` set. GET shows `status: "resolved-dismissed"`.

## 7. Idempotent dismiss

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules/$SCH2/dismiss" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ dismissed: false, alreadyDismissed: true }`.

## 8. DELETE schedule

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/schedules/$SCH" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ removed: true }`.

## 9. DELETE idempotent

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/schedules/$SCH" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: 200, `{ removed: false, alreadyRemoved: true }`.

## 10. Budget shows `planned`

Set a budget for `$CAT_ID`, then create an upcoming schedule and call `compare-spending-vs-budget`:
```bash
# Set budget for Dental this_month
curl -sS -X POST "http://localhost:3001/workspaces/$WS/budgets" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":500,\"period\":\"this_month\"}"

# Add an upcoming schedule for this month (date = today + 1, in current month)
curl -sS -X POST "http://localhost:3001/workspaces/$WS/schedules" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":150,\"scheduledDate\":\"<tomorrow YYYY-MM-DD>\"}"

# Compare
curl -sS "http://localhost:3001/workspaces/$WS/chat/tools/compare-spending-vs-budget?period=this_month" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```
Expected: the Dental item has `planned: "150.00"` and `plannedPct: 30`.

## Result

Record PASS/FAIL for each of the 10 steps. All PASS = ship.
````

### Step 2: Commit

```bash
git add docs/superpowers/smoke-tests/2026-05-20-plan-1c-scheduled-spend.md
git commit -m "$(cat <<'EOF'
docs(plan 1c-scheduled-spend): smoke test doc

Ten curl-based steps: create schedule, list with derived status,
manual tx match, cron match, dismissed status, idempotent dismiss,
hard delete, idempotent delete, budget planned aggregation.
EOF
)"
```

---

## Plan Self-Review

**Spec coverage check** (§-by-§ against the spec):

| Spec section | Implemented in |
|---|---|
| §1 Goal / out of scope | All tasks |
| §2 Decisions table | Mapped across tasks |
| §3.1 New table | Task 1 |
| §3.2 Derived state | Task 2 (deriveStatus) + Task 8 (planned semantics) |
| §3.3 Migration | Task 1 |
| §4.1 Chat tools shapes | Task 6 |
| §4.2 HTTP routes + error mapping | Task 5 |
| §4.3 Confirmation flow | Task 7 |
| §5.1 Cron placement | Task 3 step 6 |
| §5.2 Match algorithm | Task 3 |
| §5.3 Edge cases | Task 3 tests |
| §5.4 Soft-removal cleanup hook | Task 4 |
| §6.1 Budget anti-join | Task 8 |
| §6.2 Response shape | Task 8 |
| §7 File list | Tasks 1-9 cover the listed files |
| §7.1 Service signatures | Task 2 (CRUD) + Task 3 (match) |
| §8.1 Service tests | Task 2 |
| §8.2 Match tests | Task 3 |
| §8.3 Budget tests | Task 8 |
| §8.4 Cron tests | Task 3 (matchScheduledSpends covers; the wrapping cron job is a thin loop — additional cron-job-runner tests could be added but not required per spec) |
| §8.5 Route tests | Task 5 |
| §8.6 Chat tool tests | Task 6 |
| §8.7 Smoke | Task 9 |

**Placeholder scan:** No "TBD" / "fill in" — every step has concrete code or commands. One judgment-call: Task 3's `utcMidnightInTz` helper is inlined in `match.ts`; the spec mentions a "match the periods.ts pattern" — the helper is small enough to inline.

**Type consistency:**
- `ScheduledSpendError.code` union matches between Task 2 service and Task 5 route's `statusFromCode` switch.
- `ScheduledSpendStatus` is exported from service (Task 2) and consumed by chat tool (Task 6).
- `DismissResult` and `RemoveResult` shapes match across service → route → chat tool.
- `compareSpendingVsBudget` chat tool `Result` (Task 8) extends `CompareSpendingOutput` shape (Task 8) with `planned`/`plannedPct`.

No issues found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-plan-1c-scheduled-spend.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec + quality) between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints for review.

Which approach?
