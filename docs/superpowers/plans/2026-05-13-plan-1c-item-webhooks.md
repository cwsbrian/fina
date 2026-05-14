# Plan 1C-item-webhooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Handle Plaid ITEM-type webhooks so `plaid_items.status` reflects real-world reconnect/disconnect/error states, and prevent retry-unprocessed from hammering disconnected items.

**Architecture:** New `webhook-item.ts` dispatcher (one file, one responsibility); small additions to the webhook route handler and retry-unprocessed cron job; a Prisma migration adds the `disconnected` enum value. All changes follow the existing "detached void, handler returns 200" pattern from 1B-webhooks.

**Tech Stack:** Prisma (schema + migration), Fastify (route), Vitest (tests), existing codebase patterns.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `apps/api/prisma/schema.prisma` | Add `disconnected` to `PlaidItemStatus` enum |
| Create | `apps/api/prisma/migrations/<ts>_add_plaid_item_status_disconnected/migration.sql` | SQL migration with `IF NOT EXISTS` |
| Create | `apps/api/src/plaid/webhook-item.ts` | `dispatchItemEvent(item, body)` — maps ITEM codes to status transitions |
| Modify | `apps/api/src/routes/plaid-webhook.ts` | Import `dispatchItemEvent`, add `status` to plaidItem select, add ITEM dispatch block |
| Modify | `apps/api/src/cron/jobs/retry-unprocessed.ts` | Add `disconnected` query filter + in-loop guard + `disconnected` counter |
| Create | `apps/api/tests/plaid.webhook.item.test.ts` | Unit tests for `dispatchItemEvent` |
| Modify | `apps/api/tests/plaid.webhook.routes.test.ts` | Integration tests for ITEM webhook route |
| Modify | `apps/api/tests/cron.retry-unprocessed.test.ts` | Test for disconnected-item skip |

---

