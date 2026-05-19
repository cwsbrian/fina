# Plan 1C-edit-delete-transaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-19-plan-1c-edit-delete-transaction-design.md`

**Goal:** Add `PATCH /workspaces/:id/transactions/:txId` (manual-only, partial edit) and `DELETE /workspaces/:id/transactions/:txId` (manual + posted Plaid soft-delete; pending Plaid rejected).

**Architecture:** Three new service modules under `apps/api/src/transactions/` (validators, edit, remove), refactor `applyManualCategorize` to take `withWorkspaceLock` so PATCH↔categorize race is closed, two new HTTP handlers in `routes/transactions.ts`, plus a comprehensive race-test file that proves each writer actually acquires the workspace advisory lock.

**Tech Stack:** TypeScript ESM, Prisma + Postgres on `5433/fina_test`, Fastify + Better Auth, Vitest singleFork, `pg_advisory_xact_lock(hashtext(workspaceId))` for per-workspace serialization, `Prisma.Decimal(14, 2)` for amounts.

---

## Task Dependency Order

1. **Task 1** — Extract validators (`validators.ts`); refactor `create-manual.ts` to use them. Foundation; nothing else can use shared validators until this lands.
2. **Task 2** — Extend `CreateManualTxResult` with `updatedAt`/`removedAt`/`pending`/`plaidTransactionId`. Keeps API shapes symmetric before `EditTxResult` ships.
3. **Task 3** — Retrofit `applyManualCategorize` with `withWorkspaceLock` (REPLACE inner `$transaction`; do NOT nest). Add Test C (categorize lock proof) to a new `transactions.edit.race.test.ts`. Independent of edit/remove services.
4. **Task 4** — Implement `editTransactionService` + unit tests. Append Test A (PATCH lock proof) to the race file.
5. **Task 5** — Implement `removeTransactionService` + unit tests. Append Test B (DELETE lock proof) to the race file.
6. **Task 6** — Wire `PATCH` + `DELETE` handlers into `routes/transactions.ts`; route integration tests.
7. **Task 7** — End-state race tests (D + E) appended to the race file.
8. **Task 8** — Smoke test doc.

Each task ends with a green test suite and a single commit.

---

## Pre-flight (every task)

**Test commands** — `apps/api` has no `pnpm test` script. Use these patterns instead:

- **Whole API suite:**
  ```bash
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
  ```
- **Specific file(s)** — paths are RELATIVE TO `apps/api/` because pnpm runs vitest with `cwd=apps/api`:
  ```bash
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.validators.test.ts
  ```
- **Nx target (alternate):**
  ```bash
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test nx run api:test
  ```

⚠ `pnpm --filter @fina/api test` (no `exec vitest`) **does nothing** — there is no `test` script in `apps/api/package.json`, and pnpm exits 0 with no output. Do NOT use it; every test gate in this plan would falsely pass.

Migrations: this plan adds NO new migrations.

If working in an isolated worktree (recommended via `EnterWorktree`), confirm a clean baseline first:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all existing tests pass (current main passes a 716+ test suite).

---

## Task 1: Extract shared validators

**Files:**
- Create: `apps/api/src/transactions/validators.ts`
- Modify: `apps/api/src/transactions/create-manual.ts:39-89` (replace inline validators with imports + rethrow)
- Create: `apps/api/tests/transactions.validators.test.ts`

**Spec refs:** §5.3, §7.

- [ ] **Step 1: Write failing validator tests**

Create `apps/api/tests/transactions.validators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  validateAmount,
  validateMerchantRaw,
  validateNote,
  parseOccurredAt,
  TxValidationError,
} from "../src/transactions/validators.js";

describe("validateAmount", () => {
  it("accepts 0.01", () => expect(() => validateAmount(0.01)).not.toThrow());
  it("accepts 999_999_999.99", () => expect(() => validateAmount(999_999_999.99)).not.toThrow());
  it("rejects 0", () => expect(() => validateAmount(0)).toThrow(TxValidationError));
  it("rejects negative", () => expect(() => validateAmount(-1)).toThrow(TxValidationError));
  it("rejects Infinity", () => expect(() => validateAmount(Number.POSITIVE_INFINITY)).toThrow(TxValidationError));
  it("rejects NaN", () => expect(() => validateAmount(Number.NaN)).toThrow(TxValidationError));
  it("rejects > max", () => expect(() => validateAmount(1_000_000_000)).toThrow(TxValidationError));
  it("rejects 0.005 (3 decimals)", () => expect(() => validateAmount(0.005)).toThrow(TxValidationError));
  it("rejects 1e20 (exceeds MAX_AMOUNT)", () => expect(() => validateAmount(1e20)).toThrow(TxValidationError));
  it("rejects 1e-7 (scientific notation in toString)", () => {
    // String(1e-7) === "1e-7" which fails the AMOUNT_RE digits-only check.
    expect(() => validateAmount(1e-7)).toThrow(TxValidationError);
  });
  it("error code is invalid_amount", () => {
    try { validateAmount(0); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_amount"); }
  });
});

describe("parseOccurredAt", () => {
  it("accepts 2026-05-19", () => {
    const d = parseOccurredAt("2026-05-19");
    expect(d.toISOString().slice(0, 10)).toBe("2026-05-19");
  });
  it("anchors at UTC noon", () => {
    const d = parseOccurredAt("2026-05-19");
    expect(d.toISOString()).toBe("2026-05-19T12:00:00.000Z");
  });
  it("rejects 2026-13-01", () => expect(() => parseOccurredAt("2026-13-01")).toThrow(TxValidationError));
  it("rejects 2026-02-30 (impossible)", () => expect(() => parseOccurredAt("2026-02-30")).toThrow(TxValidationError));
  it("rejects empty", () => expect(() => parseOccurredAt("")).toThrow(TxValidationError));
  it("rejects ISO datetime", () => expect(() => parseOccurredAt("2026-05-19T00:00:00Z")).toThrow(TxValidationError));
  it("error code is invalid_date", () => {
    try { parseOccurredAt("bad"); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_date"); }
  });
});

describe("validateMerchantRaw", () => {
  it("trims and returns", () => expect(validateMerchantRaw("  Costco  ")).toBe("Costco"));
  it("rejects empty after trim", () => expect(() => validateMerchantRaw("   ")).toThrow(TxValidationError));
  it("rejects 201 chars", () => expect(() => validateMerchantRaw("x".repeat(201))).toThrow(TxValidationError));
  it("accepts 200 chars", () => expect(() => validateMerchantRaw("x".repeat(200))).not.toThrow());
  it("error code is invalid_merchant", () => {
    try { validateMerchantRaw(""); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_merchant"); }
  });
});

describe("validateNote", () => {
  it("returns null for undefined", () => expect(validateNote(undefined)).toBe(null));
  it("returns null for null", () => expect(validateNote(null)).toBe(null));
  it("accepts 1000 chars", () => expect(validateNote("x".repeat(1000))).toBe("x".repeat(1000)));
  it("rejects 1001 chars", () => expect(() => validateNote("x".repeat(1001))).toThrow(TxValidationError));
  it("accepts empty string", () => expect(validateNote("")).toBe(""));
  it("error code is invalid_note", () => {
    try { validateNote("x".repeat(1001)); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_note"); }
  });
});
```

- [ ] **Step 2: Run validator tests, verify they fail with "module not found"**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.validators.test.ts
```

Expected: import error (`Cannot find module '../src/transactions/validators.js'`).

- [ ] **Step 3: Create `validators.ts`**

Create `apps/api/src/transactions/validators.ts`:

```ts
export type TxValidationCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note";

