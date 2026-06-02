# User Plaid Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile Plaid production billing by user subscription tier so Pro keeps 5 Items, Lite keeps 1, inactive users keep 0, and shared workspaces do not mix billing ownership.

**Architecture:** Add a user-scoped Plaid reconciliation service and route all tier changes, daily refresh, and Plaid connection completion through it. Replace workspace-owner trial cleanup with `connectedBy` ownership rules, serialize connection completion per user, and preserve historical transaction data while hiding billing-disconnected accounts from active views.

**Tech Stack:** TypeScript, Fastify, Prisma, PostgreSQL advisory locks, Stripe SDK, Plaid SDK, IAP clients, Vitest, Nx.

---

## Scope And Blast Radius

- **Tables:** `plaid_items`, `bank_accounts`, `transactions`, `subscriptions`, `users`, `memberships`.
- **Migrations:** No schema migration is required for the core policy. Existing `PlaidItem.connectedBy`, `BankAccount.archivedAt`, and `Transaction.plaidTransactionId` are enough.
- **APIs:** `POST /workspaces/:id/plaid/link-token`, `POST /workspaces/:id/plaid/exchange`, hosted Plaid completion, `POST /workspaces/:id/plaid-items/:itemId/sync`, `GET /workspaces/:id/plaid-items`, `GET /workspaces/:id/accounts`.
- **Billing Hooks:** Stripe checkout/session/subscription webhooks, `/billing/sync`, IAP checkout/restore sync, Apple/Google IAP webhook mutation paths.
- **Cron:** `runDailyRefresh` must refresh provider billing state, reconcile user-owned Plaid Items, disconnect orphans, then sync allowed active Items.
- **Auth/Tier Rules:** Lite `plaidItems` limit changes from 2 to 1. Plaid sync gate becomes `effectiveTier(userId).plaidItemLimit > 0` and Item ownership-aware.
- **Persistence:** Billing disconnect uses `removeItemForBilling`, sets `PlaidItem.status = disconnected`, archives linked `BankAccount` rows, and keeps `Transaction` rows.
- **UI Assumptions:** Banks/account APIs can surface owner and disconnected state. Active account views exclude archived accounts by default.
- **Tests:** Unit tests for tier limits, reconciliation, locks, sync gates, route limit checks, billing hooks, cron refresh, historical hiding, and reconnect dedupe.
- **Acceptance Criteria:** The criteria in `docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md` must pass.

## File Structure

- Create `apps/api/src/plaid/reconcile.ts`: user-scoped Plaid reconciliation, orphan cleanup, membership-invalid cleanup, provider refresh orchestration helpers.
- Create `apps/api/src/locks/user.ts`: user-scoped PostgreSQL advisory lock helper.
- Modify `libs/shared/src/tier.ts`: Lite Plaid limit from 2 to 1.
- Modify `apps/api/src/auth/tier.ts`: add a reusable Plaid sync access helper or keep `effectiveTier` and add tests for status mapping.
- Modify `apps/api/src/plaid/items.ts`: archive linked bank accounts during billing disconnect.
- Modify `apps/api/src/routes/plaid.ts`: user-wide link-token and exchange limit checks, user lock around exchange final check and item create.
- Modify `apps/api/src/routes/plaid-items.ts`: owner-aware Lite-compatible sync gate.
- Modify `apps/api/src/cron/tier-gate.ts`: background sync gate uses `plaidItemLimit > 0`.
- Modify `apps/api/src/cron/jobs/daily-refresh.ts`: replace Step 0 cleanup with provider refresh + user reconciliation + orphan pass.
- Modify `apps/api/src/stripe/sync-sub.ts` and `apps/api/src/routes/billing-webhook.ts`: trigger reconciliation after Stripe subscription sync.
- Modify `apps/api/src/routes/billing.ts`: `/billing/sync` triggers reconciliation after provider pull.
- Modify `apps/api/src/iap/sync-sub.ts`, `apps/api/src/routes/billing-iap.ts`, and `apps/api/src/routes/billing-iap-webhook.ts`: trigger reconciliation after IAP checkout/restore/webhook row changes and direct webhook updates.
- Modify `apps/api/src/plaid/sync.ts`: add conservative reconnect dedupe helper after tests prove the case.
- Modify tests under `apps/api/tests/`: targeted tests for every changed behavior.

## Task 1: Canonical Tier Limit And Status Mapping

**Files:**
- Modify: `libs/shared/src/tier.ts`
- Modify: `apps/api/tests/plaid.tier.test.ts`
- Modify: `apps/api/tests/billing-tier.test.ts`
- Verify: `apps/web/src/app/(app)/settings/plan/page.tsx` reads `TIER_LIMITS`. Run `rg -n "2.*Plaid|Plaid.*2|plaidItems" 'apps/web/src/app/(app)/settings/plan/page.tsx'`; expected result is a `TIER_LIMITS`-based reference and no hardcoded Lite Plaid count.

- [ ] **Step 1: Write failing tier limit tests**

Add these cases to `apps/api/tests/plaid.tier.test.ts`:

```ts
it("paid lite subscription -> plaidItemLimit: 1", () => {
  const t = computeEffectiveTier(
    { trialEndsAt: null },
    [{ tier: "lite" }],
  );
  expect(t.tier).toBe("lite");
  expect(t.plaidItemLimit).toBe(1);
});

it("paid pro subscription -> plaidItemLimit: 5", () => {
  const t = computeEffectiveTier(
    { trialEndsAt: null },
    [{ tier: "pro" }],
  );
  expect(t.tier).toBe("pro");
  expect(t.plaidItemLimit).toBe(5);
});
```

Add this assertion to the existing Lite test in `apps/api/tests/billing-tier.test.ts`:

```ts
expect(t.plaidItemLimit).toBe(1);
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.tier.test.ts apps/api/tests/billing-tier.test.ts
```

Expected: `paid lite subscription -> plaidItemLimit: 1` fails with received `2`.

- [ ] **Step 3: Update canonical limit**

Change `libs/shared/src/tier.ts`:

```ts
export const TIER_LIMITS: Record<Tier, { plaidItems: number }> = {
  free: { plaidItems: 0 },
  lite: { plaidItems: 1 },
  pro: { plaidItems: 5 },
};
```