## Task 1: Prisma migration — add `disconnected` status

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_plaid_item_status_disconnected/migration.sql`

- [ ] **Step 1: Edit schema.prisma**

In `apps/api/prisma/schema.prisma`, change the `PlaidItemStatus` enum (currently around line 188) from:

```prisma
enum PlaidItemStatus {
  active
  error
  relink_required
}
```

to:

```prisma
enum PlaidItemStatus {
  active
  error
  relink_required
  disconnected
}
```

- [ ] **Step 2: Generate migration (do not apply yet)**

```bash
pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_plaid_item_status_disconnected
```

Expected: Prisma creates `apps/api/prisma/migrations/<timestamp>_add_plaid_item_status_disconnected/migration.sql` without applying it.

- [ ] **Step 3: Hand-edit the generated migration.sql**

Open the file Prisma created. It will contain:

```sql
ALTER TYPE "PlaidItemStatus" ADD VALUE 'disconnected';
```

Change it to add `IF NOT EXISTS` (Prisma does not emit this automatically):

```sql
ALTER TYPE "PlaidItemStatus" ADD VALUE IF NOT EXISTS 'disconnected';
```

Save.

- [ ] **Step 4: Apply migration**

```bash
pnpm --filter @fina/api exec prisma migrate dev
```

Expected: `Applied 1 migration` (or: `Already in sync` if run again — the `IF NOT EXISTS` makes it idempotent).

- [ ] **Step 5: Verify enum in DB**

```bash
docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT unnest(enum_range(NULL::\"PlaidItemStatus\"));"
```

Expected output (4 lines):
```
active
error
relink_required
disconnected
```

- [ ] **Step 6: Regenerate Prisma client**

```bash
pnpm --filter @fina/api exec prisma generate
```

Expected: `Generated Prisma Client` — the TypeScript type for `PlaidItemStatus` now includes `"disconnected"`.

- [ ] **Step 7: Run full test suite (no regressions)**

```bash
pnpm nx run api:test
```

Expected: all existing tests pass (enum addition is backward-compatible; no existing code references `disconnected`).

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-item-webhooks): add 'disconnected' to PlaidItemStatus enum"
```

---

## Task 2: `webhook-item.ts` dispatcher (TDD)

**Files:**
- Create: `apps/api/src/plaid/webhook-item.ts`
- Create: `apps/api/tests/plaid.webhook.item.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/plaid.webhook.item.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { dispatchItemEvent } from "../src/plaid/webhook-item.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function seedItem(
  status: "active" | "error" | "relink_required" | "disconnected" = "active",
) {
  const ws = await prisma.workspace.create({ data: { name: "W" } });
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: ws.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `pi_${Math.random()}`,
      institutionId: "ins_1",
      institutionName: "Bank",
      status,
    },
  });
  return { itemId: item.id };
}

describe("dispatchItemEvent", () => {
  it("ERROR + error_code → status='error', errorCode set", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });

  it("ERROR without error_code → status='error', errorCode='unknown'", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "ERROR" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("unknown");
  });

  it("PENDING_EXPIRATION → status='relink_required', clears prior errorCode", async () => {
    const { itemId } = await seedItem("error");
    await prisma.plaidItem.update({ where: { id: itemId }, data: { errorCode: "SOME_ERROR" } });
    await dispatchItemEvent({ id: itemId }, { webhook_code: "PENDING_EXPIRATION" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("relink_required");
    expect(row.errorCode).toBeNull();
  });

  it("USER_PERMISSION_REVOKED → status='disconnected', clears errorCode", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "USER_PERMISSION_REVOKED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("disconnected");
    expect(row.errorCode).toBeNull();
  });

  it("WEBHOOK_UPDATE_ACKNOWLEDGED → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("unknown future code → row unchanged", async () => {
    const { itemId } = await seedItem();
    await dispatchItemEvent({ id: itemId }, { webhook_code: "NEW_PRODUCT_ADDED" });
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("active");
  });

  it("last-write-wins: ERROR overrides disconnected status", async () => {
    const { itemId } = await seedItem("disconnected");
    await dispatchItemEvent(
      { id: itemId },
      { webhook_code: "ERROR", error: { error_code: "ITEM_LOGIN_REQUIRED" } },
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(row.status).toBe("error");
    expect(row.errorCode).toBe("ITEM_LOGIN_REQUIRED");
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.webhook.item.test.ts --reporter=verbose
```

Expected: fails — `Cannot find module '../src/plaid/webhook-item.js'`.

- [ ] **Step 3: Create `apps/api/src/plaid/webhook-item.ts`**

```ts
import { prisma } from "../db.js";

type ItemBody = {
  webhook_code: string;
  error?: { error_code?: string | null } | null;
};

/**
 * Dispatcher for Plaid ITEM-type webhooks. Updates plaid_items.status to
 * reflect real-world reconnect/disconnect/error state. Never throws — caller
 * uses void + .catch() so the webhook handler always returns 200.
 *
 * Unhandled codes (WEBHOOK_UPDATE_ACKNOWLEDGED, future codes) are logged and
 * ignored — no DB write.
 */
export async function dispatchItemEvent(
  item: { id: string },
  body: ItemBody,
): Promise<void> {
  switch (body.webhook_code) {
    case "ERROR":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: {
          status: "error",
          errorCode: body.error?.error_code ?? "unknown",
        },
      });
      break;
    case "PENDING_EXPIRATION":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "relink_required", errorCode: null },
      });
      break;
    case "USER_PERMISSION_REVOKED":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "disconnected", errorCode: null },
      });
      break;
    default:
      console.info("ITEM webhook ignored", { itemId: item.id, code: body.webhook_code });
  }
}
```

- [ ] **Step 4: Run test — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.webhook.item.test.ts --reporter=verbose
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/plaid/webhook-item.ts apps/api/tests/plaid.webhook.item.test.ts
git commit -m "feat(plan 1c-item-webhooks): dispatchItemEvent — ITEM webhook status dispatcher"
```

---

## Task 3: Route handler — add ITEM dispatch

**Files:**
- Modify: `apps/api/src/routes/plaid-webhook.ts`
- Modify: `apps/api/tests/plaid.webhook.routes.test.ts`

- [ ] **Step 1: Update the stale existing ITEM test, then add new failing integration tests**

In `apps/api/tests/plaid.webhook.routes.test.ts`, find the existing test at approximately line 149 (`"webhookType ITEM → 200, row stored, no dispatch"`). After Task 3, `dispatchItemEvent` fires in the background for known items, making "no dispatch" misleading. Rename it:

```ts
// Before:
it("webhookType ITEM → 200, row stored, no dispatch", async () => {
// After:
it("webhookType ITEM/ITEM_ERROR → 200, row stored, TRANSACTIONS dispatch not called", async () => {
```

(The three assertions in the test body remain unchanged and still pass.)

Then add these 3 new tests at the end of the `describe("POST /plaid/webhook")` block (before the final closing `}`):

```ts
  it("ITEM/ERROR for known item → 200, status='error', event row stored", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: pi.itemId,
      error: { error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR", error_message: "login required" },
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);

    // Poll until the detached dispatchItemEvent writes status (up to 500ms).
    // The dispatch is a single local DB write — 500ms is very conservative.
    let updatedItem = await prisma.plaidItem.findUniqueOrThrow({ where: { id: pi.id } });
    for (let i = 0; i < 10 && updatedItem.status === "active"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      updatedItem = await prisma.plaidItem.findUniqueOrThrow({ where: { id: pi.id } });
    }

    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].webhookType).toBe("ITEM");
    expect(rows[0].plaidItemId).toBe(pi.id);

    // updatedItem already fetched by the polling loop above.
    expect(updatedItem.status).toBe("error");
    expect(updatedItem.errorCode).toBe("ITEM_LOGIN_REQUIRED");

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    await app.close();
  });

  it("ITEM/ERROR for unknown item → 200, event row with plaidItemId=null, no item write", async () => {
    const app = await buildApp(env);
    const body = {
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: "p_does_not_exist",
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBeNull();
    // No plaid_items rows — nothing to update.
    expect(await prisma.plaidItem.count()).toBe(0);
    await app.close();
  });

  it("ITEM/WEBHOOK_UPDATE_ACKNOWLEDGED for known item → 200, event row stored, status unchanged", async () => {
    const app = await buildApp(env);
    const { pi } = await seedItem();
    const body = {
      webhook_type: "ITEM",
      webhook_code: "WEBHOOK_UPDATE_ACKNOWLEDGED",
      item_id: pi.itemId,
    };
    const jwt = await signWebhook(Buffer.from(JSON.stringify(body)), keys.privateKey, keys.kid);

    const res = await postWebhook(app, body, jwt);

    expect(res.statusCode).toBe(200);
    // ACK events are no-ops — status stays active. Brief poll to ensure the
    // detached dispatch (which logs + exits) has settled before asserting.
    await new Promise((r) => setTimeout(r, 100));
    const rows = await prisma.plaidWebhookEvent.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].plaidItemId).toBe(pi.id);
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: pi.id } });
    expect(item.status).toBe("active"); // unchanged — ACK is a no-op
    await app.close();
  });