export class TxValidationError extends Error {
  readonly code: TxValidationCode;
  constructor(code: TxValidationCode) {
    super(code);
    this.name = "TxValidationError";
    this.code = code;
  }
}

const MAX_AMOUNT = 999_999_999.99;
// Transaction.amount is Decimal(14, 2). Reject inputs that wouldn't round-trip
// cleanly at two decimal places. Cents-tolerance checks (e.g. cents - round < 1e-6)
// accept pathological inputs like 0.000000001 or 0.009999999999. Use the JS
// string serialization instead: the value must match
//   /^\d+(\.\d{1,2})?$/   (no scientific notation, ≤ 2 decimals)
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new TxValidationError("invalid_amount");
  }
  if (!AMOUNT_RE.test(String(amount))) {
    throw new TxValidationError("invalid_amount");
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new TxValidationError("invalid_date");
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new TxValidationError("invalid_date");
  }
  return d;
}

export function validateMerchantRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new TxValidationError("invalid_merchant");
  }
  return trimmed;
}

export function validateNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (note.length > 1000) throw new TxValidationError("invalid_note");
  return note;
}
```

- [ ] **Step 4: Run validator tests, verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.validators.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor `create-manual.ts` to import from `validators.ts`**

Replace lines 47-89 of `apps/api/src/transactions/create-manual.ts` (the inline `DATE_RE`, `MAX_AMOUNT`, `validateMerchantRaw`, `AMOUNT_RE`, `validateAmount`, `validateNote`, `parseOccurredAt`) with:

```ts
import {
  TxValidationError,
  validateAmount as validateAmountShared,
  validateMerchantRaw as validateMerchantRawShared,
  validateNote as validateNoteShared,
  parseOccurredAt as parseOccurredAtShared,
} from "./validators.js";

// Map TxValidationError → CreateManualTxError. The error codes overlap 1:1.
function rethrow<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new CreateManualTxError(e.code);
    throw e;
  }
}

function validateMerchantRaw(raw: string): string {
  return rethrow(() => validateMerchantRawShared(raw));
}
function validateAmount(amount: number): void {
  rethrow(() => validateAmountShared(amount));
}
function validateNote(note: string | undefined): string | null {
  return rethrow(() => validateNoteShared(note));
}
function parseOccurredAt(s: string): Date {
  return rethrow(() => parseOccurredAtShared(s));
}
```

The rest of `create-manual.ts` (which calls these private wrappers) is unchanged. Existing call sites work because the wrappers preserve the original signatures + error type.

- [ ] **Step 6: Run create-manual test suite to verify no regressions**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts
```

Expected: PASS (no behavior change — `transactions.create-manual.test.ts` covers both the service and route paths today).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transactions/validators.ts \
        apps/api/src/transactions/create-manual.ts \
        apps/api/tests/transactions.validators.test.ts
git commit -m "$(cat <<'EOF'
refactor(plan 1c-edit-delete-transaction): extract tx validators

Pull validateAmount/MerchantRaw/Note + parseOccurredAt from create-manual.ts
into transactions/validators.ts. Validators throw TxValidationError;
create-manual.ts wraps each call to rethrow as CreateManualTxError (1:1
code mapping) so existing behavior is unchanged. Sets up sharing with the
new editTransactionService.
EOF
)"
```

---

## Task 2: Extend `CreateManualTxResult` response shape

**Files:**
- Modify: `apps/api/src/transactions/create-manual.ts:15-29,161-196` (extend result type + select fields + response construction)
- Modify: `apps/api/tests/transactions.create-manual.test.ts` (assertions for new fields, if existing tests check shape)

**Spec refs:** §4.1 (response symmetry), §5.1 file list note.

- [ ] **Step 1: Write failing test for extended shape**

Append to `apps/api/tests/transactions.create-manual.test.ts` (or wherever the existing happy-path test lives — if uncertain, run `grep -ln "createManualTransactionService" apps/api/tests` and pick the first integration test file):

```ts
it("response includes updatedAt, removedAt:null, pending:false, plaidTransactionId:null", async () => {
  // Reuse the file's existing setup helper for ctx; adjust if your local helper differs.
  const { wsId, userId } = await setupEditor("shape@t.co");
  const { transaction: r } = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Costco", amount: 9.99, occurredAt: "2026-05-19" },
  );
  expect(r.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(r.removedAt).toBeNull();
  expect(r.pending).toBe(false);
  expect(r.plaidTransactionId).toBeNull();
});
```

If a similar shape-check test does not exist, also add a `setupEditor` import or define one inline matching the local file's pattern.

- [ ] **Step 2: Run, verify failure**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts
```

Expected: FAIL — the new fields don't exist on the result type.

- [ ] **Step 3: Extend `CreateManualTxResult` type**

