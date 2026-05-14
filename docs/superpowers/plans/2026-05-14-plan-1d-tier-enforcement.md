# Plan 1D-tier-enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Plaid connection limits per tier (Free=0, Lite=2, Pro=5) at the exchange endpoint, and auto-remove expired-trial users' Plaid items during daily-refresh to stop billing.

**Architecture:** Extend `EffectiveTier` with `plaidItemLimit`, replace `requireProTier` in the Plaid routes with a count-based helper, add `removeItemForBilling` (soft disconnect preserving data), and prepend a cleanup step to `runDailyRefresh` that removes active items for expired-trial workspace owners.

**Tech Stack:** Prisma (DB queries + schema), Fastify (routes), Vitest (tests), existing `effectiveTier`, `plaidClient`, `sanitizePlaidError` from codebase.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `libs/shared/src/tier.ts` | Add `plaidItemLimit: number` to `EffectiveTier` type |
| Modify | `apps/api/src/auth/tier.ts` | Return `plaidItemLimit` in `computeEffectiveTier` |
| Modify | `apps/api/src/routes/plaid.ts` | Replace `requireProTier` with `checkPlaidItemLimit`; add `effectiveTier` + `prisma` imports |
| Modify | `apps/api/src/plaid/items.ts` | Add `removeItemForBilling` function |
| Modify | `apps/api/src/cron/jobs/daily-refresh.ts` | Prepend Step 0 that calls `removeItemForBilling` for expired-trial items |
| Modify | `apps/api/tests/plaid.tier.test.ts` | Add `plaidItemLimit` tests for `computeEffectiveTier` |
| Modify | `apps/api/tests/plaid.routes.test.ts` | Add limit-check integration tests |
| Modify | `apps/api/tests/plaid.items.test.ts` | Add `removeItemForBilling` unit tests |
| Modify | `apps/api/tests/cron.daily-refresh.test.ts` | Add Step 0 unit tests |

---

## Task 1: EffectiveTier type + computeEffectiveTier

**Files:**
- Modify: `libs/shared/src/tier.ts`
- Modify: `apps/api/src/auth/tier.ts`
- Modify: `apps/api/tests/plaid.tier.test.ts`

- [ ] **Step 1: Write the failing tests**

Add at the end of `apps/api/tests/plaid.tier.test.ts`, inside a new `describe` block after the existing ones:

```ts
import { computeEffectiveTier } from "../src/auth/tier.js";

describe("computeEffectiveTier — plaidItemLimit", () => {
  it("active trial → plaidItemLimit: 5", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() + 86_400_000) });
    expect(t.plaidItemLimit).toBe(5);
  });

  it("expired trial → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() - 1_000) });
    expect(t.plaidItemLimit).toBe(0);
  });

  it("no trial (null) → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: null });
    expect(t.plaidItemLimit).toBe(0);
  });
});
```

Note: `computeEffectiveTier` is already exported — check the existing import at the top of `plaid.tier.test.ts` and add it if missing.

- [ ] **Step 2: Run test — expect failure**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.tier.test.ts --reporter=verbose
```

Expected: fails — `t.plaidItemLimit is undefined`.

- [ ] **Step 3: Update `libs/shared/src/tier.ts`**

Add `plaidItemLimit: number` to `EffectiveTier`:

```ts
export type EffectiveTier = {
  tier: Tier;
  source: "trial" | "paid" | "default";
  trialActive: boolean;
  trialEndsAt: Date | null;
  plaidItemLimit: number;  // 0 = no Plaid (Free), 2 = Lite, 5 = Pro
};
```

- [ ] **Step 4: Update `apps/api/src/auth/tier.ts`**

In `computeEffectiveTier`, add `plaidItemLimit` to both return paths:

```ts
export function computeEffectiveTier(user: {
  trialEndsAt: Date | null;
}): EffectiveTier {
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: 5,
    };
  }
  // Future: check paid subscription column here → "lite" (2) or "pro" (5).
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: 0,
  };
}
```

- [ ] **Step 5: Run test — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.tier.test.ts --reporter=verbose
```

Expected: all tests pass (existing + 3 new).

- [ ] **Step 6: Run full suite — no TypeScript regressions**

```bash
pnpm nx run api:test
```