- [ ] **Step 4: Run tests again**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.tier.test.ts apps/api/tests/billing-tier.test.ts
```

Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add libs/shared/src/tier.ts apps/api/tests/plaid.tier.test.ts apps/api/tests/billing-tier.test.ts
git commit -m "feat: set lite plaid limit to one"
```

## Task 2: User Lock And Reconciliation Service

**Files:**
- Create: `apps/api/src/locks/user.ts`
- Create: `apps/api/src/plaid/reconcile.ts`
- Modify: `apps/api/src/plaid/items.ts`
- Test: `apps/api/tests/plaid.reconcile.test.ts`
- Test: `apps/api/tests/plaid.items.test.ts`

- [ ] **Step 1: Write failing tests for billing disconnect archiving**

In `apps/api/tests/plaid.items.test.ts`, add this case under `removeItemForBilling`. Reuse the existing local `seedItemWithTransactions()` helper in that `describe` block:

```ts
it("archives linked accounts while preserving transactions", async () => {
  const { wsId, itemRowId, accountId } = await seedItemWithTransactions();
  plaidMock.itemRemove.push({ data: { request_id: "req" } });

  await removeItemForBilling(env, wsId, itemRowId);

  const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
  const account = await prisma.bankAccount.findUniqueOrThrow({ where: { id: accountId } });
  expect(item.status).toBe("disconnected");
  expect(account.archivedAt).not.toBeNull();
  await expect(prisma.transaction.count({ where: { accountId } })).resolves.toBe(1);
});
```

- [ ] **Step 2: Write failing billing-disconnect lock test**

In `apps/api/tests/plaid.items.test.ts`, add this case under `removeItemForBilling`:

```ts
it("does not update local billing status while a sync lock is held", async () => {
  const { wsId, itemRowId } = await seedItemWithTransactions();
  plaidMock.itemRemove.push({ data: { request_id: "req" } });
  vi.spyOn(await import("../src/plaid/lock.js"), "lockPlaidItem").mockRejectedValueOnce(
    new Error("plaid_item is locked by another sync/disconnect"),
  );

  await expect(removeItemForBilling(env, wsId, itemRowId)).rejects.toThrow(/locked by another sync\/disconnect/i);

  const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
  expect(item.status).toBe("active");
});
```

- [ ] **Step 3: Write failing reconciliation tests**

Create `apps/api/tests/plaid.reconcile.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { reconcilePlaidItemsForUser, reconcileOrphanPlaidItems } from "../src/plaid/reconcile.js";
import { plaidMock, resetPlaidMock } from "./helpers/plaid-mock.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

async function userWithTrial(email: string, trialEndsAt: Date | null) {
  return prisma.user.create({
    data: { email, name: email, trialEndsAt },
  });
}

async function workspaceForOwner(userId: string) {
  return prisma.workspace.create({
    data: {
      name: "Test workspace",
      memberships: { create: { userId, role: "owner" } },
    },
  });
}

async function item(opts: { workspaceId: string; connectedBy: string | null; createdAt: Date; itemId: string }) {
  return prisma.plaidItem.create({
    data: {
      workspaceId: opts.workspaceId,
      connectedBy: opts.connectedBy,
      itemId: opts.itemId,
      institutionId: "ins",
      institutionName: opts.itemId,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from(new Array(12).fill(2)),
      createdAt: opts.createdAt,
      bankAccounts: {
        create: {
          workspaceId: opts.workspaceId,
          plaidAccountId: `${opts.itemId}_acct`,
          name: opts.itemId,
          type: "depository",
          currency: "CAD",
        },
      },
    },
  });
}

beforeEach(async () => {
  resetPlaidMock();
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("reconcilePlaidItemsForUser", () => {
  it("lite keeps earliest one and disconnects later user-owned items", async () => {
    const u = await userWithTrial("lite@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "lite",
        source: "stripe",
        sourceSubscriptionId: "sub_lite",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(u.id);
    const first = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "first" });
    const second = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "second" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-second" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept).toEqual([first.id]);
    expect(result.disconnected).toEqual([second.id]);
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({ status: "active" });
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: second.id } })).resolves.toMatchObject({ status: "disconnected" });
  });

  it("does not count another member's item against the user", async () => {
    const owner = await userWithTrial("owner@example.com", null);
    const other = await userWithTrial("other@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: owner.id,
        tier: "lite",
        source: "stripe",
        sourceSubscriptionId: "sub_owner",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(owner.id);
    await prisma.membership.create({ data: { workspaceId: ws.id, userId: other.id, role: "editor" } });
    const owned = await item({ workspaceId: ws.id, connectedBy: owner.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "owned" });
    const others = await item({ workspaceId: ws.id, connectedBy: other.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "others" });

    const result = await reconcilePlaidItemsForUser(env, owner.id);

    expect(result.kept).toEqual([owned.id]);
    expect(result.disconnected).toEqual([]);
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: others.id } })).resolves.toMatchObject({ status: "active" });
  });

  it("disconnects items when connectedBy has no workspace membership", async () => {
    const u = await userWithTrial("left@example.com", null);
    const ws = await workspaceForOwner(u.id);
    await prisma.membership.deleteMany({ where: { userId: u.id, workspaceId: ws.id } });
    const stale = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "stale" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-stale" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.disconnected).toEqual([stale.id]);
  });
});

describe("reconcileOrphanPlaidItems", () => {
  it("disconnects null-owner items", async () => {
    const u = await userWithTrial("owner2@example.com", null);
    const ws = await workspaceForOwner(u.id);
    const orphan = await item({ workspaceId: ws.id, connectedBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "orphan" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-orphan" } });

    const result = await reconcileOrphanPlaidItems(env);

    expect(result.disconnected).toEqual([orphan.id]);
  });
});
```

- [ ] **Step 4: Write failing reconciliation edge-case tests**

In `apps/api/tests/plaid.reconcile.test.ts`, add:

```ts
it("pro keeps earliest five and disconnects the sixth", async () => {
  const u = await userWithTrial("pro@example.com", null);
  await prisma.subscription.create({
    data: {
      userId: u.id,
      tier: "pro",
      source: "stripe",
      sourceSubscriptionId: "sub_pro",
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
  const ws = await workspaceForOwner(u.id);
  const rows = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      item({
        workspaceId: ws.id,
        connectedBy: u.id,
        createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
        itemId: `pro_${i}`,
      }),
    ),
  );
  plaidMock.itemRemove.push({ data: { request_id: "remove-sixth" } });

  const result = await reconcilePlaidItemsForUser(env, u.id);

  expect(result.kept).toEqual(rows.slice(0, 5).map((r) => r.id));
  expect(result.disconnected).toEqual([rows[5]!.id]);
});

it("canceled/free user disconnects all owned billable items", async () => {
  const u = await userWithTrial("free@example.com", null);
  await prisma.subscription.create({
    data: {
      userId: u.id,
      tier: "pro",
      source: "stripe",
      sourceSubscriptionId: "sub_canceled",
      status: "canceled",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
  const ws = await workspaceForOwner(u.id);
  const first = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "free_a" });
  const second = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "free_b" });
  plaidMock.itemRemove.push({ data: { request_id: "remove-a" } }, { data: { request_id: "remove-b" } });

  const result = await reconcilePlaidItemsForUser(env, u.id);

  expect(result.kept).toEqual([]);
  expect(result.disconnected.sort()).toEqual([first.id, second.id].sort());
});

it("counts active, error, and relink_required as billable but ignores disconnected", async () => {
  const u = await userWithTrial("status@example.com", null);
  await prisma.subscription.create({
    data: {
      userId: u.id,
      tier: "lite",
      source: "stripe",
      sourceSubscriptionId: "sub_status",
      status: "active",
      currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
    },
  });
  const ws = await workspaceForOwner(u.id);
  const active = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "status_active" });
  const error = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "status_error" });
  const relink = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-03T00:00:00Z"), itemId: "status_relink" });
  const disconnected = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-04T00:00:00Z"), itemId: "status_disconnected" });
  await prisma.plaidItem.update({ where: { id: error.id }, data: { status: "error" } });
  await prisma.plaidItem.update({ where: { id: relink.id }, data: { status: "relink_required" } });
  await prisma.plaidItem.update({ where: { id: disconnected.id }, data: { status: "disconnected" } });
  plaidMock.itemRemove.push({ data: { request_id: "remove-error" } }, { data: { request_id: "remove-relink" } });

  const result = await reconcilePlaidItemsForUser(env, u.id);

  expect(result.kept).toEqual([active.id]);
  expect(result.disconnected.sort()).toEqual([error.id, relink.id].sort());
});
```

- [ ] **Step 5: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.items.test.ts apps/api/tests/plaid.reconcile.test.ts
```

Expected: missing module/function failures and the archive assertion fails.

- [ ] **Step 6: Implement user lock helper**

Create `apps/api/src/locks/user.ts`:

```ts
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

export async function withUserLock<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${userId}`}))`;
    return await callback(tx);
  });
}
```

- [ ] **Step 7: Archive accounts in billing disconnect with Plaid row lock**

Modify `apps/api/src/plaid/items.ts`: import the shared lock helper, then replace the final local status update in `removeItemForBilling` with a locked transaction:

```ts
import { lockPlaidItem } from "./lock.js";

await prisma.$transaction(async (tx) => {
  await lockPlaidItem(tx, plaidItemId);
  await tx.bankAccount.updateMany({
    where: { plaidItemId },
    data: { archivedAt: new Date() },
  });
  await tx.plaidItem.update({
    where: { id: plaidItemId },
    data: { status: "disconnected", errorCode: null },
  });
});
```

The function must let `SyncLockHeld` bubble to reconciliation callers; `reconcilePlaidItemsForUser` already records it in `failed` so a later cron/webhook retry can disconnect without racing a live sync.

- [ ] **Step 8: Implement reconciliation service**

Create `apps/api/src/plaid/reconcile.ts`:

```ts
import type { PlaidItemStatus } from "@prisma/client";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { effectiveTier } from "../auth/tier.js";
import { removeItemForBilling } from "./items.js";
import { sanitizePlaidError } from "./client.js";
import { logError } from "../logger.js";

type ReconcileResult = {
  kept: string[];
  disconnected: string[];
  failed: Array<{ id: string; error: unknown }>;
};

const billableStatuses: PlaidItemStatus[] = ["active", "error", "relink_required"];

export async function reconcilePlaidItemsForUser(env: Env, userId: string): Promise<ReconcileResult> {
  const tier = await effectiveTier(userId);
  const rows = await prisma.plaidItem.findMany({
    where: {
      connectedBy: userId,
      status: { in: billableStatuses },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      workspaceId: true,
      workspace: {
        select: {
          memberships: {
            where: { userId },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  const valid: typeof rows = [];
  const invalidMembership: typeof rows = [];
  for (const row of rows) {
    if (row.workspace.memberships.length === 0) invalidMembership.push(row);
    else valid.push(row);
  }

  const keep = new Set(valid.slice(0, tier.plaidItemLimit).map((r) => r.id));
  const toDisconnect = [
    ...invalidMembership,
    ...valid.filter((r) => !keep.has(r.id)),
  ];

  const result: ReconcileResult = { kept: Array.from(keep), disconnected: [], failed: [] };
  for (const row of toDisconnect) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "plaid reconciliation disconnect failed");
    }
  }
  return result;
}

export async function reconcileOrphanPlaidItems(env: Env): Promise<ReconcileResult> {
  const rows = await prisma.plaidItem.findMany({
    where: {
      connectedBy: null,
      status: { in: billableStatuses },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, workspaceId: true },
  });
  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  for (const row of rows) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "orphan plaid reconciliation disconnect failed");
    }
  }
  return result;
}

export async function retryPendingPlaidBillingCleanups(env: Env): Promise<ReconcileResult> {
  const rows = await prisma.plaidItem.findMany({
    where: { status: "disconnected", errorCode: "billing_cleanup_pending" },
    select: { id: true, workspaceId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  for (const row of rows) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
      await prisma.plaidItem.update({ where: { id: row.id }, data: { errorCode: null } });
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "pending plaid cleanup retry failed");
    }
  }
  return result;
}
```

- [ ] **Step 9: Run tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.items.test.ts apps/api/tests/plaid.reconcile.test.ts
```