In `apps/api/src/transactions/create-manual.ts:15-29`, replace the `CreateManualTxResult` type:

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
    categoryId: string | null;
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    createdAt: string;
    updatedAt: string;
  };
};
```

- [ ] **Step 4: Extend the `transaction.create` select + response construction**

In `apps/api/src/transactions/create-manual.ts:161-196`, the `tx.transaction.create({ data: ..., })` call uses Prisma's default selection (no `select`), so `row` already has all columns. Update the response construction (lines ~181-195) to include the new fields:

```ts
    return {
      transaction: {
        id: row.id,
        accountId: row.accountId,
        plaidTransactionId: null,           // invariant: manual tx
        amount: row.amount.toString(),
        currency: workspace.currency,
        merchantRaw: row.merchantRaw,
        merchantNormalized: row.merchantNormalized ?? merchantNormalized,
        categoryId: row.categoryId,
        occurredAt: row.occurredAt.toISOString(),
        pending: false,                     // invariant: manual tx
        source: "manual",
        note: row.note,
        removedAt: null,                    // invariant: freshly created
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
```

- [ ] **Step 5: Run create-manual tests, verify pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run full API suite to catch any other consumer that asserts the old shape**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS. If any test fails because it asserts the absence of new keys, update that test to either ignore the keys or assert them.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transactions/create-manual.ts \
        apps/api/tests/transactions.create-manual.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-edit-delete-transaction): extend CreateManualTxResult shape

Add updatedAt, removedAt:null, pending:false, plaidTransactionId:null to
the response so PATCH /transactions/:id returns an identically-shaped
object. Non-breaking additive change.
EOF
)"
```

---

## Task 3: Retrofit `applyManualCategorize` with `withWorkspaceLock` + Test C

**Files:**
- Modify: `apps/api/src/categorize/manual-categorize.ts` (REPLACE the existing `prisma.$transaction` with a `withWorkspaceLock` callback per spec §5.1.1)
- Create: `apps/api/tests/transactions.edit.race.test.ts` (Test C only this task)

**Spec refs:** §5.1.1, §5.1.2, §6.2, §8.5 (Test C).

⚠ **The critical structural rule:** `withWorkspaceLock` itself opens an interactive `prisma.$transaction`. The fix is to **REPLACE** the existing inner `$transaction`, not to wrap it. Every Prisma call inside the callback must use the `tx` parameter (the `Prisma.TransactionClient` supplied by the helper). Using bare `prisma.*` or a fresh `prisma.$transaction(...)` inside would run on a different connection without the advisory lock, completely defeating the fix. **Read spec §5.1.1 before editing.**

- [ ] **Step 1: Write Test C (categorize lock proof) — failing**

Create `apps/api/tests/transactions.edit.race.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
// Static imports at top — cold-module loading must NOT happen inside the race
// test where it could be misread as "blocked by lock". When Tasks 4/5 add their
// race tests, append the corresponding import here (`editTransactionService`,
// `removeTransactionService`) so the import-load cost is paid once at file
// load, not during the timed lock test.
import { applyManualCategorize } from "../src/categorize/manual-categorize.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";

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

type Holder = { release: () => void; done: Promise<unknown> };

async function holdLock(workspaceId: string): Promise<Holder> {
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await client.$connect();
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((r) => { resolveBarrier = r; });
  let resolveAcquired!: () => void;
  const acquired = new Promise<void>((r) => { resolveAcquired = r; });

  const done = client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
    resolveAcquired();
    await barrier;
  }).finally(() => client.$disconnect());

  await acquired;
  return { release: () => resolveBarrier(), done };
}

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedManualTx(wsId: string, opts?: { merchantRaw?: string }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId: acct.id,
      plaidTransactionId: null,
      amount: "10.00",
      merchantRaw: opts?.merchantRaw ?? "Costco",
      merchantNormalized: "costco",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false,
      source: "manual",
      rawData: {},
    },
  });
  return tx.id;
}

describe("transactions race tests — lock acquisition proofs", () => {
  it("Test C: applyManualCategorize blocks while holder owns the workspace advisory lock", async () => {
    const { wsId } = await setupEditor("race-c@t.co");
    const txIdBaseline = await seedManualTx(wsId);
    await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } });

    // Unlocked baseline: the same call without a holder must complete quickly
    // (well under the locked-threshold). Proves the timeout-vs-finish race in
    // the locked phase isn't just measuring DB warmup cost.
    const tBaseline = Date.now();
    await applyManualCategorize({ workspaceId: wsId, txId: txIdBaseline, categoryName: "Groceries" });
    const baselineMs = Date.now() - tBaseline;
    expect(baselineMs).toBeLessThan(800);

    // Now run the locked phase with a fresh seed so the call has actual work to do.
    const txIdLocked = await seedManualTx(wsId, { merchantRaw: "Walmart" });
    const holder = await holdLock(wsId);
    const candidate = applyManualCategorize({ workspaceId: wsId, txId: txIdLocked, categoryName: "Groceries" });

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 800)),
    ]);
    expect(winner).toBe("timeout");

    holder.release();
    await holder.done;
    const result = await candidate;
    expect(result.tx.categorizationSource).toBe("manual");
  });
});
```

- [ ] **Step 2: Run Test C — expect timeout assertion to FAIL**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.race.test.ts
```

Expected: FAIL — current `applyManualCategorize` does not take the advisory lock, so `candidate` resolves first ("candidate", not "timeout"). This is the proof that the test is meaningful.

- [ ] **Step 3: Rewrite `applyManualCategorize` per spec §5.1.1**

Replace `apps/api/src/categorize/manual-categorize.ts` content. The full rewritten file:

```ts
import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { withWorkspaceLock } from "../locks/workspace.js";

export class ManualCategorizeError extends Error {
  constructor(public code: "tx_not_found" | "category_not_found") {
    super(code);
    this.name = "ManualCategorizeError";
  }
}

export type ManualCategorizeInput = {
  workspaceId: string;
  txId: string;
  categoryName: string;
};

export type ManualCategorizeResult = {
  tx: {
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    categoryId: string | null;
    categorizationSource: "manual" | "mapping" | "ai" | null;
    occurredAt: Date;
  };
  backfilledCount: number;
};

export async function applyManualCategorize(
  input: ManualCategorizeInput,
): Promise<ManualCategorizeResult> {
  const trimmedName = input.categoryName.trim();
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { currency: true },
  });

  // Category lookup stays OUTSIDE the lock: read-only, pre-existing archive
  // races are not introduced by this plan, and keeping it outside means the
  // lock scope is no larger than the read+writes that actually mutate state.
  const category = await prisma.category.findFirst({
    where: {
      workspaceId: input.workspaceId,
      archivedAt: null,
      name: { equals: trimmedName, mode: "insensitive" },
    },
    select: { id: true, name: true },
  });
  if (!category) throw new ManualCategorizeError("category_not_found");

  const result = await withWorkspaceLock(input.workspaceId, async (tx) => {
    // Re-read INSIDE the lock so a concurrent PATCH that writes merchantRaw +
    // merchantNormalized is visible here — we must normalize from the
    // post-PATCH merchantRaw, not a stale snapshot.
    const txRow = await tx.transaction.findFirst({
      where: { id: input.txId, workspaceId: input.workspaceId },
      select: { id: true, merchantRaw: true, merchantNormalized: true },
    });
    if (!txRow) throw new ManualCategorizeError("tx_not_found");

    const merchantNorm = txRow.merchantNormalized ?? normalizeMerchant(txRow.merchantRaw);

    await tx.transaction.update({
      where: { id: txRow.id },
      data: {
        merchantNormalized: merchantNorm,
        categoryId: category.id,
        categorizationSource: "manual",
      },
    });

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

    const backfilled = await tx.transaction.updateMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        id: { not: txRow.id },
        OR: [
          { categorizationSource: null },
          { categorizationSource: { not: "manual" } },
        ],
      },
      data: { categoryId: category.id, categorizationSource: "mapping" },
    });

    return { backfilledCount: backfilled.count };
  });

  const updated = await prisma.transaction.findUniqueOrThrow({
    where: { id: input.txId },
    select: {
      id: true, amount: true, merchantRaw: true, merchantNormalized: true,
      categoryId: true, categorizationSource: true, occurredAt: true,
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
      occurredAt: updated.occurredAt,
    },
    backfilledCount: result.backfilledCount,
  };
}
```

Key invariants enforced by this rewrite:
- All writes inside the lock use `tx` (the `Prisma.TransactionClient` supplied by `withWorkspaceLock`), never bare `prisma.*`.
- The `tx_not_found` check moves into the lock — if a concurrent removal happened between outer-read and lock-acquire, this still throws cleanly.
- The post-lock final-read (lines for `updated`) uses bare `prisma.*` and is safe because it only reads.

- [ ] **Step 4: Run Test C — expect PASS**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.race.test.ts
```

Expected: PASS — `applyManualCategorize` now blocks at `withWorkspaceLock`, `winner` is `"timeout"`, and after `holder.release()` the call completes.

- [ ] **Step 5: Run the existing `applyManualCategorize` regression suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/categorize.manual-service.test.ts tests/categorize.routes.test.ts tests/chat.tools.categorize-transaction.test.ts
```

Expected: PASS — all existing categorize behavior preserved.

- [ ] **Step 6: Run full API suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/categorize/manual-categorize.ts \
        apps/api/tests/transactions.edit.race.test.ts
git commit -m "$(cat <<'EOF'
fix(plan 1c-edit-delete-transaction): applyManualCategorize uses withWorkspaceLock

REPLACE the existing standalone prisma.\$transaction with a
withWorkspaceLock callback (NOT nest — nesting would run on a separate
connection without the advisory lock, defeating the fix). Re-read the tx
INSIDE the lock so a concurrent PATCH that changes merchantRaw is
visible. All writes inside the callback use the tx client provided by
the lock helper.

Test C in transactions.edit.race.test.ts proves categorize blocks while
another connection holds pg_advisory_xact_lock for the workspace.
Reverting this change makes Test C fail.
EOF
)"
```

---

## Task 4: `editTransactionService` + unit tests + Test A

**Files:**
- Create: `apps/api/src/transactions/edit.ts`
- Create: `apps/api/tests/transactions.edit.service.test.ts`
- Append to: `apps/api/tests/transactions.edit.race.test.ts` (Test A)