```

- [ ] **Step 2: Run failing tests**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.webhook.routes.test.ts --reporter=verbose
```

Expected: the 3 new ITEM tests fail (ITEM webhooks currently hit the `else` "not dispatched" path, so status is never updated and no `dispatchItemEvent` is called).

- [ ] **Step 3: Modify `apps/api/src/routes/plaid-webhook.ts`**

Make 3 changes:

**a) Add import** at the top (after existing imports):

```ts
import { dispatchItemEvent } from "../plaid/webhook-item.js";
```

**b) Add `status` to the plaidItem select** (around line 44):

Change:
```ts
    const item = await prisma.plaidItem.findUnique({
      where: { itemId: parsed.item_id },
      select: { id: true, workspaceId: true },
    });
```
To:
```ts
    const item = await prisma.plaidItem.findUnique({
      where: { itemId: parsed.item_id },
      select: { id: true, workspaceId: true, status: true },
    });
```

**c) Restructure the `isSyncRelevant` block into an `else if` chain** — this prevents ITEM events from double-logging "webhook received but not dispatched" before dispatching. Replace the existing `if (isSyncRelevant) { ... } else { app.log.info(...) }` block with:

```ts
    const isItemRelevant = parsed.webhook_type === "ITEM" && item !== null;
    if (isSyncRelevant) {
      void dispatchWebhookSync(app.fina.env, item.workspaceId, item.id, event.id).catch(() => {});
    } else if (isItemRelevant) {
      void dispatchItemEvent(
        item,
        parsed as { webhook_code: string; error?: { error_code?: string | null } | null },
      ).catch((e) => {
        app.log.error({ err: e, itemId: parsed.item_id }, "ITEM webhook dispatch failed");
      });
    } else {
      app.log.info(
        { webhookType: parsed.webhook_type, webhookCode: parsed.webhook_code, itemId: parsed.item_id },
        "webhook received but not dispatched",
      );
    }
```

Define `isItemRelevant` immediately before the `isSyncRelevant` constant (or right above the chain) so it's in scope.

- [ ] **Step 4: Run tests — expect all green**

```bash
cd apps/api && pnpm exec vitest run tests/plaid.webhook.routes.test.ts --reporter=verbose
```