Expected: all existing tests pass. (Adding `plaidItemLimit` to `EffectiveTier` may surface TypeScript errors in callers that destructure `EffectiveTier` — fix any that appear by adding `plaidItemLimit` where needed.)

- [ ] **Step 7: Commit**

```bash
git add libs/shared/src/tier.ts apps/api/src/auth/tier.ts apps/api/tests/plaid.tier.test.ts
git commit -m "feat(plan 1d-tier-enforcement): add plaidItemLimit to EffectiveTier (Free=0, Lite=2, Pro=5)"
```

---

## Task 2: Exchange/link-token limit check

**Files:**
- Modify: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Add a new `describe` block at the end of `apps/api/tests/plaid.routes.test.ts`:

```ts
describe("Plaid connection limits", () => {
  it("Free user (expired trial) → POST /link-token → 402 upgrade_required", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Expire the trial.
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1_000), trialConsumed: true },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("Free user → POST /exchange → 402 upgrade_required", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "free2@x.com", name: "Free2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1_000), trialConsumed: true },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "Bank" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("Pro user below limit → POST /link-token → 200", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // No items connected — 0/5, well below limit.

    plaidMock.linkTokenCreate.push({ data: { link_token: "lt_ok", expiration: "2099-01-01" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("Pro user at limit (5 items) → POST /exchange → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit@x.com", name: "AtLimit" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Seed 5 active items directly (bypassing exchange) to hit the limit.
    for (let i = 0; i < 5; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_limit_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p6", institutionId: "ins_1", institutionName: "Bank6" }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    await app.close();
  });

  it("Pro user at limit (5 items) → POST /link-token → 402 plaid_item_limit_reached", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "atlimit2@x.com", name: "AtLimit2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    for (let i = 0; i < 5; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_lt_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("plaid_item_limit_reached");
    await app.close();
  });

  it("Disconnected items don't count toward limit → exchange allowed", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "disc@x.com", name: "Disc" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // 3 active + 2 disconnected = 3 effective, below limit of 5.
    for (let i = 0; i < 3; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_active_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "active",
        },
      });
    }
    for (let i = 0; i < 2; i++) {
      await prisma.plaidItem.create({
        data: {
          workspaceId: wsId,
          accessTokenCiphertext: Buffer.from([1]),
          accessTokenIv: Buffer.from(new Array(12).fill(2)),
          itemId: `item_disc_${i}`,
          institutionId: "ins_1",
          institutionName: "Bank",
          status: "disconnected",
        },
      });
    }

    // Exchange should succeed (only 3 active, limit is 5).
    await connectAItem(app, owner, wsId, "_new");

    const count = await prisma.plaidItem.count({ where: { workspaceId: wsId, status: "active" } });
    expect(count).toBe(4); // 3 seeded + 1 just connected
    await app.close();
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.routes.test.ts --reporter=verbose
```

Expected: the new 6 tests fail (402 not returned where expected; limit check doesn't exist yet).

- [ ] **Step 3: Update `apps/api/src/routes/plaid.ts`**

Make 3 changes:

**a) Add imports** (after existing imports):
```ts
import { effectiveTier } from "../auth/tier.js";
```

(Remove `requireProTier` from the existing import of `"../auth/tier.js"` — or keep it if used elsewhere, but it's only used in this file.)

**b) Add the `checkPlaidItemLimit` helper** (before the `plaidRoutes` function):

```ts
async function checkPlaidItemLimit(
  userId: string,
  workspaceId: string,
): Promise<{ error: string } | null> {
  const t = await effectiveTier(userId);
  if (t.plaidItemLimit === 0) return { error: "upgrade_required" };

  const count = await prisma.plaidItem.count({
    where: { workspaceId, status: { not: "disconnected" } },
  });
  if (count >= t.plaidItemLimit) return { error: "plaid_item_limit_reached" };
  return null;
}
```

**c) Replace `requireProTier` calls in both endpoints**:

In `/workspaces/:id/plaid/link-token`:
```ts
// Replace:
await requireProTier(ctx.session.userId);
// With:
const limitErr = await checkPlaidItemLimit(ctx.session.userId, params.id);
if (limitErr) return reply.code(402).send(limitErr);
```