**Spec refs:** §4.1, §5.2, §5.5, §8.2, §8.5 Test A.

- [ ] **Step 1: Write failing service unit tests**

Create `apps/api/tests/transactions.edit.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { editTransactionService, EditTxError } from "../src/transactions/edit.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";

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

async function setupEditor(email: string): Promise<{ wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { wsId, userId: u.userId };
}

async function seedManual(wsId: string, userId: string): Promise<string> {
  const r = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
  );
  return r.transaction.id;
}

describe("editTransactionService", () => {
  it("happy: updates all 5 fields, recomputes merchantNormalized, sets categorizationSource", async () => {
    const { wsId, userId } = await setupEditor("e1@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } });

    const r = await editTransactionService(
      { workspaceId: wsId },
      txId,
      {
        amount: 12.34,
        merchantRaw: "  Walmart  ",
        occurredAt: "2026-05-18",
        categoryId: cat.id,
        note: "weekly haul",
      },
    );

    expect(r.transaction.amount).toBe("12.34");
    expect(r.transaction.merchantRaw).toBe("Walmart");
    expect(r.transaction.merchantNormalized).toBe("walmart");
    expect(r.transaction.occurredAt.slice(0, 10)).toBe("2026-05-18");
    expect(r.transaction.categoryId).toBe(cat.id);
    expect(r.transaction.note).toBe("weekly haul");

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.categorizationSource).toBe("manual");
  });

  it("partial update: only amount changes; other fields untouched", async () => {
    const { wsId, userId } = await setupEditor("e2@t.co");
    const txId = await seedManual(wsId, userId);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });

    await editTransactionService({ workspaceId: wsId }, txId, { amount: 99.99 });

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.amount.toString()).toBe("99.99");
    expect(after.merchantRaw).toBe(before.merchantRaw);
    expect(after.occurredAt.toISOString()).toBe(before.occurredAt.toISOString());
    expect(after.note).toBe(before.note);
    expect(after.categoryId).toBe(before.categoryId);
  });

  it("clear categoryId to null sets categorizationSource to null", async () => {
    const { wsId, userId } = await setupEditor("e3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    const txId = await seedManual(wsId, userId);
    await editTransactionService({ workspaceId: wsId }, txId, { categoryId: cat.id });

    await editTransactionService({ workspaceId: wsId }, txId, { categoryId: null });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.categoryId).toBeNull();
    expect(row.categorizationSource).toBeNull();
  });

  it("clear note to null", async () => {
    const { wsId, userId } = await setupEditor("e4@t.co");
    const txId = await seedManual(wsId, userId);
    await editTransactionService({ workspaceId: wsId }, txId, { note: "x" });
    await editTransactionService({ workspaceId: wsId }, txId, { note: null });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.note).toBeNull();
  });

  it("empty input returns current tx without writing", async () => {
    const { wsId, userId } = await setupEditor("e5@t.co");
    const txId = await seedManual(wsId, userId);
    const before = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const r = await editTransactionService({ workspaceId: wsId }, txId, {});
    expect(r.transaction.id).toBe(txId);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    // updatedAt should NOT bump because no update was issued
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("rejects plaid tx with not_editable", async () => {
    const { wsId } = await setupEditor("e6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: "plaid_xyz",
        amount: "5.00", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
        occurredAt: new Date("2026-05-19T12:00:00Z"),
        pending: false, source: "plaid", rawData: {},
      },
    });
    await expect(
      editTransactionService({ workspaceId: wsId }, tx.id, { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_editable" });
  });

  it("rejects already-removed tx with already_removed", async () => {
    const { wsId, userId } = await setupEditor("e7@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { amount: 1 }),
    ).rejects.toMatchObject({ code: "already_removed" });
  });

  it("rejects wrong workspace with not_found", async () => {
    const { wsId, userId } = await setupEditor("e8@t.co");
    const txId = await seedManual(wsId, userId);
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    await expect(
      editTransactionService({ workspaceId: otherWs.id }, txId, { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects nonexistent txId with not_found", async () => {
    const { wsId } = await setupEditor("e9@t.co");
    await expect(
      editTransactionService({ workspaceId: wsId }, "no-such-tx", { amount: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects archived category with category_not_found", async () => {
    const { wsId, userId } = await setupEditor("e10@t.co");
    const txId = await seedManual(wsId, userId);
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Archived", archivedAt: new Date() },
    });
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { categoryId: cat.id }),
    ).rejects.toMatchObject({ code: "category_not_found" });
  });

  it("rejects invalid amount", async () => {
    const { wsId, userId } = await setupEditor("e11@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { amount: 0.005 }),
    ).rejects.toMatchObject({ code: "invalid_amount" });
  });

  it("rejects invalid date", async () => {
    const { wsId, userId } = await setupEditor("e12@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { occurredAt: "2026-13-01" }),
    ).rejects.toMatchObject({ code: "invalid_date" });
  });

  it("rejects invalid merchant (201 chars)", async () => {
    const { wsId, userId } = await setupEditor("e13@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { merchantRaw: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "invalid_merchant" });
  });

  it("rejects invalid note (1001 chars)", async () => {
    const { wsId, userId } = await setupEditor("e14@t.co");
    const txId = await seedManual(wsId, userId);
    await expect(
      editTransactionService({ workspaceId: wsId }, txId, { note: "x".repeat(1001) }),
    ).rejects.toMatchObject({ code: "invalid_note" });
  });
});
```

- [ ] **Step 2: Run, verify failure (module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.service.test.ts
```

Expected: FAIL — `edit.js` module does not exist.

- [ ] **Step 3: Implement `editTransactionService`**

Create `apps/api/src/transactions/edit.ts`:

```ts
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import {
  TxValidationError,
  validateAmount,
  validateMerchantRaw,
  validateNote,
  parseOccurredAt,
} from "./validators.js";

export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  categoryId?: string | null;
  note?: string | null;
};

export type EditTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    createdAt: string;
    updatedAt: string;
  };
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "category_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note";

export class EditTxError extends Error {
  readonly code: EditTxErrorCode;
  constructor(code: EditTxErrorCode) {
    super(code);
    this.name = "EditTxError";
    this.code = code;
  }
}

function rethrowValidation<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new EditTxError(e.code);
    throw e;
  }
}

const TX_SELECT = {
  id: true, accountId: true, plaidTransactionId: true,
  amount: true, merchantRaw: true, merchantNormalized: true,
  categoryId: true, occurredAt: true, pending: true,
  source: true, note: true, removedAt: true,
  createdAt: true, updatedAt: true,
} as const;