Expected: both files pass.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/locks/user.ts apps/api/src/plaid/reconcile.ts apps/api/src/plaid/items.ts apps/api/tests/plaid.items.test.ts apps/api/tests/plaid.reconcile.test.ts
git commit -m "feat: reconcile plaid items by user"
```

## Task 3: User-Wide Connect Limits And Exchange Serialization

**Files:**
- Modify: `apps/api/src/routes/plaid.ts`
- Test: `apps/api/tests/plaid.routes.test.ts`
- Test: `apps/api/tests/plaid.exchange.test.ts`
- Test: `apps/api/tests/plaid.hosted-token.test.ts`

- [ ] **Step 1: Write failing route tests**

Add route tests covering:

```ts
it("link-token counts user-owned items across workspaces", async () => {
  // user has Lite subscription and one active item in workspace A
  // POST link-token in workspace B returns 402 plaid_item_limit_reached
});

it("link-token ignores another member's item in same workspace", async () => {
  // Lite user has zero owned items; another member has one item in same workspace
  // POST link-token returns 200 with linkToken
});
```

Use the existing sign-up, workspace, and Plaid mocks in `apps/api/tests/plaid.routes.test.ts`. Assert the exact response code and error:

```ts
expect(res.statusCode).toBe(402);
expect(res.json()).toEqual({ error: "plaid_item_limit_reached" });
```

Add exchange tests in `apps/api/tests/plaid.exchange.test.ts`:

```ts
it("exchange rechecks user-wide limit after link token was issued", async () => {
  // Lite user already has one active connectedBy item.
  // Mock public token exchange and accountsGet.
  // POST /plaid/exchange returns 402 plaid_item_limit_reached before creating a new item.
});
```

Add a concurrency test:

```ts
it("concurrent exchanges for same Lite user create at most one item", async () => {
  // Lite user starts with zero active items.
  // Fire two exchange requests with two different public tokens.
  // Expect exactly one 200 and one 402.
  // Expect prisma.plaidItem.count({ where: { connectedBy: userId, status: { not: "disconnected" } } }) === 1.
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.routes.test.ts apps/api/tests/plaid.exchange.test.ts apps/api/tests/plaid.hosted-token.test.ts
```

Expected: user-wide route tests fail because current code counts by workspace and exchange is not serialized per user.

- [ ] **Step 3: Replace workspace count with user count helper**

In `apps/api/src/routes/plaid.ts`, replace `checkPlaidItemLimit(userId, workspaceId)` with:

```ts
async function checkPlaidItemLimit(userId: string): Promise<{ error: string } | null> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit === 0) return { error: "upgrade_required" };
  const count = await prisma.plaidItem.count({
    where: {
      connectedBy: userId,
      status: { not: "disconnected" },
    },
  });
  if (count >= t.plaidItemLimit) return { error: "plaid_item_limit_reached" };
  return null;
}
```

Update link-token call sites:

```ts
const limitErr = await checkPlaidItemLimit(ctx.session.userId);
```

- [ ] **Step 4: Serialize exchange final check and create**

Import `withUserLock`:

```ts
import { withUserLock } from "../locks/user.js";
```

Move the exchange Item/account create block under a user lock. Keep the Plaid `itemPublicTokenExchange` and `accountsGet` calls before the lock. Immediately after exchange, create a non-optional local token:

```ts
const exchangedAccessToken = exch.data.access_token as string;
exchAccessToken = exchangedAccessToken;
```

Then do the final limit check and database writes inside the lock:

```ts
const result = await withUserLock(ctx.session.userId, async (userTx) => {
  const t = await effectiveTier(ctx.session.userId);
  if (t.plaidItemLimit === 0) {
    try {
      await plaidClient(app.fina.env).itemRemove({ access_token: exchangedAccessToken });
    } catch (e) {
      await persistPendingBillingCleanup(userTx, exchangedAccessToken, e);
    }
    return { rejected: "upgrade_required" as const };
  }
  const existingCount = await userTx.plaidItem.count({
    where: {
      connectedBy: ctx.session.userId,
      status: { not: "disconnected" },
    },
  });
  const limitErr = existingCount >= t.plaidItemLimit ? { error: "plaid_item_limit_reached" } : null;
  if (limitErr) {
    try {
      await plaidClient(app.fina.env).itemRemove({ access_token: exchangedAccessToken });
    } catch (e) {
      await persistPendingBillingCleanup(userTx, exchangedAccessToken, e);
      logWarn({ err: e }, "plaid.itemRemove failed during limit cleanup");
    }
    return { rejected: limitErr.error as "plaid_item_limit_reached" };
  }

  await userTx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.membership.workspaceId}))`;

  const wsLocked = await userTx.workspace.findUniqueOrThrow({
    where: { id: ctx.membership.workspaceId },
    select: { currency: true },
  });
  const mismatch2 = accountsRes.data.accounts.find(
    (a) => (a.balances?.iso_currency_code ?? null) !== wsLocked.currency,
  );
  if (mismatch2) {
    const err = new Error("currency_mismatch_inlock") as Error & {
      code: "currency_mismatch_inlock";
      bankCurrency: string;
      workspaceCurrency: string;
    };
    err.code = "currency_mismatch_inlock";
    err.bankCurrency = mismatch2.balances?.iso_currency_code ?? "unknown";
    err.workspaceCurrency = wsLocked.currency;
    throw err;
  }

  const itemRowId = await storeAccessToken(app.fina.env, userTx, {
    workspaceId: ctx.membership.workspaceId,
    connectedBy: ctx.session.userId,
    itemId: exch.data.item_id,
    institutionId: parsed.data.institutionId,
    institutionName: parsed.data.institutionName,
    accessToken: exch.data.access_token,
    webhookUrl: app.fina.env.PLAID_WEBHOOK_URL ?? null,
  });
  for (const a of accountsRes.data.accounts) {
    await userTx.bankAccount.create({
      data: {
        workspaceId: ctx.membership.workspaceId,
        plaidItemId: itemRowId,
        plaidAccountId: a.account_id,
        name: a.name,
        officialName: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type,
        subtype: a.subtype ?? null,
        currency: a.balances?.iso_currency_code ?? "CAD",
        balanceCurrent: a.balances?.current ?? null,
        balanceAvailable: a.balances?.available ?? null,
        balanceLimit: a.balances?.limit ?? null,
        lastBalanceSyncAt: new Date(),
      },
    });
  }
  return { itemRowId, accountCount: accountsRes.data.accounts.length };
});
if ("rejected" in result) {
  return reply.code(402).send({ error: result.rejected });
}
```

- [ ] **Step 5: Ensure cleanup on final limit failure**