In `/workspaces/:id/plaid/exchange`:
```ts
// Replace:
await requireProTier(ctx.session.userId);
// With:
const limitErr = await checkPlaidItemLimit(ctx.session.userId, verifiedWsId);
if (limitErr) return reply.code(402).send(limitErr);
```

Note: in the exchange endpoint, use `verifiedWsId` (the ctx-verified value, already assigned above the limit check).

- [ ] **Step 4: Run tests — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.routes.test.ts --reporter=verbose
```

Expected: all tests pass (existing + 6 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plaid.ts apps/api/tests/plaid.routes.test.ts
git commit -m "feat(plan 1d-tier-enforcement): exchange/link-token limit check (Free=402, limit-reached=402)"
```

---

## Task 3: `removeItemForBilling`

**Files:**
- Modify: `apps/api/src/plaid/items.ts`
- Modify: `apps/api/tests/plaid.items.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block at the end of `apps/api/tests/plaid.items.test.ts`:

```ts
import { removeItemForBilling } from "../src/plaid/items.js";

describe("removeItemForBilling", () => {
  async function seedItemWithTransactions() {
    const ws = await prisma.workspace.create({ data: { name: "W-billing" } });
    // storeAccessToken encrypts and creates the plaid_items row.
    const app = await buildApp(env);
    const itemRowId = await storeAccessToken(env, prisma, {
      workspaceId: ws.id,
      itemId: `pi_bill_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      accessToken: "access-sandbox-test-billing",
    });
    // Seed a transaction so we can verify it survives.
    const account = await prisma.bankAccount.create({
      data: {
        workspaceId: ws.id,
        plaidItemId: itemRowId,
        plaidAccountId: "acct_bill",
        name: "Checking",
        type: "depository",
        currency: "CAD",
      },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        bankAccountId: account.id,
        amount: 10,
        currency: "CAD",
        merchantRaw: "Test",
        merchantNormalized: "Test",
        occurredAt: new Date(),
        pending: false,
        source: "plaid",
      },
    });
    return { wsId: ws.id, itemRowId, accountId: account.id };
  }

  it("normal path: Plaid /item/remove → status='disconnected', row + transactions preserved", async () => {
    const { wsId, itemRowId, accountId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    await removeItemForBilling(env, wsId, itemRowId);

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("disconnected");
    expect(item.errorCode).toBeNull();

    // Row preserved (not deleted).
    expect(item.id).toBe(itemRowId);

    // Transactions preserved.
    const txCount = await prisma.transaction.count({ where: { bankAccountId: accountId } });
    expect(txCount).toBe(1);
  });

  it("ITEM_NOT_FOUND: graceful — Plaid already removed, still sets disconnected", async () => {
    const { wsId, itemRowId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));

    await removeItemForBilling(env, wsId, itemRowId);

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("disconnected");
  });

  it("other Plaid error: propagates (caller catches and continues)", async () => {
    const { wsId, itemRowId } = await seedItemWithTransactions();

    plaidMock.itemRemove.push(plaidApiError({ error_code: "PLAID_UNAVAILABLE", http_status: 503 }));

    await expect(removeItemForBilling(env, wsId, itemRowId)).rejects.toThrow();

    // Status NOT changed — item still active (cron retries tomorrow).
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemRowId } });
    expect(item.status).toBe("active");
  });
});
```

`plaidMock.itemRemove` is already defined in `tests/helpers/plaid-mock.ts` — no changes needed to the mock helper. The `removeItemForBilling` import should be added to the existing import line in `plaid.items.test.ts` that imports `storeAccessToken` and `removeItemStrict`.

- [ ] **Step 2: Run failing tests**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.items.test.ts --reporter=verbose
```

Expected: fails — `removeItemForBilling` not found.

- [ ] **Step 3: Add `removeItemForBilling` to `apps/api/src/plaid/items.ts`**

Add after `removeItemStrict` (keep existing function unchanged):

```ts
/**
 * Billing-side disconnect: calls Plaid /item/remove to stop recurring charges
 * (~$0.25 CAD/item/month), then sets status='disconnected' locally.
 *
 * Unlike removeItemStrict, this preserves the plaid_items row and all
 * associated bank_accounts and transactions — data is kept for historical
 * reference and potential re-subscription.
 *
 * No advisory lock: this runs from a cron job (daily-refresh Step 0) where
 * the item is not being synced concurrently (tier-gated users are skipped in
 * the sync loop, and the sync loop runs AFTER Step 0).
 *
 * Partial-failure retry: if the Plaid call succeeds but the DB update fails,
 * the item stays 'active'. Tomorrow's Step 0 retries, Plaid returns
 * ITEM_NOT_FOUND, the catch falls through, and the DB update succeeds.
 */
export async function removeItemForBilling(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<void> {
  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);

  try {
    await plaidClient(env).itemRemove({ access_token: accessToken });
  } catch (e) {
    if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
      // Already removed on Plaid's side — proceed with local status update.
    } else {
      throw e; // caller logs and continues to next item
    }
  }

  await prisma.plaidItem.update({
    where: { id: plaidItemId },
    data: { status: "disconnected", errorCode: null },
  });
}
```

- [ ] **Step 4: Run tests — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.items.test.ts --reporter=verbose
```

Expected: all tests pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plaid/items.ts apps/api/tests/plaid.items.test.ts
git commit -m "feat(plan 1d-tier-enforcement): removeItemForBilling — soft disconnect for billing cleanup"
```

---

## Task 4: Daily-refresh Step 0 — trial expiry cleanup

**Files:**
- Modify: `apps/api/src/cron/jobs/daily-refresh.ts`
- Modify: `apps/api/tests/cron.daily-refresh.test.ts`

- [ ] **Step 1: Write the failing tests**

Add mock and new test cases to `apps/api/tests/cron.daily-refresh.test.ts`.

First, add the mock at the top of the file (after existing vi.mock calls):

```ts
vi.mock("../src/plaid/items.js", () => ({
  removeItemForBilling: vi.fn().mockResolvedValue(undefined),
}));
import { removeItemForBilling } from "../src/plaid/items.js";
```

Add to `beforeEach` (after existing mock resets):

```ts
vi.mocked(removeItemForBilling).mockReset();
vi.mocked(removeItemForBilling).mockResolvedValue(undefined);
```

Then add a new `describe` block at the end:

```ts
describe("runDailyRefresh — Step 0 trial expiry cleanup", () => {
  async function seedWorkspaceWithOwner(trialEndsAt: Date | null) {
    const { randomUUID } = await import("crypto");
    const userId = randomUUID();
    await prisma.user.create({
      data: {
        id: userId,
        name: "Test Owner",
        email: `owner-${userId.slice(0, 8)}@x.com`,
        emailVerified: true,
        trialEndsAt,
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "WS" } });
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role: "owner" },
    });
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: ws.id,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from(new Array(12).fill(2)),
        itemId: `pi_step0_${Math.random()}`,
        institutionId: "ins_1",
        institutionName: "Bank",
        status: "active",
      },
    });
    return { wsId: ws.id, itemId: item.id };
  }

  it("expired-trial owner's active item → removeItemForBilling called", async () => {
    const { itemId } = await seedWorkspaceWithOwner(new Date(Date.now() - 86_400_000));

    await runDailyRefresh(env);

    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), itemId);
  });

  it("active-trial owner's item → NOT removed", async () => {
    await seedWorkspaceWithOwner(new Date(Date.now() + 86_400_000));

    await runDailyRefresh(env);

    expect(removeItemForBilling).not.toHaveBeenCalled();
  });

  it("removeItemForBilling throws → other items still synced (non-fatal)", async () => {
    vi.mocked(removeItemForBilling).mockRejectedValueOnce(new Error("plaid down"));
    const { itemId: expiredItemId } = await seedWorkspaceWithOwner(new Date(Date.now() - 86_400_000));

    // Also seed an active-trial item that should still sync.
    const { itemId: activeItemId } = await seedWorkspaceWithOwner(new Date(Date.now() + 86_400_000));
    vi.mocked(syncTransactions).mockResolvedValue({ added: 0, modified: 0, removed: 0, newTxIds: [] });

    await runDailyRefresh(env);

    // removeItemForBilling was attempted for the expired item.
    expect(removeItemForBilling).toHaveBeenCalledWith(env, expect.any(String), expiredItemId);
    // syncTransactions was still called for the active item.
    expect(syncTransactions).toHaveBeenCalled();
    void activeItemId;
  });
});
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/api && pnpm exec vitest run tests/cron.daily-refresh.test.ts --reporter=verbose
```

Expected: the 3 new Step 0 tests fail — `removeItemForBilling` is not called yet.

- [ ] **Step 3: Update `apps/api/src/cron/jobs/daily-refresh.ts`**

Add the import and prepend Step 0:

```ts
import { prisma } from "../../db.js";
import type { Env } from "../../env.js";
import { syncTransactions } from "../../plaid/sync.js";
import { categorizeNewTransactions } from "../../categorize/service.js";
import { sanitizePlaidError } from "../../plaid/client.js";
import { checkBackgroundSyncGate } from "../tier-gate.js";
import { removeItemForBilling } from "../../plaid/items.js";   // NEW