function shape(
  row: Prisma.TransactionGetPayload<{ select: typeof TX_SELECT }>,
  currency: string,
): EditTxResult["transaction"] {
  return {
    id: row.id,
    accountId: row.accountId,
    plaidTransactionId: null,
    amount: row.amount.toString(),
    currency,
    merchantRaw: row.merchantRaw,
    merchantNormalized: row.merchantNormalized ?? normalizeMerchant(row.merchantRaw),
    categoryId: row.categoryId,
    occurredAt: row.occurredAt.toISOString(),
    pending: false,
    source: "manual",
    note: row.note,
    removedAt: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function editTransactionService(
  ctx: { workspaceId: string },
  txId: string,
  input: EditTxInput,
): Promise<EditTxResult> {
  // Validate input fields up-front (purely input-shape checks). Mapping
  // TxValidationError → EditTxError preserves the 1:1 code names.
  if (input.amount !== undefined) rethrowValidation(() => validateAmount(input.amount as number));
  let trimmedMerchant: string | undefined;
  if (input.merchantRaw !== undefined) trimmedMerchant = rethrowValidation(() => validateMerchantRaw(input.merchantRaw as string));
  let parsedOccurredAt: Date | undefined;
  if (input.occurredAt !== undefined) parsedOccurredAt = rethrowValidation(() => parseOccurredAt(input.occurredAt as string));
  let normalizedNote: string | null = null;
  let noteProvided = false;
  if (input.note !== undefined) {
    noteProvided = true;
    normalizedNote = rethrowValidation(() => validateNote(input.note));
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  });

  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.transaction.findFirst({
      where: { id: txId, workspaceId: ctx.workspaceId },
      select: TX_SELECT,
    });
    if (!row) throw new EditTxError("not_found");
    if (row.source !== "manual") throw new EditTxError("not_editable");
    if (row.removedAt !== null) throw new EditTxError("already_removed");

    if (input.categoryId !== undefined && input.categoryId !== null) {
      const cat = await tx.category.findFirst({
        where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new EditTxError("category_not_found");
    }

    // Use TransactionUncheckedUpdateInput (NOT TransactionUpdateInput):
    // the latter exposes the `category` relation but not the scalar `categoryId`
    // FK column, so `data.categoryId = ...` would fail typecheck.
    const data: Prisma.TransactionUncheckedUpdateInput = {};
    if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount);
    if (trimmedMerchant !== undefined) {
      data.merchantRaw = trimmedMerchant;
      data.merchantNormalized = normalizeMerchant(trimmedMerchant);
    }
    if (parsedOccurredAt !== undefined) data.occurredAt = parsedOccurredAt;
    if (input.categoryId !== undefined) {
      data.categoryId = input.categoryId;
      data.categorizationSource = input.categoryId === null ? null : "manual";
    }
    if (noteProvided) data.note = normalizedNote;

    if (Object.keys(data).length === 0) {
      return { transaction: shape(row, workspace.currency) };
    }

    const updated = await tx.transaction.update({
      where: { id: txId },
      data,
      select: TX_SELECT,
    });
    return { transaction: shape(updated, workspace.currency) };
  });
}
```

- [ ] **Step 4: Run unit tests, verify PASS**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.service.test.ts
```

Expected: all 13 tests PASS.

- [ ] **Step 5: Append Test A (PATCH lock proof) to race file**

First, add `editTransactionService` to the static-imports block at the top of `apps/api/tests/transactions.edit.race.test.ts`:

```ts
import { editTransactionService } from "../src/transactions/edit.js";
```

Then add this test inside the existing `describe("transactions race tests — lock acquisition proofs", () => { ... })` block:

```ts
  it("Test A: editTransactionService blocks while holder owns the workspace advisory lock", async () => {
    const { wsId, userId } = await setupEditor("race-a@t.co");
    const { transaction: tBaselineTx } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
    );

    // Unlocked baseline: same call must finish well under 800ms.
    const tBaseline = Date.now();
    await editTransactionService({ workspaceId: wsId }, tBaselineTx.id, { amount: 11 });
    expect(Date.now() - tBaseline).toBeLessThan(800);

    // Locked phase: new tx so the work isn't a no-op.
    const { transaction: tLockedTx } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Walmart", amount: 20, occurredAt: "2026-05-19" },
    );
    const holder = await holdLock(wsId);
    const candidate = editTransactionService({ workspaceId: wsId }, tLockedTx.id, { amount: 25 });

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 800)),
    ]);
    expect(winner).toBe("timeout");

    holder.release();
    await holder.done;
    const result = await candidate;
    expect(result.transaction.amount).toBe("25");
  });
```

- [ ] **Step 6: Run race file, verify Test A passes**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.race.test.ts
```

Expected: PASS (Test C + Test A).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transactions/edit.ts \
        apps/api/tests/transactions.edit.service.test.ts \
        apps/api/tests/transactions.edit.race.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-edit-delete-transaction): editTransactionService

Manual-tx partial editor. Validates input via shared validators (1:1
code mapping to EditTxError). Wraps all reads + writes in
withWorkspaceLock so concurrent PATCH-vs-categorize cannot leave
merchantNormalized stale.

Pre-checks (in lock): tx exists, source=manual, removedAt=null, category
(when non-null) exists and not archived. Empty input returns current
row without issuing UPDATE.

Test A in race file proves PATCH blocks while another connection holds
pg_advisory_xact_lock for the workspace.
EOF
)"
```

---

## Task 5: `removeTransactionService` + unit tests + Test B

**Files:**
- Create: `apps/api/src/transactions/remove.ts`
- Create: `apps/api/tests/transactions.remove.service.test.ts`
- Append to: `apps/api/tests/transactions.edit.race.test.ts` (Test B)

**Spec refs:** §4.2 (pre-check order!), §5.2, §8.3, §8.5 Test B.

⚠ **Critical:** the pending-Plaid gate (pre-check 2) runs BEFORE the idempotency check. Spec §4.2 + §8.3. Reverse order produces an exploitable race window with Plaid sync's per-page commit boundary.

- [ ] **Step 1: Write failing service unit tests**

Create `apps/api/tests/transactions.remove.service.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { removeTransactionService, RemoveTxError } from "../src/transactions/remove.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";

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

async function setupEditor(email: string): Promise<{ wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { wsId, userId: u.userId };
}

async function seedManual(wsId: string, userId: string): Promise<string> {
  const r = await createManualTransactionService(
    { workspaceId: wsId, userId },
    { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
  );
  return r.transaction.id;
}

async function seedPlaid(wsId: string, opts: { pending: boolean; removed?: boolean }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid Checking", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: `plaid_${Math.random()}`,
      amount: "20.00", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending,
      source: "plaid", rawData: {},
      removedAt: opts.removed ? new Date() : null,
    },
  });
  return tx.id;
}

describe("removeTransactionService", () => {
  it("happy manual: removed=true, removedAt set", async () => {
    const { wsId, userId } = await setupEditor("r1@t.co");
    const txId = await seedManual(wsId, userId);
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: true });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.removedAt).not.toBeNull();
  });

  it("happy plaid posted: removed=true, removedAt set", async () => {
    const { wsId } = await setupEditor("r2@t.co");
    const txId = await seedPlaid(wsId, { pending: false });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: true });
  });

  it("rejects plaid pending (fresh) with cannot_delete_pending", async () => {
    const { wsId } = await setupEditor("r3@t.co");
    const txId = await seedPlaid(wsId, { pending: true });
    await expect(
      removeTransactionService({ workspaceId: wsId }, txId),
    ).rejects.toMatchObject({ code: "cannot_delete_pending" });
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(row.removedAt).toBeNull();
  });

  it("rejects plaid pending (already removed) with cannot_delete_pending — gate runs BEFORE idempotency", async () => {
    const { wsId } = await setupEditor("r4@t.co");
    const txId = await seedPlaid(wsId, { pending: true, removed: true });
    await expect(
      removeTransactionService({ workspaceId: wsId }, txId),
    ).rejects.toMatchObject({ code: "cannot_delete_pending" });
  });

  it("idempotent already-removed (manual): removed=false, alreadyRemoved=true", async () => {
    const { wsId, userId } = await setupEditor("r5@t.co");
    const txId = await seedManual(wsId, userId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("idempotent already-removed (plaid posted)", async () => {
    const { wsId } = await setupEditor("r6@t.co");
    const txId = await seedPlaid(wsId, { pending: false, removed: true });
    const r = await removeTransactionService({ workspaceId: wsId }, txId);
    expect(r).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("rejects wrong workspace with not_found", async () => {
    const { wsId, userId } = await setupEditor("r7@t.co");
    const txId = await seedManual(wsId, userId);
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await expect(
      removeTransactionService({ workspaceId: other.id }, txId),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects nonexistent tx with not_found", async () => {
    const { wsId } = await setupEditor("r8@t.co");
    await expect(
      removeTransactionService({ workspaceId: wsId }, "no-such"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
```