When exchange final check fails after receiving an `access_token`, call `itemRemove` with `exchAccessToken` before returning `402`. On `itemRemove` failure, persist a local disconnected cleanup row so daily reconciliation can retry removal without granting an active connection:

```ts
async function persistPendingBillingCleanup(
  tx: Prisma.TransactionClient,
  accessToken: string,
  err: unknown,
): Promise<void> {
  await storeAccessToken(app.fina.env, tx, {
    workspaceId: ctx.membership.workspaceId,
    connectedBy: ctx.session.userId,
    itemId: exch.data.item_id,
    institutionId: parsed.data.institutionId,
    institutionName: parsed.data.institutionName,
    accessToken,
    webhookUrl: app.fina.env.PLAID_WEBHOOK_URL ?? null,
  }).then((id) =>
    tx.plaidItem.update({
      where: { id },
      data: { status: "disconnected", errorCode: "billing_cleanup_pending" },
    }),
  );
  logWarn({ err }, "stored pending Plaid billing cleanup after itemRemove failure");
}
```

Add a test in `apps/api/tests/plaid.exchange.test.ts`:

```ts
it("stores pending cleanup row when final limit cleanup fails", async () => {
  // Lite user already owns one active item.
  // Mock itemPublicTokenExchange/accountsGet success and itemRemove failure.
  // POST /plaid/exchange returns 402 plaid_item_limit_reached.
  // Expect one row with itemId from exchange, connectedBy userId,
  // status disconnected, errorCode billing_cleanup_pending, and encrypted token present.
});
```

- [ ] **Step 6: Run tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.routes.test.ts apps/api/tests/plaid.exchange.test.ts apps/api/tests/plaid.hosted-token.test.ts
```

Expected: all route/connect tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/plaid.ts apps/api/tests/plaid.routes.test.ts apps/api/tests/plaid.exchange.test.ts apps/api/tests/plaid.hosted-token.test.ts
git commit -m "feat: enforce plaid limits per user"
```

## Task 4: Lite-Compatible Sync Gates

**Files:**
- Modify: `apps/api/src/cron/tier-gate.ts`
- Modify: `apps/api/src/routes/plaid-items.ts`
- Test: `apps/api/tests/cron.tier-gate.test.ts`
- Test: `apps/api/tests/plaid.routes.test.ts`

- [ ] **Step 1: Write failing sync-gate tests**

In `apps/api/tests/cron.tier-gate.test.ts`, update/add:

```ts
it("lite subscription can background sync", async () => {
  vi.mocked(effectiveTier).mockResolvedValueOnce({
    tier: "lite",
    source: "paid",
    trialActive: false,
    trialEndsAt: null,
    plaidItemLimit: 1,
  });
  expect(await checkBackgroundSyncGate("u-lite")).toEqual({ ok: true });
});

it("free user cannot background sync", async () => {
  vi.mocked(effectiveTier).mockResolvedValueOnce({
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: null,
    plaidItemLimit: 0,
  });
  expect(await checkBackgroundSyncGate("u-free")).toEqual({ ok: false, reason: "no_plaid_entitlement" });
});
```

In `apps/api/tests/plaid.routes.test.ts`, update the “sync IS Pro-gated” test into a Lite-positive test:

```ts
it("lite owner can manually sync their active owned item", async () => {
  // Create Lite subscription for owner.
  // Connect one item with connectedBy owner.
  // POST /plaid-items/:itemId/sync returns 200.
});
```

Add a negative ownership test:

```ts
it("owner cannot sync another user's connected item", async () => {
  // Workspace owner requests sync for item connectedBy another member.
  // Expect 403 insufficient_role or 404 not_found, matching existing HttpError taxonomy.
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/cron.tier-gate.test.ts apps/api/tests/plaid.routes.test.ts
```

Expected: Lite background/manual sync fails under Pro-only gates.

- [ ] **Step 3: Update background gate**

Replace `apps/api/src/cron/tier-gate.ts` with:

```ts
import { effectiveTier } from "../auth/tier.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

export async function checkBackgroundSyncGate(userId: string): Promise<GateResult> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit > 0) return { ok: true };
  return { ok: false, reason: "no_plaid_entitlement" };
}
```

- [ ] **Step 4: Update manual sync route**

In `apps/api/src/routes/plaid-items.ts`, replace `requireProTier` import with `effectiveTier`, then before sync:

```ts
const item = await prisma.plaidItem.findFirst({
  where: {
    id: params.itemId,
    workspaceId: ctx.membership.workspaceId,
    connectedBy: ctx.session.userId,
    status: { not: "disconnected" },
  },
  select: { id: true },
});
if (!item) return reply.code(404).send({ error: "not_found" });

const tier = await effectiveTier(ctx.session.userId);
if (tier.plaidItemLimit <= 0) {
  return reply.code(402).send({ error: "upgrade_required" });
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/cron.tier-gate.test.ts apps/api/tests/plaid.routes.test.ts
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cron/tier-gate.ts apps/api/src/routes/plaid-items.ts apps/api/tests/cron.tier-gate.test.ts apps/api/tests/plaid.routes.test.ts
git commit -m "feat: allow plaid sync for lite owners"
```

## Task 5: Billing Hooks And Daily Provider Refresh

**Files:**
- Modify: `apps/api/src/stripe/sync-sub.ts`
- Modify: `apps/api/src/routes/billing-webhook.ts`
- Modify: `apps/api/src/routes/billing.ts`
- Modify: `apps/api/src/iap/sync-sub.ts`
- Modify: `apps/api/src/routes/billing-iap.ts`
- Modify: `apps/api/src/routes/billing-iap-webhook.ts`
- Modify: `apps/api/src/cron/jobs/daily-refresh.ts`
- Test: `apps/api/tests/billing-webhook.test.ts`
- Test: `apps/api/tests/billing-sync.test.ts`
- Test: `apps/api/tests/iap/billing-iap.routes.test.ts`
- Test: `apps/api/tests/iap/sync-sub.test.ts`
- Test: `apps/api/tests/iap/billing-iap-webhook.test.ts`
- Test: `apps/api/tests/cron.daily-refresh.test.ts`

- [ ] **Step 1: Write failing hook tests**

Add mocks for `reconcilePlaidItemsForUser` in billing tests:

```ts
vi.mock("../src/plaid/reconcile.js", async () => {
  return {
    reconcilePlaidItemsForUser: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
    reconcileOrphanPlaidItems: vi.fn().mockResolvedValue({ kept: [], disconnected: [], failed: [] }),
  };
});
```

