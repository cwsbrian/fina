# Plan 1C-add-transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `POST /workspaces/:id/transactions/manual` so all-tier users can add transactions that did not come through Plaid sync.

**Architecture:** Add `Workspace.currency` (default `"CAD"`). New service `createManualTransactionService` wraps validation + advisory-locked find-or-create of a "Cash" manual `BankAccount` (`plaidItemId IS NULL`) + transaction insert inside one `prisma.$transaction`. Route handler (editor+, no Pro gate) lives in the existing `apps/api/src/routes/transactions.ts`.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres (`pg_advisory_xact_lock`), Vitest (singleFork), Zod.

**Spec:** [`docs/superpowers/specs/2026-05-17-plan-1c-add-transaction-design.md`](../specs/2026-05-17-plan-1c-add-transaction-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `currency String @default("CAD")` to `Workspace` |
| `apps/api/prisma/migrations/<ts>_add_workspace_currency/migration.sql` | DDL: `ALTER TABLE` add column with default |
| `apps/api/src/transactions/create-manual.ts` | `CreateManualTxInput`/`CreateManualTxResult` types, `CreateManualTxError`, `createManualTransactionService` |
| `apps/api/src/routes/transactions.ts` | Add `POST /workspaces/:id/transactions/manual` handler |
| `apps/api/tests/transactions.create-manual.test.ts` | ~13 service + route cases |

No new dependencies. No HTTP routes other than the one POST.

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

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Tests: `82 passed / 681 passed`.

---

## Task 1: Workspace.currency migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_workspace_currency/migration.sql`

### 1.1 Add the field

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`** — find `model Workspace { ... }` and add this line after `updatedAt`:

```prisma
  currency           String        @default("CAD")
```

Keep the rest of the model unchanged.

### 1.2 Generate + apply migration

- [ ] **Step 2: Generate migration skeleton**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_workspace_currency 2>&1 | tail -20
```

READ the generated `migration.sql`. It should contain ONE statement:

```sql
ALTER TABLE "workspaces" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'CAD';
```

The `NOT NULL DEFAULT 'CAD'` is critical — it backfills every existing row to `'CAD'` without manual intervention.

Strip any unrelated `DROP INDEX` stub (recurring issue on this repo for the NULLS LAST chat_threads index).

- [ ] **Step 3: Apply to both DBs + regen**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
```

- [ ] **Step 4: Confirm baseline still passes**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** 82 files / 681 tests still PASS. (The new column has a default; existing code that creates workspaces without `currency` continues to work.)

### 1.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-add-transaction): Workspace.currency + migration"
```

---

## Task 2: createManualTransactionService (TDD)

**Files:**
- Create: `apps/api/src/transactions/create-manual.ts`
- Create: `apps/api/tests/transactions.create-manual.test.ts`

### 2.1 Write the failing tests

- [ ] **Step 1: Create `apps/api/tests/transactions.create-manual.test.ts`** with this content:

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import {
  createManualTransactionService,
  CreateManualTxError,
} from "../src/transactions/create-manual.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
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

async function setupEditor(email: string): Promise<{
  cookie: string; wsId: string; userId: string;
}> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("createManualTransactionService", () => {
  it("auto-creates a Cash manual account on first call", async () => {
    const { wsId, userId } = await setupEditor("mt1@t.co");
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Starbucks", amount: 6.75, occurredAt: "2026-05-17" },
    );
    expect(result.transaction.source).toBe("manual");
    expect(result.transaction.merchantNormalized).toBe("starbucks");
    expect(result.transaction.currency).toBe("CAD");
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.name).toBe("Cash");
    expect(accounts[0]!.type).toBe("depository");
    expect(accounts[0]!.currency).toBe("CAD");
  });

  it("reuses the existing manual account on second call", async () => {
    const { wsId, userId } = await setupEditor("mt2@t.co");
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" },
    );
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" },
    );
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
    expect(txs).toHaveLength(2);
    expect(new Set(txs.map((t) => t.accountId))).toEqual(new Set([accounts[0]!.id]));
  });

  it("accepts explicit accountId when plaidItemId IS NULL", async () => {
    const { wsId, userId } = await setupEditor("mt3@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Wallet", type: "depository", currency: "CAD" },
    });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
    );
    expect(result.transaction.accountId).toBe(acct.id);
  });

  it("rejects accountId from another workspace", async () => {
    const a = await setupEditor("mta@t.co");
    const b = await setupEditor("mtb@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: b.wsId, name: "Other", type: "depository", currency: "CAD" },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: a.wsId, userId: a.userId },
        { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
      ),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rejects accountId that has plaidItemId set", async () => {
    const { wsId, userId } = await setupEditor("mtp@t.co");
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: wsId,
        itemId: `pi-${Date.now()}`,
        accessTokenCiphertext: Buffer.from([0]),
        accessTokenIv: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        institutionId: "ins-1",
        institutionName: "RBC",
      },
    });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, plaidItemId: item.id, plaidAccountId: "pa-1", name: "Plaid Chequing", type: "depository", currency: "CAD" },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 5, occurredAt: "2026-05-17", accountId: acct.id },
      ),
    ).rejects.toMatchObject({ code: "account_not_found" });
  });

  it("rejects amount <= 0", async () => {
    const { wsId, userId } = await setupEditor("mtam@t.co");
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 0, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: -1, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 1_000_000_000, occurredAt: "2026-05-17" }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects bad occurredAt strings", async () => {
    const { wsId, userId } = await setupEditor("mtdt@t.co");
    for (const bad of ["2026-13-01", "2026-05-32", "not-a-date", "", "2026-5-1"]) {
      await expect(
        createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "X", amount: 1, occurredAt: bad }),
      ).rejects.toMatchObject({ code: "invalid_date" });
    }
  });

  it("defaults occurredAt to today (UTC noon) when omitted", async () => {
    const { wsId, userId } = await setupEditor("mtdef@t.co");
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1 },
    );
    const occurred = new Date(result.transaction.occurredAt);
    expect(occurred.getUTCHours()).toBe(12);
    // Within ±1 day of "now" (handles tz boundary near midnight)
    const diffMs = Math.abs(occurred.getTime() - Date.now());
    expect(diffMs).toBeLessThan(48 * 60 * 60 * 1000);
  });

  it("rejects archived category", async () => {
    const { wsId, userId } = await setupEditor("mtcat@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Archived", nameNormalized: "archived", archivedAt: new Date() },
    });
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17", categoryId: cat.id },
      ),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects note > 1000 chars", async () => {
    const { wsId, userId } = await setupEditor("mtnt@t.co");
    await expect(
      createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17", note: "x".repeat(1001) },
      ),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });

  it("Transaction.currency inherits Workspace.currency", async () => {
    const { wsId, userId } = await setupEditor("mtcur@t.co");
    await prisma.workspace.update({ where: { id: wsId }, data: { currency: "USD" } });
    const result = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17" },
    );
    expect(result.transaction.currency).toBe("USD");
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(acct.currency).toBe("USD");
  });

  it("race: two concurrent first-time calls produce exactly one Cash account", async () => {
    const { wsId, userId } = await setupEditor("mtrace@t.co");
    const [r1, r2] = await Promise.all([
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "A", amount: 1, occurredAt: "2026-05-17" }),
      createManualTransactionService({ workspaceId: wsId, userId }, { merchantRaw: "B", amount: 2, occurredAt: "2026-05-17" }),
    ]);
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
    expect(accounts).toHaveLength(1);
    expect(r1.transaction.accountId).toBe(accounts[0]!.id);
    expect(r2.transaction.accountId).toBe(accounts[0]!.id);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/transactions.create-manual.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.2 Implement the service