- [ ] **Step 2: Run, verify failure (module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.remove.service.test.ts
```

Expected: FAIL — `remove.js` module does not exist.

- [ ] **Step 3: Implement `removeTransactionService`**

Create `apps/api/src/transactions/remove.ts`:

```ts
import { withWorkspaceLock } from "../locks/workspace.js";

export type RemoveTxResult =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export type RemoveTxErrorCode = "not_found" | "cannot_delete_pending";

export class RemoveTxError extends Error {
  readonly code: RemoveTxErrorCode;
  constructor(code: RemoveTxErrorCode) {
    super(code);
    this.name = "RemoveTxError";
    this.code = code;
  }
}

export async function removeTransactionService(
  ctx: { workspaceId: string },
  txId: string,
): Promise<RemoveTxResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.transaction.findFirst({
      where: { id: txId, workspaceId: ctx.workspaceId },
      select: { id: true, pending: true, plaidTransactionId: true, removedAt: true },
    });
    if (!row) throw new RemoveTxError("not_found");

    // ORDER MATTERS: pending-gate runs BEFORE idempotency check. A tx that
    // was already soft-removed by Plaid's markRemoved on page N can be
    // resurrected by a pending→posted promotion on page N+1
    // (sync.ts:235 unconditionally clears removedAt). Returning idempotent
    // 200 here would silently miss the resurrection — reject pending Plaid
    // tx regardless of current removedAt state. Manual tx (plaidTransactionId
    // === null) can never satisfy this gate.
    if (row.pending === true && row.plaidTransactionId !== null) {
      throw new RemoveTxError("cannot_delete_pending");
    }

    if (row.removedAt !== null) {
      return { removed: false, alreadyRemoved: true } as const;
    }

    await tx.transaction.update({
      where: { id: txId },
      data: { removedAt: new Date() },
    });
    return { removed: true } as const;
  });
}
```

- [ ] **Step 4: Run unit tests, verify PASS**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.remove.service.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 5: Append Test B (DELETE lock proof) to race file**

First, add `removeTransactionService` to the static-imports block at the top of `apps/api/tests/transactions.edit.race.test.ts`:

```ts
import { removeTransactionService } from "../src/transactions/remove.js";
```

Then add this test inside the existing `describe("transactions race tests — lock acquisition proofs")` block:

```ts
  it("Test B: removeTransactionService blocks while holder owns the workspace advisory lock", async () => {
    const { wsId, userId } = await setupEditor("race-b@t.co");
    const { transaction: tBaselineTx } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
    );

    // Unlocked baseline: same call must finish well under 800ms.
    const tBaseline = Date.now();
    await removeTransactionService({ workspaceId: wsId }, tBaselineTx.id);
    expect(Date.now() - tBaseline).toBeLessThan(800);

    // Locked phase.
    const { transaction: tLockedTx } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Walmart", amount: 20, occurredAt: "2026-05-19" },
    );
    const holder = await holdLock(wsId);
    const candidate = removeTransactionService({ workspaceId: wsId }, tLockedTx.id);

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 800)),
    ]);
    expect(winner).toBe("timeout");

    holder.release();
    await holder.done;
    const result = await candidate;
    expect(result).toEqual({ removed: true });
  });
```

- [ ] **Step 6: Run race file, verify Tests A+B+C pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.race.test.ts
```

Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/transactions/remove.ts \
        apps/api/tests/transactions.remove.service.test.ts \
        apps/api/tests/transactions.edit.race.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-edit-delete-transaction): removeTransactionService

Soft-delete service. Pre-check order is significant: pending-Plaid gate
(pending && plaidTransactionId != null → cannot_delete_pending) runs
BEFORE idempotency check, because Plaid sync's per-page commit boundary
allows a row already soft-removed by markRemoved on page N to be
resurrected by a pending→posted promotion on page N+1
(sync.ts:235 unconditionally clears removedAt). Manual tx never hits
the gate (plaidTransactionId is always null on source=manual).

Test B in race file proves DELETE blocks while another connection holds
pg_advisory_xact_lock for the workspace.
EOF
)"
```

---

## Task 6: Wire `PATCH` + `DELETE` handlers + route integration tests

**Files:**
- Modify: `apps/api/src/routes/transactions.ts` (add handlers at the end of `transactionsRoutes`)
- Create: `apps/api/tests/transactions.edit.route.test.ts`
- Create: `apps/api/tests/transactions.remove.route.test.ts`

**Spec refs:** §4.1 (PATCH error mapping), §4.2 (DELETE error mapping), §7 (Zod `.strict()`), §8.4.

- [ ] **Step 1: Write failing PATCH route tests**

Create `apps/api/tests/transactions.edit.route.test.ts`:

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

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedManual(cookie: string, wsId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/transactions/manual`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" }),
  });
  return res.json().transaction.id;
}