export async function runDailyRefresh(env: Env): Promise<void> {
  // ── Step 0: remove active items for expired-trial workspace owners ──────
  // Plaid charges ~$0.25/item/month even with no API calls. Removing on expiry
  // stops billing immediately. Data (transactions, accounts) is preserved.
  const expiredItems = await prisma.plaidItem.findMany({
    where: {
      status: "active",
      workspace: {
        memberships: {
          some: {
            role: "owner",
            user: { trialEndsAt: { lt: new Date() } },
          },
        },
      },
    },
    select: { id: true, workspaceId: true },
  });

  let billingRemoved = 0;
  for (const item of expiredItems) {
    try {
      await removeItemForBilling(env, item.workspaceId, item.id);
      billingRemoved++;
    } catch (e) {
      console.error("daily-refresh: billing-remove failed", {
        itemId: item.id,
        err: sanitizePlaidError(e),
      });
      // Non-fatal: cron retries tomorrow. Plaid will return ITEM_NOT_FOUND
      // if the token was already removed, and removeItemForBilling handles that.
    }
  }
  if (expiredItems.length > 0) {
    console.info("daily-refresh: trial expiry cleanup", {
      found: expiredItems.length,
      removed: billingRemoved,
    });
  }
  // ── existing active-items sync loop (fresh query — Step 0's disconnected
  //    items are excluded by status:'active' filter below) ─────────────────

  const items = await prisma.plaidItem.findMany({
    where: { status: "active" },
    select: { id: true, workspaceId: true, connectedBy: true },
  });

  const t0 = Date.now();
  let synced = 0, gated = 0, failed = 0, lockHeld = 0;

  for (const item of items) {
    if (item.connectedBy) {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) { gated++; continue; }
    } else {
      console.warn("daily-refresh: connectedBy null, skipping tier gate", { itemId: item.id });
    }

    try {
      const r = await syncTransactions(env, item.workspaceId, item.id);
      if ("skipped" in r && r.skipped === "lock_held") {
        lockHeld++;
      } else {
        synced++;
      }
      if ("newTxIds" in r && r.newTxIds.length > 0) {
        await categorizeNewTransactions(env, item.workspaceId, r.newTxIds).catch((e) =>
          console.error("categorize after daily-refresh failed", { itemId: item.id, err: e }),
        );
      }
    } catch (e) {
      failed++;
      console.error("daily-refresh sync failed", { itemId: item.id, err: sanitizePlaidError(e) });
    }
  }

  console.info("daily-refresh complete", {
    durationMs: Date.now() - t0,
    itemsTotal: items.length, synced, gated, lockHeld, failed,
  });
}
```

- [ ] **Step 4: Run tests — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/cron.daily-refresh.test.ts --reporter=verbose
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
pnpm nx run api:test
```

Expected: all tests pass (≥ 273 + new tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cron/jobs/daily-refresh.ts apps/api/tests/cron.daily-refresh.test.ts
git commit -m "feat(plan 1d-tier-enforcement): daily-refresh Step 0 — remove expired-trial items for billing"
```

---

## Progress Tracker

| Task | Status |
|---|---|
| 1 — EffectiveTier + plaidItemLimit | ⬜ |
| 2 — Exchange/link-token limit check | ⬜ |
| 3 — removeItemForBilling | ⬜ |
| 4 — Daily-refresh Step 0 | ⬜ |