Expected: all route tests pass (including the 3 new ITEM tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/plaid-webhook.ts apps/api/tests/plaid.webhook.routes.test.ts
git commit -m "feat(plan 1c-item-webhooks): route handler dispatches ITEM webhooks"
```

---

## Task 4: retry-unprocessed — disconnected filter + counter

**Files:**
- Modify: `apps/api/src/cron/jobs/retry-unprocessed.ts`
- Modify: `apps/api/tests/cron.retry-unprocessed.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test at the end of the `describe("runRetryUnprocessed")` block in `apps/api/tests/cron.retry-unprocessed.test.ts` (before the final `}`):

```ts
  it("disconnected item: excluded from query, processedAt stays NULL (TTL will sweep it)", async () => {
    // The query filter `plaidItem: { is: { status: { not: "disconnected" } } }` prevents
    // disconnected items' events from ever entering the retry loop. processedAt stays NULL
    // and cleanup-events will sweep the row at TTL. dispatchWebhookSync must not be called.
    const ws = await prisma.workspace.create({ data: { name: "W-disc" } });
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: ws.id,
        accessTokenCiphertext: Buffer.from([1]),
        accessTokenIv: Buffer.from([2]),
        itemId: `pi_disc_${Math.random()}`,
        institutionId: "ins_disc",
        institutionName: "Disc Bank",
        status: "disconnected",
      },
    });
    const ev = await prisma.plaidWebhookEvent.create({
      data: {
        plaidItemId: item.id,
        webhookType: "TRANSACTIONS",
        webhookCode: "SYNC_UPDATES_AVAILABLE",
        body: {},
        receivedAt: new Date(Date.now() - 5 * 60_000),
      },
    });

    await runRetryUnprocessed(env);

    expect(dispatchWebhookSync).not.toHaveBeenCalled();
    const row = await prisma.plaidWebhookEvent.findUniqueOrThrow({ where: { id: ev.id } });
    // processedAt stays NULL — the query filter excluded this event. TTL will clean it up.
    expect(row.processedAt).toBeNull();
  });
```

- [ ] **Step 2: Run test — expect failure**

```bash
pnpm exec vitest run tests/cron.retry-unprocessed.test.ts --reporter=verbose
```

Expected: the new test fails — `dispatchWebhookSync` is called (because disconnected filter doesn't exist yet), or `processError` is not `"item_disconnected"`.

- [ ] **Step 3: Modify `apps/api/src/cron/jobs/retry-unprocessed.ts`**

Apply 4 targeted changes:

**a) Add `disconnected` query filter + `status` to select** (replace the existing `where` + `include`):

```ts
  const events = await prisma.plaidWebhookEvent.findMany({
    where: {
      processedAt: null,
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      plaidItemId: { not: null },
      receivedAt: { gte: cutoff },
      plaidItem: { is: { status: { not: "disconnected" } } },
    },
    include: { plaidItem: { select: { id: true, workspaceId: true, connectedBy: true, status: true } } },
    take: 50,
    orderBy: { receivedAt: "asc" },
  });
```

**b) Add `disconnected` counter** (replace `let attempted = 0, gated = 0;`):

```ts
  let attempted = 0, gated = 0, disconnected = 0;
```

**c) Add in-loop disconnected guard** (insert after `const item = ev.plaidItem;` and before the `if (item.connectedBy)` block):

```ts
    if (item.status === "disconnected") {
      // Race: status flipped to disconnected between findMany and this loop iteration.
      // Stamp the row so it doesn't reappear, without calling sync.
      await prisma.plaidWebhookEvent.update({
        where: { id: ev.id },
        data: { processedAt: new Date(), processError: "item_disconnected" },
      });
      disconnected++;
      continue;
    }
```

**d) Add `disconnected` to the summary log** (replace the `console.info` at the end):

```ts
  console.info("retry-unprocessed complete", { found: events.length, attempted, gated, disconnected });
```

- [ ] **Step 4: Run tests — expect all green**

```bash
pnpm exec vitest run tests/cron.retry-unprocessed.test.ts --reporter=verbose
```

Expected: all 10 tests pass (9 existing + 1 new).

- [ ] **Step 5: Run full test suite**

```bash
pnpm nx run api:test
```

Expected: all tests pass (≥ 261 + 11 new = ≥ 272; 7 from Task 2 + 3 from Task 3 + 1 from Task 4).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/cron/jobs/retry-unprocessed.ts apps/api/tests/cron.retry-unprocessed.test.ts
git commit -m "feat(plan 1c-item-webhooks): retry-unprocessed skips disconnected items, adds 'disconnected' counter"
```

---

## Progress Tracker

| Task | Status |
|---|---|
| 1 — Prisma migration (disconnected enum) | ⬜ |
| 2 — webhook-item.ts dispatcher | ⬜ |
| 3 — Route handler ITEM dispatch | ⬜ |
| 4 — retry-unprocessed disconnected filter | ⬜ |