- [ ] **Step 3: Create `apps/api/src/transactions/create-manual.ts`**

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import { dateKeyInTz, resolveUserTz } from "../chat/tools/periods.js";

export type CreateManualTxInput = {
  merchantRaw: string;
  amount: number;
  occurredAt?: string;
  categoryId?: string;
  note?: string;
  accountId?: string;
};

export type CreateManualTxResult = {
  transaction: {
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;
    note: string | null;
    source: "manual";
    accountId: string;
    createdAt: string;
  };
};

type ErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_note"
  | "invalid_merchant"
  | "category_not_found"
  | "account_not_found";

export class CreateManualTxError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_AMOUNT = 999_999_999.99;

function validateMerchantRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new CreateManualTxError("invalid_merchant");
  }
  return trimmed;
}

function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new CreateManualTxError("invalid_amount");
  }
}

function validateNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  if (note.length > 1000) throw new CreateManualTxError("invalid_note");
  return note;
}

function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new CreateManualTxError("invalid_date");
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new CreateManualTxError("invalid_date");
  }
  return d;
}

export async function createManualTransactionService(
  ctx: { workspaceId: string; userId: string },
  input: CreateManualTxInput,
): Promise<CreateManualTxResult> {
  const merchantRaw = validateMerchantRaw(input.merchantRaw);
  validateAmount(input.amount);
  const note = validateNote(input.note);

  let occurredAt: Date;
  if (input.occurredAt === undefined) {
    // Resolve tz BEFORE the $transaction to avoid pool deadlock with
    // the advisory-lock interactive transaction.
    const tz = await resolveUserTz(ctx.userId);
    const todayKey = dateKeyInTz(new Date(), tz);
    occurredAt = parseOccurredAt(todayKey);
  } else {
    occurredAt = parseOccurredAt(input.occurredAt);
  }

  const merchantNormalized = normalizeMerchant(merchantRaw);

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.workspaceId}))`;

    if (input.categoryId !== undefined) {
      const cat = await tx.category.findFirst({
        where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new CreateManualTxError("category_not_found");
    }

    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });

    let account: { id: string };
    if (input.accountId !== undefined) {
      const found = await tx.bankAccount.findFirst({
        where: { id: input.accountId, workspaceId: ctx.workspaceId, plaidItemId: null },
        select: { id: true },
      });
      if (!found) throw new CreateManualTxError("account_not_found");
      account = found;
    } else {
      const existing = await tx.bankAccount.findFirst({
        where: { workspaceId: ctx.workspaceId, plaidItemId: null },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (existing) {
        account = existing;
      } else {
        account = await tx.bankAccount.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: "Cash",
            type: "depository",
            currency: workspace.currency,
            status: "active",
          },
          select: { id: true },
        });
      }
    }

    const row = await tx.transaction.create({
      data: {
        workspaceId: ctx.workspaceId,
        accountId: account.id,
        plaidItemId: null,
        plaidTransactionId: null,
        amount: new Prisma.Decimal(input.amount),
        currency: workspace.currency,
        merchantRaw,
        merchantNormalized,
        categoryId: input.categoryId ?? null,
        occurredAt,
        postedAt: null,
        pending: false,
        source: "manual",
        rawData: {} as Prisma.InputJsonValue,
        note,
        categorizationSource: input.categoryId !== undefined ? "manual" : null,
      },
    });

    return {
      transaction: {
        id: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        categoryId: row.categoryId,
        occurredAt: row.occurredAt.toISOString(),
        note: row.note,
        source: "manual",
        accountId: row.accountId,
        createdAt: row.createdAt.toISOString(),
      },
    };
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/transactions.create-manual.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** all 12 service cases pass.

### 2.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/transactions/create-manual.ts apps/api/tests/transactions.create-manual.test.ts
git commit -m "feat(plan 1c-add-transaction): createManualTransactionService"
```