In Stripe webhook tests, assert:

```ts
expect(reconcilePlaidItemsForUser).toHaveBeenCalledWith(env, user.id);
```

In `/billing/sync` tests, assert reconciliation after sync.

In `apps/api/tests/iap/billing-iap.routes.test.ts`, assert successful `/billing/iap/checkout` calls `reconcilePlaidItemsForUser(app.fina.env, userId)` after sync.

In `apps/api/tests/iap/billing-iap.routes.test.ts`, assert `/billing/iap/restore` calls `reconcilePlaidItemsForUser(app.fina.env, userId)` once after at least one purchase sync succeeds.

In Apple family-sharing revocation test, assert reconciliation after direct `status = canceled`.

In Google linked purchase-token replacement tests, assert reconciliation for the resolved user.

- [ ] **Step 2: Write failing daily refresh provider tests**

In `apps/api/tests/cron.daily-refresh.test.ts`, add:

```ts
it("lists Stripe subscriptions with status all before Plaid reconciliation", async () => {
  // user has stripeCustomerId and one non-disconnected Plaid Item
  // stripe.subscriptions.list mock expects { customer, status: "all", limit: 10 }
  // runDailyRefresh(env)
});
```

Add:

```ts
it("provider refresh failure does not disconnect Plaid items by itself", async () => {
  // Mock Stripe list failure.
  // runDailyRefresh(env)
  // expect removeItemForBilling not called solely due to provider failure.
});

it("refreshes Apple IAP status before Plaid reconciliation", async () => {
  // user has active iap_apple subscription row and one non-disconnected Plaid Item.
  // Mock AppleClient.getSubscriptionStatus(originalTransactionId) to return canceled.
  // Only APPLE_* env is configured; GOOGLE_* env is intentionally absent.
  // runDailyRefresh(env)
  // expect subscription.status canceled before reconcilePlaidItemsForUser is called.
});

it("refreshes Google IAP status before Plaid reconciliation", async () => {
  // user has active iap_google subscription row and one non-disconnected Plaid Item.
  // Mock GoogleClient.fetchAndNormalize(sourceSubscriptionId) to return mapped canceled.
  // Only GOOGLE_* env is configured; APPLE_* env is intentionally absent.
  // runDailyRefresh(env)
  // expect subscription.status canceled before reconcilePlaidItemsForUser is called.
});
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/billing-webhook.test.ts apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts apps/api/tests/iap/sync-sub.test.ts apps/api/tests/iap/billing-iap-webhook.test.ts apps/api/tests/cron.daily-refresh.test.ts
```

Expected: reconcile mock assertions fail and daily refresh still uses old workspace-owner cleanup.

- [ ] **Step 4: Trigger reconciliation in Stripe sync paths**

In `apps/api/src/stripe/sync-sub.ts`, return `userId` with the result:

```ts
return { status: upserted.status, tier: upserted.tier, userId };
```

In `apps/api/src/routes/billing-webhook.ts`, after `syncSubscriptionFromStripe`:

```ts
await reconcilePlaidItemsForUser(app.fina.env, userId);
```

In `apps/api/src/routes/billing.ts`, after every subscription sync in `/billing/sync`, call:

```ts
await reconcilePlaidItemsForUser(app.fina.env, user.id);
```

- [ ] **Step 5: Trigger reconciliation in IAP paths**

Keep `apps/api/src/iap/sync-sub.ts` pure; it only receives `Partial<IapConfig>` and must not import API `Env`. Add the reconciliation import to `apps/api/src/routes/billing-iap-webhook.ts` and `apps/api/src/routes/billing-iap.ts`:

```ts
import { reconcilePlaidItemsForUser } from "../plaid/reconcile.js";
```

Then add this call immediately after every successful `syncSubscriptionFromIAP(...)` call in those route files. In `/billing/iap/restore`, call it once after the loop when at least one purchase sync succeeded:

```ts
await reconcilePlaidItemsForUser(app.fina.env, userId);
```

For direct Apple family-sharing revocation in `apps/api/src/routes/billing-iap-webhook.ts`, replace the current `subscription.updateMany` block with this user-resolving block:

```ts
const sub = await prisma.subscription.findFirst({
  where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
  select: { userId: true },
});
if (sub) {
  await prisma.subscription.updateMany({
    where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
    data: { status: "canceled" },
  });
  await reconcilePlaidItemsForUser(app.fina.env, sub.userId);
}
```

- [ ] **Step 6: Replace daily refresh Step 0**

In `apps/api/src/cron/jobs/daily-refresh.ts`, remove the old `expiredItems` workspace-owner query. Add:

```ts
const owners = await prisma.plaidItem.findMany({
  where: { status: { not: "disconnected" }, connectedBy: { not: null } },
  distinct: ["connectedBy"],
  select: { connectedBy: true },
});

for (const row of owners) {
  if (!row.connectedBy) continue;
  await refreshBillingStateForUser(env, row.connectedBy).catch((e) =>
    logError({ cron: CRON_NAME, userId: row.connectedBy, err: e }, "daily-refresh billing-state refresh failed"),
  );
  await reconcilePlaidItemsForUser(env, row.connectedBy);
}
await retryPendingPlaidBillingCleanups(env);
await reconcileOrphanPlaidItems(env);
```

Create `refreshBillingStateForUser` in `apps/api/src/plaid/reconcile.ts`. For Stripe:

```ts
const user = await prisma.user.findUnique({ where: { id: userId }, select: { stripeCustomerId: true } });
if (user?.stripeCustomerId) {
  const stripe = stripeClient(env);
  const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: "all", limit: 10 });
  for (const sub of subs.data) {
    await syncSubscriptionFromStripe(env, sub.id, userId);
  }
}
```

For Apple and Google IAP, re-query provider state before reconciliation:

```ts
const iapRows = await prisma.subscription.findMany({
  where: {
    userId,
    source: { in: ["iap_apple", "iap_google"] },
    status: { in: ["trialing", "active", "past_due", "paused", "incomplete"] },
  },
  select: { id: true, source: true, sourceSubscriptionId: true },
});
if (iapRows.length > 0) {
  for (const row of iapRows) {
    if (row.source === "iap_apple") {
      const cfg = requireAppleIapEnv(process.env);
      const appleClient = new AppleClient(cfg);
      const status = await appleClient.getSubscriptionStatus(row.sourceSubscriptionId);
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          status: status.mapped.status,
          currentPeriodEnd: status.expiresDate,
          cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
          tier: tierForIapProductId(status.productId) ?? undefined,
        },
      });
    }
    if (row.source === "iap_google") {
      const cfg = requireGoogleIapEnv(process.env);
      const googleClient = new GoogleClient(cfg);
      const status = await googleClient.fetchAndNormalize(row.sourceSubscriptionId);
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          status: status.mapped.status,
          currentPeriodEnd: status.expiryTime,
          cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
          tier: tierForIapProductId(status.productId) ?? undefined,
          environment: status.environment,
        },
      });
      await googleClient.acknowledgeIfPending({
        purchaseToken: row.sourceSubscriptionId,
        productId: status.productId,
        acknowledgementState: status.acknowledgementState,
      });
    }
  }
}
```

Provider refresh failures are logged and do not synthesize a canceled status; the existing local subscription row remains unchanged and the next daily run retries.

- [ ] **Step 7: Run tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/billing-webhook.test.ts apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts apps/api/tests/iap/sync-sub.test.ts apps/api/tests/iap/billing-iap-webhook.test.ts apps/api/tests/cron.daily-refresh.test.ts
```

Expected: tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/stripe/sync-sub.ts apps/api/src/routes/billing-webhook.ts apps/api/src/routes/billing.ts apps/api/src/iap/sync-sub.ts apps/api/src/routes/billing-iap.ts apps/api/src/routes/billing-iap-webhook.ts apps/api/src/cron/jobs/daily-refresh.ts apps/api/src/plaid/reconcile.ts apps/api/tests/billing-webhook.test.ts apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts apps/api/tests/iap/sync-sub.test.ts apps/api/tests/iap/billing-iap-webhook.test.ts apps/api/tests/cron.daily-refresh.test.ts
git commit -m "feat: reconcile plaid items after billing changes"
```

## Task 6: Reconnect Transaction Dedupe

**Files:**
- Modify: `apps/api/src/plaid/sync.ts`
- Test: `apps/api/tests/plaid.sync.test.ts`

- [ ] **Step 1: Write failing reconnect dedupe tests**

In `apps/api/tests/plaid.sync.test.ts`, add:

```ts
it("reconnect dedupe updates strong historical match instead of inserting duplicate", async () => {
  // Create disconnected historical item/account with institutionId, mask, type, subtype, currency.
  // Create historical transaction with plaidTransactionId "old_tx".
  // Create new active item/account with same institutionId, mask, type, subtype, currency.
  // Mock transactionsSync added transaction with new transaction_id but same date, amount, merchant.
  // syncTransactions(env, wsId, newItemId)
  // expect transaction count to stay 1 and existing row to have new plaidTransactionId.
});

it("reconnect dedupe inserts when account fingerprint has multiple matches", async () => {
  // Two disconnected historical accounts share the fingerprint.
  // New transaction is inserted, not merged.
});

it("reconnect dedupe inserts when merchant differs", async () => {
  // Unique account fingerprint but different normalized merchant.
  // New transaction is inserted.
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.sync.test.ts
```

Expected: reconnect dedupe test inserts duplicates.

- [ ] **Step 3: Implement account fingerprint and merchant helpers**

In `apps/api/src/plaid/sync.ts`, import the existing merchant normalizer and add helper functions near `accountIdForPlaidAccount`:

```ts
import { normalizeMerchant } from "../categorize/normalize.js";
```

```ts
async function disconnectedAccountMatch(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  currentAccount: {
    id: string;
    mask: string | null;
    type: string;
    subtype: string | null;
    currency: string;
    plaidItem: { institutionId: string } | null;
  },
): Promise<string | null> {
  if (!currentAccount.plaidItem || !currentAccount.mask) return null;
  const matches = await tx.bankAccount.findMany({
    where: {
      workspaceId,
      archivedAt: { not: null },
      mask: currentAccount.mask,
      type: currentAccount.type,
      subtype: currentAccount.subtype,
      currency: currentAccount.currency,
      plaidItem: { is: { institutionId: currentAccount.plaidItem.institutionId, status: "disconnected" } },
    },
    select: { id: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0]!.id : null;
}

function plaidMerchantRaw(t: PlaidTxLike): string {
  return t.merchant_name ?? t.name ?? "Unknown";
}
```

This helper intentionally matches only billing-disconnected accounts that still point at their original `plaidItem`; strict user-initiated deletion sets `plaidItemId = null` and is excluded from reconnect dedupe.

- [ ] **Step 4: Implement strong transaction match**

Before fresh create in `upsertAdded`, after resolving current `accountId`, load current account with Plaid Item:

```ts
const currentAccount = await tx.bankAccount.findUniqueOrThrow({
  where: { id: accountId },
  select: {
    id: true,
    mask: true,
    type: true,
    subtype: true,
    currency: true,
    plaidItem: { select: { institutionId: true } },
  },
});
const oldAccountId = await disconnectedAccountMatch(tx, workspaceId, currentAccount);
```

When `oldAccountId` is non-null, look for one historical transaction:

```ts
const rawMerchant = plaidMerchantRaw(t);
const merchantNormalized = normalizeMerchant(rawMerchant);
const candidates = await tx.transaction.findMany({
  where: {
    workspaceId,
    accountId: oldAccountId,
    source: "plaid",
    plaidTransactionId: { not: null },
    plaidItem: { is: { status: "disconnected" } },
    occurredAt: plaidOccurredAt(t),
    amount: new Prisma.Decimal(t.amount),
  },
  select: { id: true, merchantRaw: true, merchantNormalized: true },
});
const strongMatches = candidates.filter((candidate) => {
  const existingMerchant = candidate.merchantNormalized ?? normalizeMerchant(candidate.merchantRaw);
  return existingMerchant === merchantNormalized;
});
if (strongMatches.length === 1) {
  await tx.transaction.update({
    where: { id: strongMatches[0]!.id },
    data: {
      accountId,
      plaidItemId,
      plaidTransactionId: t.transaction_id,
      plaidPendingTransactionId: t.pending_transaction_id ?? null,
      pending: t.pending,
      merchantRaw: rawMerchant,
      merchantNormalized,
      rawData: t as unknown as Prisma.InputJsonValue,
      removedAt: null,
    },
  });
  return { kind: "updated", localId: strongMatches[0]!.id };
}
```

