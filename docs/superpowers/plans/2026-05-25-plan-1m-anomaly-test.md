# Plan 1M-anomaly-test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8-test coverage to `apps/api/src/push/anomaly.ts` (`checkLargeChargeAndPush`) — all 8 branches + push fan-out semantics + arg-shape assertion.

**Architecture:** Single task, single commit. New test file `apps/api/tests/push.anomaly.test.ts`. Partial `vi.mock` of `push/send.js` replaces `sendLargeChargePush` with a `vi.fn()`. Real Postgres :5433 + `truncateAll` per test. No production code changes.

**Tech Stack:** Vitest 2.1.5 singleFork, Prisma 5.22, real DB seeding via prisma.create.

---

## Context — read before any step

- **Spec:** `docs/superpowers/specs/2026-05-25-plan-1m-anomaly-test-design.md` (HEAD `ddfbe8a`). Authoritative.
- **Production code (verified against schema):**
  - `apps/api/src/push/anomaly.ts:8-14`: `MIN_AMOUNT=30`, `MULTIPLIER=2.5`, `COLD_START_AMOUNT=150`.
  - `apps/api/src/push/anomaly.ts:32`: `if (args.amount < MIN_AMOUNT) return;`
  - `apps/api/src/push/anomaly.ts:36-46`: read first allocation → if no categoryId, return.
  - `apps/api/src/push/anomaly.ts:52-77`: 90d history aggregation + cold-start vs avg×2.5 branching + `amount >= MIN_AMOUNT * 2` guard.
  - `apps/api/src/push/anomaly.ts:80-86`: `membership.findMany` filtered `role: { in: ["owner", "editor"] }`.
  - `apps/api/src/push/anomaly.ts:87-95`: loop `sendLargeChargePush(env, userId, merchant ?? "An unusual charge", amount.toFixed(2), categoryName)`.
- **Schema constraints (verified per R1+R2):**
  - `Transaction.rawData: Json` required (no default) — pass `{}`.
  - `Transaction` has no `currency` field (Workspace + BankAccount carry it).
  - `Category` has no `kind` field; minimal `{ workspaceId, name }`.
  - `TransactionAllocation.source` enum: `mapping | ai | manual`.
  - `Membership.role` enum: `owner | editor | viewer`.
  - `User.id` requires explicit value (no `@default(cuid())`).
- **Discipline:**
  - `vi.spyOn(prisma, ...)` and Prisma delegate properties FORBIDDEN.
  - `vi.clearAllMocks` afterEach (NOT `restoreAllMocks` — would restore real Expo SDK call path on `sendLargeChargePush`).

## File map

| File | Action |
|---|---|
| `apps/api/tests/push.anomaly.test.ts` | Create — header + helpers + 8 tests, single commit |

---

## Task 1: `apps/api/tests/push.anomaly.test.ts` — 8 tests

**Goal:** All 8 branches of `checkLargeChargeAndPush` exercised via direct function call (no HTTP layer).

**Files:**
- Create: `apps/api/tests/push.anomaly.test.ts`

- [ ] **Step 1.1: Create the file header + helpers**

Create `apps/api/tests/push.anomaly.test.ts` with:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

const env = testEnv();

// Partial mock: replace sendLargeChargePush with vi.fn(), keep other
// exports as-is. afterEach uses vi.clearAllMocks (NOT restoreAllMocks —
// would restore the real Expo SDK call path and break subsequent tests).
vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendLargeChargePush: vi.fn().mockResolvedValue(undefined),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

// ---------- helpers ----------

let userCounter = 0;
let workspaceCounter = 0;