describe("PATCH /workspaces/:id/transactions/:txId", () => {
  it("happy: 200 with full body returns updated tx", async () => {
    const { cookie, wsId } = await setupEditor("ep1@t.co");
    const txId = await seedManual(cookie, wsId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        amount: 12.5, merchantRaw: "Walmart", occurredAt: "2026-05-18",
        categoryId: cat.id, note: "weekly",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction.amount).toBe("12.5");
    expect(body.transaction.merchantRaw).toBe("Walmart");
    expect(body.transaction.merchantNormalized).toBe("walmart");
    expect(body.transaction.categoryId).toBe(cat.id);
  });

  it("200 empty body returns current tx unchanged", async () => {
    const { cookie, wsId } = await setupEditor("ep2@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.id).toBe(txId);
  });

  it("400 invalid_body: amount not a number", async () => {
    const { cookie, wsId } = await setupEditor("ep3@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: "abc" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: amount null (non-nullable field)", async () => {
    const { cookie, wsId } = await setupEditor("ep4@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: null }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: merchantRaw null", async () => {
    const { cookie, wsId } = await setupEditor("ep4b@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ merchantRaw: null }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: unknown key (.strict())", async () => {
    const { cookie, wsId } = await setupEditor("ep5@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ merchant: "typo" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 not_editable for plaid tx", async () => {
    const { cookie, wsId } = await setupEditor("ep6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const ptx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_xyz",
        amount: "5", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
        occurredAt: new Date("2026-05-19T12:00:00Z"),
        pending: false, source: "plaid", rawData: {},
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${ptx.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_editable");
  });

  it("400 already_removed", async () => {
    const { cookie, wsId } = await setupEditor("ep7@t.co");
    const txId = await seedManual(cookie, wsId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("already_removed");
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId } = await setupEditor("ep8@t.co");
    const txId = await seedManual(cookie, wsId);
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${other.id}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setupEditor("ep9@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/no-such-tx`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("404 category_not_found", async () => {
    const { cookie, wsId } = await setupEditor("ep10@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: "no-such-cat" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("401 without session", async () => {
    const { wsId } = await setupEditor("ep11@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/anything`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 insufficient_role: viewer cannot PATCH", async () => {
    // Editor owns the tx; viewer is a different user with viewer role in the same workspace.
    const editor = await signUpAndGetCookie(app, { email: "ep12-editor@t.co" });
    const wsId = await getOwnerWorkspaceId(editor.userId);
    const txId = await seedManual(editor.cookie, wsId);

    const viewer = await signUpAndGetCookie(app, { email: "ep12-viewer@t.co" });
    // Editor adds viewer membership directly via DB (no invite flow in this test).
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});
```

- [ ] **Step 2: Write failing DELETE route tests**

Create `apps/api/tests/transactions.remove.route.test.ts`:

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

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId };
}

async function seedManual(cookie: string, wsId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/transactions/manual`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" }),
  });
  return res.json().transaction.id;
}

async function seedPlaid(wsId: string, opts: { pending: boolean; removed?: boolean }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: `p_${Math.random()}`,
      amount: "5", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending, source: "plaid", rawData: {},
      removedAt: opts.removed ? new Date() : null,
    },
  });
  return tx.id;
}

describe("DELETE /workspaces/:id/transactions/:txId", () => {
  it("200 removed=true on first call (manual)", async () => {
    const { cookie, wsId } = await setupEditor("d1@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("200 removed=true (plaid posted)", async () => {
    const { cookie, wsId } = await setupEditor("d2@t.co");
    const txId = await seedPlaid(wsId, { pending: false });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("400 cannot_delete_pending (plaid pending)", async () => {
    const { cookie, wsId } = await setupEditor("d3@t.co");
    const txId = await seedPlaid(wsId, { pending: true });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_delete_pending");
  });

  it("200 idempotent on second call", async () => {
    const { cookie, wsId } = await setupEditor("d4@t.co");
    const txId = await seedManual(cookie, wsId);
    await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId } = await setupEditor("d5@t.co");
    const txId = await seedManual(cookie, wsId);
    const other = await prisma.workspace.create({ data: { name: "o" } });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${other.id}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("401 without session", async () => {
    const { wsId } = await setupEditor("d6@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/anything`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setupEditor("d7@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/no-such`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("403 insufficient_role: viewer cannot DELETE", async () => {
    const editor = await signUpAndGetCookie(app, { email: "d8-editor@t.co" });
    const wsId = await getOwnerWorkspaceId(editor.userId);
    const txId = await seedManual(editor.cookie, wsId);

    const viewer = await signUpAndGetCookie(app, { email: "d8-viewer@t.co" });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});
```

- [ ] **Step 3: Run, verify failure (no handlers)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.route.test.ts tests/transactions.remove.route.test.ts
```

Expected: FAIL — both routes return 404 (no handler).

- [ ] **Step 4: Add the handlers**

In `apps/api/src/routes/transactions.ts`, add these imports near the top:

```ts
import { editTransactionService, EditTxError, type EditTxInput } from "../transactions/edit.js";
import { removeTransactionService, RemoveTxError } from "../transactions/remove.js";
```

Add the Zod body schema near the other schemas (after `ManualTxBody`):

```ts
const PatchTxBody = z
  .object({
    amount: z.number().optional(),
    merchantRaw: z.string().optional(),
    occurredAt: z.string().optional(),
    categoryId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .strict();
```

Map EditTxError codes → HTTP status. Add this helper inside the file (above `transactionsRoutes` or just before the PATCH handler — keep it private):

```ts
function editTxErrorStatus(code: EditTxError["code"]): number {
  if (code === "not_found") return 404;
  if (code === "category_not_found") return 404;
  return 400; // not_editable, already_removed, invalid_*
}

function removeTxErrorStatus(code: RemoveTxError["code"]): number {
  if (code === "not_found") return 404;
  return 400; // cannot_delete_pending
}
```

Append these two handlers inside `transactionsRoutes` (after the existing POST `/manual`):

```ts
  app.patch<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = PatchTxBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
        const d = parsed.data;
        const input: EditTxInput = {};
        if (d.amount       !== undefined) input.amount       = d.amount;
        if (d.merchantRaw  !== undefined) input.merchantRaw  = d.merchantRaw;
        if (d.occurredAt   !== undefined) input.occurredAt   = d.occurredAt;
        if (d.categoryId   !== undefined) input.categoryId   = d.categoryId;
        if (d.note         !== undefined) input.note         = d.note;
        const result = await editTransactionService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.txId,
          input,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof EditTxError) return reply.code(editTxErrorStatus(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await removeTransactionService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.txId,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof RemoveTxError) return reply.code(removeTxErrorStatus(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );
```

- [ ] **Step 5: Run route tests, verify PASS**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.route.test.ts tests/transactions.remove.route.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Run full API suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS (716+ tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/transactions.ts \
        apps/api/tests/transactions.edit.route.test.ts \
        apps/api/tests/transactions.remove.route.test.ts
git commit -m "$(cat <<'EOF'
feat(plan 1c-edit-delete-transaction): PATCH + DELETE routes

PATCH /workspaces/:id/transactions/:txId  — editor+, manual-only,
partial update, .strict() body rejects unknown keys, 1:1 EditTxError →
HTTP status mapping (not_found/category_not_found → 404, rest → 400).

DELETE /workspaces/:id/transactions/:txId — editor+, both manual and
posted Plaid, idempotent on already-removed, rejects pending Plaid with
cannot_delete_pending (400).

Both handlers acquire workspace context via requireWorkspaceContext,
gate workspace_mismatch (400) before service call.
EOF
)"
```

---

## Task 7: End-state race tests (Test D + Test E)

**Files:**
- Append to: `apps/api/tests/transactions.edit.race.test.ts`

**Spec refs:** §8.5 Tests D, E.

- [ ] **Step 1: Append Tests D + E to race file**

Add inside the `describe("transactions race tests — lock acquisition proofs")` block in `apps/api/tests/transactions.edit.race.test.ts`:

```ts
  it("Test D: end-state consistency — concurrent PATCH(merchantRaw) + categorize → final merchantNormalized matches final merchantRaw", async () => {
    // Uses the static-imported createManualTransactionService, editTransactionService,
    // applyManualCategorize from the top of the file.
    const { wsId, userId } = await setupEditor("race-d@t.co");
    const { transaction } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
    );
    await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } });

    const holder = await holdLock(wsId);
    const patchP = editTransactionService({ workspaceId: wsId }, transaction.id, { merchantRaw: "Walmart" });
    const catP = applyManualCategorize({ workspaceId: wsId, txId: transaction.id, categoryName: "Groceries" });

    // Both should be blocked at the lock.
    const winner = await Promise.race([
      Promise.all([patchP, catP]).then(() => "both"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 800)),
    ]);
    expect(winner).toBe("timeout");

    holder.release();
    await holder.done;
    await Promise.all([patchP, catP]);

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(row.merchantRaw).toBe("Walmart");
    expect(row.merchantNormalized).toBe("walmart");
    expect(row.categoryId).not.toBeNull();
  });

  it("Test E: PATCH-vs-PATCH last-writer-wins under lock", async () => {
    const { wsId, userId } = await setupEditor("race-e@t.co");
    const { transaction } = await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" },
    );

    const a = editTransactionService({ workspaceId: wsId }, transaction.id, { amount: 20 });
    const b = editTransactionService({ workspaceId: wsId }, transaction.id, { amount: 30 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(["20", "30"]).toContain(ra.transaction.amount);
    expect(["20", "30"]).toContain(rb.transaction.amount);

    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(["20", "30"]).toContain(row.amount.toString());
  });
```

- [ ] **Step 2: Run race file, verify all 5 tests pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.edit.race.test.ts
```

Expected: A, B, C, D, E all PASS.

- [ ] **Step 3: Run full suite for safety**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/transactions.edit.race.test.ts
git commit -m "$(cat <<'EOF'
test(plan 1c-edit-delete-transaction): race tests D + E

Test D: end-state consistency — concurrent PATCH(merchantRaw) +
applyManualCategorize, both blocked on advisory lock, release →
final merchantRaw and merchantNormalized agree, categoryId set.

Test E: PATCH-vs-PATCH last-writer-wins under lock. Smoke check —
row-level locking would pass this even without the workspace lock; the
lock-acquisition proof lives in Tests A/B/C.
EOF
)"
```

---

## Task 8: Smoke test document

**Files:**
- Create: `docs/superpowers/smoke-tests/2026-05-19-plan-1c-edit-delete-transaction.md`

**Spec refs:** §8.6.

This task is documentation only — record manual smoke steps the operator runs against a local API after merge. No code changes.

- [ ] **Step 1: Create the smoke doc**

Create `docs/superpowers/smoke-tests/2026-05-19-plan-1c-edit-delete-transaction.md`:

````markdown
# Smoke Test — Plan 1C-edit-delete-transaction

**Goal:** validate `PATCH /workspaces/:id/transactions/:txId` and
`DELETE /workspaces/:id/transactions/:txId` end-to-end against a running
local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$TX` below.

## Setup — create a manual tx

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchantRaw":"Costco","amount":42.50,"occurredAt":"2026-05-19","note":"baseline"}'
```

Capture `transaction.id` → `$TX`.

## 1. PATCH partial — amount only

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"amount":99.99}'
```

Expected: 200, `transaction.amount === "99.99"`, other fields unchanged.

## 2. PATCH full — all 5 fields

Create a category first if you don't have one:

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"name":"Groceries"}'
```

Capture `category.id` → `$CAT`.

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":12.34,\"merchantRaw\":\"Walmart\",\"occurredAt\":\"2026-05-18\",\"categoryId\":\"$CAT\",\"note\":\"weekly haul\"}"
```

Expected: 200, all fields updated, `merchantNormalized === "walmart"`.

## 3. PATCH clear categoryId

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"categoryId":null}'
```

Expected: 200, `transaction.categoryId === null`. Also verify in DB that `categorizationSource` is `null`.

## 4. PATCH unknown key (.strict() reject)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchant":"typo"}'
```

Expected: 400, `error === "invalid_body"`.

## 5. PATCH on Plaid tx (manual seed via DB or use one from a sandbox Plaid item)

```bash
# Substitute $PLAID_TX with the id of a known plaid-sourced tx in $WS.
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"amount":1}'
```

Expected: 400, `error === "not_editable"`.

## 6. DELETE manual tx

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 200, `{ "removed": true }`.

## 7. GET list (default includeRemoved=false) — tx should NOT appear

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions | map(.id) | contains(["'"$TX"'"])'
```

Expected: `false`.

## 8. GET list with includeRemoved=true — tx should appear with removedAt non-null

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?includeRemoved=true" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions[] | select(.id=="'"$TX"'") | .removedAt'
```

Expected: non-null ISO timestamp string.

## 9. DELETE idempotent on second call

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 200, `{ "removed": false, "alreadyRemoved": true }`.

## 10. DELETE pending Plaid tx (if you have one)

```bash
# Substitute $PENDING_PLAID_TX with a known pending Plaid tx in $WS.
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$PENDING_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 400, `error === "cannot_delete_pending"`. Verify `removedAt` is still null in DB.

## Result

Record a PASS/FAIL for each of the 10 steps. All PASS = ship.
````

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/smoke-tests/2026-05-19-plan-1c-edit-delete-transaction.md
git commit -m "$(cat <<'EOF'
docs(plan 1c-edit-delete-transaction): smoke test doc

Ten curl-based steps covering PATCH happy path, PATCH partial,
PATCH clear category, .strict() unknown-key reject, PATCH on plaid tx,
DELETE manual, GET list filter (removed vs includeRemoved), DELETE
idempotent, DELETE pending plaid reject.
EOF
)"
```

---

## Plan Self-Review

**Spec coverage check** (§-by-§ against the spec):

| Spec section | Implemented in |
|---|---|
| §1 Goals / out of scope | Tasks 4 (PATCH service), 5 (DELETE service), 6 (routes). Out-of-scope items (audit, UI, split) NOT touched by any task. |
| §2 Decisions table | Mapped row-by-row across all tasks. |
| §3 Data model (no schema changes) | No migration file created. |
| §4.1 PATCH endpoint | Task 4 (service) + Task 6 (route). |
| §4.2 DELETE endpoint | Task 5 (service) + Task 6 (route). |
| §5.1 File list | Each row maps to a task (validators=T1, create-manual mod=T1+T2, edit.ts=T4, remove.ts=T5, manual-categorize.ts=T3, routes/transactions.ts=T6, all test files=T1/T3/T4/T5/T6/T7). |
| §5.1.1 Precise categorize rewrite | Task 3 Step 3. |
| §5.1.2 Caller contract | Task 3 Step 3 (documented in comment) + commit message. |
| §5.2 Service signatures | Task 4 Step 3 (edit), Task 5 Step 3 (remove). |
| §5.3 Validators module | Task 1 Step 3. |
| §5.4 Locking | Tasks 3, 4, 5 each use `withWorkspaceLock`. |
| §5.5 Update payload construction | Task 4 Step 3 (incremental `data` build with `Object.keys(data).length === 0` short-circuit). |
| §6.1 Plaid sync interaction | Task 5 Step 3 (pre-check order with comment citing sync.ts:235). |
| §6.2 PATCH-vs-categorize race | Task 3 Step 3 fix + Test C in Task 3, Test D in Task 7. |
| §6.3 PATCH-vs-PATCH | Test E in Task 7. |
| §6.4 PATCH-vs-Plaid sync (disjoint rows) | Documented; no test (no overlap to test). |
| §7 Validators (verbatim regex) | Task 1 Step 3 (AMOUNT_RE, DATE_RE matching spec exactly). |
| §8.1 Validators tests | Task 1 Step 1. |
| §8.2 Edit service tests | Task 4 Step 1 (13 cases). |
| §8.3 Remove service tests | Task 5 Step 1 (8 cases — covers fresh, idempotent, pending-fresh, pending-already-removed, plaid-posted, wrong-ws, nonexistent). |
| §8.4 Route tests | Task 6 Steps 1 + 2. |
| §8.5 Race tests A/B/C/D/E | Tests C(T3), A(T4), B(T5), D+E(T7). |
| §8.6 Smoke doc | Task 8. |
| §9 Migration & rollout | No-op (no schema changes). |
| §10 Reviewer checklist | Each item maps to a task assertion or commit message. |

**Placeholder scan:** no "TBD" / "TODO" / "fill in" — every code block is concrete.

**Type consistency:**
- `EditTxInput` (T4) matches the Zod `PatchTxBody` shape (T6) — fields and nullability align.
- `EditTxResult.transaction` (T4) === `CreateManualTxResult.transaction` (T2) === PATCH response shape in spec §4.1.
- `RemoveTxResult` union (T5) matches spec §5.2.
- Error codes: `TxValidationCode` (T1) ⊂ `EditTxErrorCode` (T4) ⊂ `CreateManualTxErrorCode` (existing) — all `invalid_*` overlap.
- Service ctx uses `{ workspaceId: string }` consistently (T4 + T5); create-manual uses `{ workspaceId, userId }` because it resolves user TZ.

No issues found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-19-plan-1c-edit-delete-transaction.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec + quality) between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session, batch with checkpoints for review.

Which approach?