This keeps the match conservative: account fingerprint, date, amount, and normalized merchant must match; the raw fallback only covers legacy rows where `merchantNormalized` is still null.

- [ ] **Step 5: Run tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.sync.test.ts
```

Expected: tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plaid/sync.ts apps/api/tests/plaid.sync.test.ts
git commit -m "feat: dedupe transactions after plaid reconnect"
```

## Task 7: Active/Disconnected Account Visibility And Banks Ownership

**Files:**
- Modify: `libs/shared/src/dto/plaid.ts`
- Modify: `apps/api/src/routes/accounts.ts`
- Modify: `apps/api/src/routes/plaid-items.ts`
- Modify: `apps/web/src/app/(app)/settings/banks/_components/connected-banks-list.tsx`
- Modify: `apps/web/src/app/(app)/settings/banks/page.tsx`
- Test: `apps/api/tests/plaid.routes.test.ts`
- Create: `apps/api/tests/accounts.routes.test.ts`

- [ ] **Step 1: Write failing API visibility tests**

Add tests:

```ts
it("accounts endpoint hides billing-disconnected archived accounts by default", async () => {
  // Create bankAccount with archivedAt set.
  // GET /accounts returns [].
  // GET /accounts?includeArchived=true returns the account.
});

it("plaid-items list returns connectedBy owner display fields", async () => {
  // Create item connectedBy user.
  // GET /plaid-items includes connectedByUserId and connectedByName.
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.routes.test.ts apps/api/tests/accounts.routes.test.ts
```

- [ ] **Step 3: Return ownership metadata**

First update the shared DTO in `libs/shared/src/dto/plaid.ts`:

```ts
export type PlaidItemDTO = {
  id: string;
  institutionName: string;
  status: PlaidItemStatus;
  errorCode: string | null;
  lastSyncAt: string | null;
  accountCount: number;
  connectedByUserId: string | null;
  connectedByName: string | null;
};
```

Then in `apps/api/src/routes/plaid-items.ts`, include user fields:

```ts
user: { select: { id: true, name: true, email: true } },
```

Return:

```ts
connectedByUserId: i.user?.id ?? null,
connectedByName: i.user?.name ?? i.user?.email ?? null,
```

- [ ] **Step 4: Update Banks UI types and display**

In the Banks page type, add:

```ts
connectedByUserId: string | null;
connectedByName: string | null;
```

The Banks list already imports `PlaidItemDTO` from `@fina/shared`; keep using the shared DTO and do not add a duplicate local response type.

In `connected-banks-list.tsx`, render under the institution name:

```tsx
{item.connectedByName && (
  <div className={styles.rowMeta}>Connected by {item.connectedByName}</div>
)}
```

For disconnected items, show them in the existing list with the `Disconnected` status badge. Do not show their stale balances as current values.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/plaid.routes.test.ts
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run apps/api/tests/accounts.routes.test.ts
pnpm typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add libs/shared/src/dto/plaid.ts apps/api/src/routes/accounts.ts apps/api/src/routes/plaid-items.ts apps/web/src/app/(app)/settings/banks/_components/connected-banks-list.tsx apps/web/src/app/(app)/settings/banks/page.tsx apps/api/tests/plaid.routes.test.ts apps/api/tests/accounts.routes.test.ts
git commit -m "feat: show plaid ownership and hide disconnected accounts"
```

## Task 8: Full Verification And Review

**Files:**
- Verify all changed files.
- No new source files in this task.

- [ ] **Step 1: Run targeted API tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec vitest run \
  apps/api/tests/plaid.tier.test.ts \
  apps/api/tests/billing-tier.test.ts \
  apps/api/tests/plaid.items.test.ts \
  apps/api/tests/plaid.reconcile.test.ts \
  apps/api/tests/plaid.routes.test.ts \
  apps/api/tests/plaid.exchange.test.ts \
  apps/api/tests/plaid.hosted-token.test.ts \
  apps/api/tests/cron.tier-gate.test.ts \
  apps/api/tests/billing-webhook.test.ts \
  apps/api/tests/billing-sync.test.ts \
  apps/api/tests/iap/billing-iap.routes.test.ts \
  apps/api/tests/iap/sync-sub.test.ts \
  apps/api/tests/iap/billing-iap-webhook.test.ts \
  apps/api/tests/cron.daily-refresh.test.ts \
  apps/api/tests/plaid.sync.test.ts \
  apps/api/tests/accounts.routes.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: Nx typecheck passes for all projects.

- [ ] **Step 3: Run production Docker build smoke**

Run:

```bash
docker build -f apps/api/Dockerfile.prod .
```

Expected: Docker image build completes.

- [ ] **Step 4: Review production safety checklist**

Confirm in code:

```text
1. No path selects Plaid Items by workspace owner trial state.
2. Link-token and exchange both enforce connectedBy user-wide count.
3. Exchange final check and create are serialized by user.
4. Stripe daily refresh uses status: "all".
5. Apple and Google IAP provider state is refreshed before Plaid reconciliation.
6. Billing disconnect archives bank accounts, keeps transactions, and uses the Plaid row lock.
7. Exchange cleanup failures persist a disconnected pending cleanup row for retry.
8. Lite users can sync their single kept Item.
9. Other members' Items are not disconnected during a user's downgrade.
10. Plaid ownership fields live in `libs/shared/src/dto/plaid.ts`.
```

- [ ] **Step 5: Confirm no uncommitted verification fixes remain**

Run:

```bash
git status --short
```

Expected: no output. Unexpected output means a previous task is incomplete; return to that task, fix and commit it there, then rerun this verification task from Step 1.

- [ ] **Step 6: Request final code review**

Use a subagent code review with:

```text
WHAT_WAS_IMPLEMENTED:
User-scoped Plaid reconciliation, Lite limit 1, user-wide connect enforcement,
billing hook reconciliation, daily provider refresh, Lite sync gates,
historical account hiding, and reconnect dedupe.

PLAN_OR_REQUIREMENTS:
docs/superpowers/specs/2026-06-01-user-plaid-reconciliation-design.md
docs/superpowers/plans/2026-06-01-user-plaid-reconciliation.md
```

Expected: no Critical or Important findings before production deploy.