async function createUserMinimal(): Promise<string> {
  userCounter++;
  const id = `u-anom-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: { id, email: `${id}@t.co`, name: `Anom User ${userCounter}` },
  });
  return id;
}

async function setupWorkspaceWithMembers(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{
  wsId: string;
  members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }>;
}> {
  workspaceCounter++;
  const ws = await prisma.workspace.create({
    data: {
      id: `w-anom-${Date.now()}-${workspaceCounter}`,
      name: `Anom WS ${workspaceCounter}`,
      currency: "CAD",
    },
  });
  const members: Array<{ userId: string; role: "owner" | "editor" | "viewer" }> = [];
  for (const role of roles) {
    const userId = await createUserMinimal();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    members.push({ userId, role });
  }
  return { wsId: ws.id, members };
}

async function seedCategory(wsId: string, name: string): Promise<string> {
  const cat = await prisma.category.create({
    data: { workspaceId: wsId, name },
  });
  return cat.id;
}

async function seedAccount(wsId: string): Promise<string> {
  const a = await prisma.bankAccount.create({
    data: {
      workspaceId: wsId,
      plaidItemId: null,
      plaidAccountId: null,
      name: "Test",
      type: "depository",
      currency: "CAD",
      status: "active",
    },
  });
  return a.id;
}

/** Seeds a Transaction (+ optional TransactionAllocation when categoryId
 *  is non-null). Transaction has no currency field (workspace+account
 *  carry it). rawData is required Json with no default — pass empty. */
async function seedTransactionWithCategory(opts: {
  wsId: string;
  accountId: string;
  categoryId: string | null;
  amount: number;
  merchant?: string | null;
  occurredAt?: Date;
}): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: opts.wsId,
      accountId: opts.accountId,
      amount: new Prisma.Decimal(opts.amount),
      merchantRaw: opts.merchant ?? "Test Merchant",
      merchantNormalized: (opts.merchant ?? "test merchant").toLowerCase(),
      occurredAt: opts.occurredAt ?? new Date(),
      pending: false,
      source: "manual",
      rawData: {},
    },
  });
  if (opts.categoryId !== null) {
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId: opts.categoryId,
        amount: new Prisma.Decimal(opts.amount),
        source: "manual",
      },
    });
  }
  return tx.id;
}
```

- [ ] **Step 1.2: Append Test 1 — `amount < MIN_AMOUNT`**

Append:

```ts
describe("checkLargeChargeAndPush", () => {
  it("amount < MIN_AMOUNT ($30) → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 25, merchant: "Coffee",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 25, merchant: "Coffee",
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });
```

- [ ] **Step 1.3: Append Test 2 — uncategorized**

```ts
  it("uncategorized transaction (no allocation row) → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId: null, amount: 200, merchant: "Anything",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Anything",
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });
```

- [ ] **Step 1.4: Append Test 3 — cold-start < $150**

```ts
  it("cold-start (no 90d history) + amount < $150 → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 100,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 100, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });
```

- [ ] **Step 1.5: Append Test 4 — cold-start ≥ $150 → push**

```ts
  it("cold-start + amount ≥ $150 → 1 push to owner", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Best Buy",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toBe(members[0]!.userId);
  });
```

- [ ] **Step 1.6: Append Test 5 — history, amount < avg×2.5**

```ts
  it("with history, amount < avg × 2.5 → no push", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    // 5 prior transactions at $50 each, 30 days ago (well within 90d window).
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 50,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    // avg = $50. new tx $80. 80 < 50 × 2.5 = 125 → not unusual.
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 80,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 80, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });
```

- [ ] **Step 1.7: Append Test 6 — history, < MIN×2 extra guard**

```ts
  it("with history, amount ≥ avg × 2.5 BUT < MIN_AMOUNT × 2 → no push (extra guard)", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Coffee");
    // 5 prior transactions at $5 each (avg $5). new tx $40.
    // 40 ≥ 5 × 2.5 = 12.5 BUT 40 < 30 × 2 = 60 → not unusual.
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 5,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 40,
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 40, merchant: null,
    });

    expect(vi.mocked(sendMod.sendLargeChargePush).mock.calls.length).toBe(0);
  });
```

- [ ] **Step 1.8: Append Test 7 — history both conditions + arg-shape**

```ts
  it("with history, both conditions met → 1 push + verify all 5 args forwarded", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    // avg = $40, new tx $200. 200 ≥ 40 × 2.5 = 100 AND 200 ≥ 60 → unusual.
    for (let i = 0; i < 5; i++) {
      await seedTransactionWithCategory({
        wsId, accountId, categoryId, amount: 40,
        occurredAt: new Date(Date.now() - 30 * 86_400_000),
      });
    }
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200, merchant: "Starbucks",
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Starbucks",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual([
      env,                    // 1st arg: env carrier
      members[0]!.userId,     // 2nd: owner userId
      "Starbucks",            // 3rd: merchant (passed-through)
      "200.00",               // 4th: amount.toFixed(2)
      "Food",                 // 5th: categoryName
    ]);
  });
```

- [ ] **Step 1.9: Append Test 8 — fan-out (owner + editor + viewer)**

```ts
  it("fan-out: workspace with owner+editor+viewer, unusual tx → 2 pushes (viewer excluded)", async () => {
    const { checkLargeChargeAndPush } = await import("../src/push/anomaly.js");
    const { wsId, members } = await setupWorkspaceWithMembers(["owner", "editor", "viewer"]);
    const accountId = await seedAccount(wsId);
    const categoryId = await seedCategory(wsId, "Food");
    const txId = await seedTransactionWithCategory({
      wsId, accountId, categoryId, amount: 200,  // cold-start unusual
    });

    await checkLargeChargeAndPush(env, {
      transactionId: txId, workspaceId: wsId, amount: 200, merchant: "Best Buy",
    });

    const calls = vi.mocked(sendMod.sendLargeChargePush).mock.calls;
    expect(calls.length).toBe(2);
    const calledUserIds = calls.map((c) => c[1]).sort();
    const expectedUserIds = members
      .filter((m) => m.role === "owner" || m.role === "editor")
      .map((m) => m.userId)
      .sort();
    expect(calledUserIds).toEqual(expectedUserIds);
  });
});
```

- [ ] **Step 1.10: Run the file**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.anomaly.test.ts 2>&1 | tail -8
```

Expected: 8/8 pass.

- [ ] **Step 1.11: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as pre-fix baseline (no new errors).

- [ ] **Step 1.12: Verify `it(` count = 8**

```bash
grep -c "it(" apps/api/tests/push.anomaly.test.ts
```

Expected: 8.

- [ ] **Step 1.13: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/push.anomaly.test.ts && git commit -m "test(api): push/anomaly.ts — 8 tests covering all branches + fan-out

Plan 1M-anomaly-test. checkLargeChargeAndPush previously had zero
coverage. Direct function-call tests (no HTTP layer) cover:

1. amount < MIN_AMOUNT (\$30) → skip
2. uncategorized (no allocation row) → skip
3. cold-start + amount < COLD_START_AMOUNT (\$150) → skip
4. cold-start + amount >= \$150 → 1 push to owner
5. with history + amount < avg × 2.5 → skip
6. with history + amount >= avg × 2.5 BUT < MIN × 2 → skip (guard)
7. with history + both conditions → 1 push + verify all 5 args
   forwarded (env, userId, merchant, amount.toFixed(2), categoryName)
8. fan-out owner+editor+viewer → 2 pushes (viewer excluded per
   role: { in: ['owner', 'editor'] })

Mock mechanics:
- Partial vi.mock of push/send.js: sendLargeChargePush replaced by
  vi.fn().mockResolvedValue(undefined). Other exports preserved.
- afterEach uses vi.clearAllMocks (NOT restoreAllMocks — would
  restore the real Expo SDK call path).
- Real Postgres :5433 + truncateAll. No vi.spyOn(prisma).

Test fixture helpers:
- setupWorkspaceWithMembers(roles): creates user(s) + workspace +
  memberships.
- seedCategory / seedAccount / seedTransactionWithCategory: direct
  prisma.create with all required fields (rawData: {} per
  Transaction.rawData Json non-null requirement).

0 production code changes."
```

---

## Final verification

After T1 commit lands:

- [ ] **Full API suite regression**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -8
```

Expected: 0 fail (or known baseline flakes only — plaid.routes 55P03 noise).

- [ ] **Single-file commit verified**

```bash
cd /home/cwsbr/personal/fina && git show HEAD --stat
```

Expected: 1 file changed (`apps/api/tests/push.anomaly.test.ts`), ~300 insertions.