---

## Task 3: HTTP route

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/tests/transactions.create-manual.test.ts` (append route test)

### 3.1 Add the route test

- [ ] **Step 1: Append to `apps/api/tests/transactions.create-manual.test.ts`** at the bottom of the file (after the existing `describe` block):

```typescript
async function makeFree(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true },
  });
}

describe("POST /workspaces/:id/transactions/manual", () => {
  it("201 happy path for Free-tier user (no Pro gate)", async () => {
    const { cookie, wsId, userId } = await setupEditor("mtroute@t.co");
    await makeFree(userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { merchantRaw: "Tim Hortons", amount: 4.5, occurredAt: "2026-05-17" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { transaction: { source: string; merchantNormalized: string } };
    expect(body.transaction.source).toBe("manual");
    expect(body.transaction.merchantNormalized).toBe("tim hortons");
  });

  it("400 workspace_mismatch when X-Workspace-Id differs from path", async () => {
    const a = await setupEditor("mtwm1@t.co");
    const b = await setupEditor("mtwm2@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.wsId}/transactions/manual`,
      headers: { cookie: a.cookie, "x-workspace-id": b.wsId, "content-type": "application/json" },
      payload: { merchantRaw: "X", amount: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "workspace_mismatch" });
  });

  it("400 invalid_body when required fields missing", async () => {
    const { cookie, wsId } = await setupEditor("mtbad@t.co");
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { amount: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("403 insufficient_role for viewer", async () => {
    const owner = await setupEditor("mtown@t.co");
    const viewer = await setupEditor("mtvw@t.co");
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: owner.wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.wsId}/transactions/manual`,
      headers: { cookie: viewer.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: { merchantRaw: "X", amount: 1 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient_role" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL (route not registered)**

```bash
pnpm --filter @fina/api exec vitest run tests/transactions.create-manual.test.ts --reporter=basic 2>&1 | tail -10
```

### 3.2 Add the route handler

- [ ] **Step 3: Edit `apps/api/src/routes/transactions.ts`** — append the new handler INSIDE `transactionsRoutes(app)` (after the existing handlers, before the closing `}` of the function).

First add the import at the top (if not already imported) — `requireWorkspaceContext` and `HttpError` are already imported in this file. Add the new service import alongside:

```typescript
import {
  createManualTransactionService,
  CreateManualTxError,
  type CreateManualTxInput,
} from "../transactions/create-manual.js";
```

And add the Zod body schema near the existing `QuerySchema` (top of file):

```typescript
const ManualTxBody = z.object({
  merchantRaw: z.string(),
  amount: z.number(),
  occurredAt: z.string().optional(),
  categoryId: z.string().optional(),
  note: z.string().optional(),
  accountId: z.string().optional(),
});
```

Then add the handler inside `transactionsRoutes`:

```typescript
app.post<{ Params: { id: string } }>(
  "/workspaces/:id/transactions/manual",
  async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (req.params.id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const parsed = ManualTxBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const d = parsed.data;
      const input: CreateManualTxInput = { merchantRaw: d.merchantRaw, amount: d.amount };
      if (d.occurredAt !== undefined) input.occurredAt = d.occurredAt;
      if (d.categoryId !== undefined) input.categoryId = d.categoryId;
      if (d.note       !== undefined) input.note       = d.note;
      if (d.accountId  !== undefined) input.accountId  = d.accountId;
      const result = await createManualTransactionService(
        { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
        input,
      );
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof HttpError) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
      if (err instanceof CreateManualTxError) {
        const status = err.code.startsWith("invalid_") ? 400 : 404;
        return reply.code(status).send({ error: err.code });
      }
      throw err;
    }
  },
);
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/transactions.create-manual.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** all cases pass (12 service + 4 route = 16 in this file).

### 3.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/tests/transactions.create-manual.test.ts
git commit -m "feat(plan 1c-add-transaction): POST /workspaces/:id/transactions/manual"
```

---

## Task 4: Full suite + sanity checks

**Files:** none (verification only).

### 4.1 Run the full suite

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** 83 files / ~697 tests PASS (82 + 1 new file; 681 + 16 new cases).

### 4.2 Sanity grep

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "createManualTransactionService\|/transactions/manual" apps/api/src/ | head -10
```

**Expected:**
- `transactions/create-manual.ts` exports the service + error class
- `routes/transactions.ts` imports the service + registers the POST handler

### 4.3 Confirm no new dependency

- [ ] **Step 3: Check `package.json` unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output.

---

## Self-Review Checklist (after all tasks)

1. **Spec coverage:** §3 decisions, §4 model (Workspace.currency), §5 service, §6 route, §8 tests, §9 acceptance — all covered.
2. **Advisory lock** wraps find-or-create + insert.
3. **`resolveUserTz` is called BEFORE `prisma.$transaction`** (deadlock prevention).
4. **No Pro gate** — Free-tier test passes.
5. **`HttpError`** caught in route, mapped to `{ error: code }`.
6. **Empty `occurredAt: ""` → `invalid_date`** (explicit `=== undefined` check, not truthiness).
7. **`exactOptionalPropertyTypes`** — route strips undefined keys before constructing `CreateManualTxInput`.

---

## Known limitations (documented in spec §10)

- No edit/delete endpoints.
- No chat tool.
- No CSV import.
- HTTP route not audited (deferred to 1C-audit-http).
- Per-row `currency` cleanup deferred to 1C-currency-unify.
- "Cash" account name hardcoded; rename UX deferred.
