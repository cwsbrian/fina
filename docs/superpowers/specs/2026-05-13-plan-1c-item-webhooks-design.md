# Plan 1C-item-webhooks — ITEM webhook handling (design)

**Date:** 2026-05-13
**Builds on:** Plan 1B-webhooks (TRANSACTIONS only), Plan 1B-cron (daily-refresh skips non-active items)
**Status:** design / pre-implementation

---

## 1. Goal

Process Plaid `ITEM` type webhooks so `plaid_items.status` reflects real-world reconnect / disconnect / error states. Mobile UI then polls status and shows the correct badge ("재연결 필요", "연결 끊김", "에러"). No push notifications in this plan — mobile polling only.

## 2. Scope

### In

- New `disconnected` value on the `PlaidItemStatus` enum (DB migration).
- A small dispatcher (`apps/api/src/plaid/webhook-item.ts`) that maps 4 ITEM webhook codes to status transitions.
- Webhook handler change to call the dispatcher when `webhook_type === "ITEM"`.
- Unit tests covering each code + the unknown-code / unknown-item paths.

### Out

- Push notifications on status change. Owned by Plan 1E-morning-ritual when push infrastructure lands.
- UI badges and reconnect flows. Owned by the mobile app.
- Auto-cleanup of disconnected items (orphan accounts/transactions stay; user can hide via UI later).
- `WEBHOOK_UPDATE_ACKNOWLEDGED` reaction beyond a debug log — Plaid's own ACK, no action needed.

## 3. Data Model

One enum addition. No new tables.

**How:** edit `apps/api/prisma/schema.prisma` to add `disconnected` to `PlaidItemStatus`, then run `prisma migrate dev --create-only --name add_plaid_item_status_disconnected`. Prisma generates the migration SQL but does NOT apply it yet. Hand-edit the generated file to add `IF NOT EXISTS` (Prisma does not emit this automatically), then run `prisma migrate deploy` (or let `prisma migrate dev` pick it up on the next run). The resulting SQL:

```sql
-- prisma/migrations/<timestamp>_add_plaid_item_status_disconnected/migration.sql
ALTER TYPE "PlaidItemStatus" ADD VALUE IF NOT EXISTS 'disconnected';
```

Postgres 16 (current dev) supports `ALTER TYPE ADD VALUE` inside a transaction, so Prisma's wrapping is fine. If we ever target PG ≤ 11 the migration would need `--create-only` + manual edit to run outside a transaction; not a concern today but worth noting.

Resulting enum: `active | error | relink_required | disconnected`.

Semantic distinction:
- `error` — Plaid SDK error during sync or item-error webhook (something broke; may be transient).
- `relink_required` — Plaid signaled token expiry / MFA re-auth needed; same item can be relinked.
- `disconnected` — User revoked access at the bank or in their bank's app; new Plaid Link required.

**Recovery:** `errorCode` is cleared (and `status` set back to `active`) only by a successful sync — this lives in `sync.ts` (existing behavior, not changed by this plan). The dispatcher only transitions in the unhappy direction.

## 4. Architecture

### 4.1 New file

```
apps/api/src/plaid/webhook-item.ts   # dispatchItemEvent(item, body) → updates plaid_items
```

Public signature:

```ts
export async function dispatchItemEvent(
  item: { id: string },
  body: { webhook_code: string; error?: { error_code?: string } | null },
): Promise<void>;
```

### 4.2 Code → status mapping

```ts
switch (body.webhook_code) {
  case "ERROR":
    await prisma.plaidItem.update({
      where: { id: item.id },
      data: { status: "error", errorCode: body.error?.error_code ?? "unknown" },
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
    // WEBHOOK_UPDATE_ACKNOWLEDGED + any future codes — log only.
    console.info("ITEM webhook ignored", { itemId: item.id, code: body.webhook_code });
}
```

The function is intentionally minimal: read the code, write the status. No transactions, no other tables.

### 4.3 Webhook handler change

In `apps/api/src/routes/plaid-webhook.ts`, after the existing `isSyncRelevant` block:

```ts
const isItemRelevant =
  parsed.webhook_type === "ITEM" && item !== null;

if (isItemRelevant) {
  void dispatchItemEvent(item, parsed as ItemBody).catch((e) => {
    app.log.error({ err: e, itemId: parsed.item_id }, "ITEM webhook dispatch failed");
  });
}
```

The handler dispatches **all** ITEM webhooks for known items; the dispatcher's `switch` decides which codes act vs no-op. This avoids double filtering — the allow-list lives in one place (the dispatcher). The handler still returns `200` immediately (Plaid retries on non-2xx). Dispatch is detached.

## 5. Concurrency

`dispatchItemEvent` is a single `prisma.update` — atomic. No advisory lock needed. If two ITEM webhooks for the same item arrive simultaneously, last-write-wins is acceptable: status flips reflect the latest signal from Plaid.

The dispatcher is `connectedBy`-agnostic — it acts on item identity (Plaid's item_id) regardless of which user originally connected the item. ITEM webhooks reflect the bank-side state of the connection, which is shared across all workspace members.

## 6. Cron interaction

- `daily-refresh` already filters `status: 'active'` → automatically skips disconnected/error/relink_required items. No change.
- `retry-unprocessed` **needs a small change**: skip events whose item is `disconnected`. After `USER_PERMISSION_REVOKED`, Plaid keeps delivering `SYNC_UPDATES_AVAILABLE` for hours (until `/item/remove` is called). Without this filter every delivery → new event row → another failed sync attempt → another `processError` log line — bounded but noisy.

  Modify `retry-unprocessed.ts` in two places:

  **(a)** Query filter — push the disconnect filter into the WHERE clause and pull `status` into the include select:
  ```ts
  where: {
    processedAt: null,
    webhookCode: "SYNC_UPDATES_AVAILABLE",
    plaidItemId: { not: null },
    receivedAt: { gte: cutoff },
    plaidItem: { is: { status: { not: "disconnected" } } },   // NEW
  },
  include: {
    plaidItem: { select: { id: true, workspaceId: true, connectedBy: true, status: true } }, // + status
  },
  ```

  **(b)** In-loop guard — handles the race where status flips between findMany and the loop. Stamp + skip without calling sync:
  ```ts
  if (!ev.plaidItem) continue; // existing null guard
  const item = ev.plaidItem;

  if (item.status === "disconnected") {
    await prisma.plaidWebhookEvent.update({
      where: { id: ev.id },
      data: { processedAt: new Date(), processError: "item_disconnected" },
    });
    disconnected++;  // separate counter — do NOT reuse gated (different semantics)
    continue;
  }
  // ... existing connectedBy / tier gate logic
  ```

  Add `disconnected` to the summary log alongside `attempted` and `gated`:
  ```ts
  console.info("retry-unprocessed complete", { found: events.length, attempted, gated, disconnected });
  ```

  Defense in depth: query filter avoids 99% of cases; in-loop guard catches the race.
- `error` and `relink_required` items are still retried — they may recover (transient Plaid issue or completed re-auth).

## 7. Observability

- `console.info("ITEM webhook ignored", { itemId, code })` for unhandled codes.
- `app.log.error(...)` if `dispatchItemEvent` throws (Prisma down, etc.).
- Status changes appear in `plaid_items` table — operators can run a quick `SELECT id, "institutionName", status, "errorCode" FROM plaid_items WHERE status != 'active'` to audit.

## 8. Testing

### 8.1 Unit — `plaid.webhook.item.test.ts`

Real DB; seed a `plaid_items` row, call `dispatchItemEvent`, assert the row state.

- `ERROR` with `error.error_code = 'ITEM_LOGIN_REQUIRED'` → `status='error'`, `errorCode='ITEM_LOGIN_REQUIRED'`
- `ERROR` without `error.error_code` → `status='error'`, `errorCode='unknown'`
- `PENDING_EXPIRATION` → `status='relink_required'`, `errorCode=null` (clears any prior errorCode)
- `USER_PERMISSION_REVOKED` → `status='disconnected'`, `errorCode=null`
- `WEBHOOK_UPDATE_ACKNOWLEDGED` → row unchanged (status stays as seeded)
- Unknown future code (e.g. `'NEW_PRODUCT_ADDED'`) → row unchanged
- Last-write-wins: seed item in `disconnected`, dispatch `ERROR` → `status='error'` (precedence is intentional; latest signal wins per §5)

### 8.2 Integration — extend `plaid.webhook.routes.test.ts`

Add cases for the route handler:
- POST with `webhook_type='ITEM'`, `webhook_code='ERROR'` and a known `item_id` → 200 + status updated to `error` + a `plaid_webhook_events` row exists with the ITEM body (audit trail invariant)
- POST with `webhook_type='ITEM'`, unknown `item_id` → 200 + event row stored with `plaidItemId=null` + no `plaid_items` write (consistent with how TRANSACTIONS webhooks treat unknown items)
- POST with `webhook_type='ITEM'`, `webhook_code='WEBHOOK_UPDATE_ACKNOWLEDGED'` → 200 + event row stored + item status unchanged

### 8.3 Cron — extend `cron.retry-unprocessed.test.ts`

Add a test for the new disconnected filter:
- Seed item with `status='disconnected'` + a recent NULL-processedAt SYNC event for it → `runRetryUnprocessed` does NOT call `dispatchWebhookSync`, stamps `processedAt` + `processError='item_disconnected'`, and increments the `disconnected` counter (assert via console.info spy or return value).

### 8.4 E2E

Not added. The route + dispatcher are fully covered by unit + integration tests. Smoke test covers the manual flow.

### 8.5 Smoke

Extend the 1B-webhooks smoke doc with a new section: trigger an `ITEM/ERROR ITEM_LOGIN_REQUIRED` webhook via Plaid sandbox `/sandbox/item/reset_login` (the dedicated endpoint for forcing an ITEM error). Verify the item's `status` flips to `error` and `errorCode` is populated. Note: `/sandbox/item/fire_webhook` can also fire ITEM-type webhooks via the `webhook_type` parameter, but `reset_login` is the more realistic test since it actually invalidates the token.

## 9. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | Should `disconnected` items be cleaned up automatically? | No. The user owns the data — orphan transactions stay. Mobile can offer a "remove" action later. |
| 2 | Recovery path per status | `error` / `relink_required`: the existing `POST /workspaces/:id/plaid-items/:itemId/sync` endpoint (`apps/api/src/routes/plaid-items.ts:46`) re-runs `syncTransactions`; success → `sync.ts:149` clears `errorCode` and flips to `active`. `disconnected`: no re-sync helps (token revoked) — mobile must call `POST /workspaces/:id/plaid/link-token` and run Plaid Link to mint a new access_token. |
| 3 | Bulk re-link if many items expire at once? | Out of scope. Mobile UI handles per-item reconnect. |
| 4 | Does `errorCode='unknown'` ever happen? | Plaid always provides `error.error_code` for ITEM/ERROR webhooks per their docs. The `?? 'unknown'` is defensive only. |
| 5 | `ITEM_LOGIN_REQUIRED` status inconsistency | `sync.ts:162` sets `status='relink_required'` when Plaid throws `ITEM_LOGIN_REQUIRED` during a transaction sync. The `ITEM/ERROR ITEM_LOGIN_REQUIRED` webhook via this plan sets `status='error'`. These two code paths disagree for the same root cause. Last-write-wins (§5) applies; in practice the sync path fires first and the webhook arrives shortly after, leaving the item in `error` rather than `relink_required`. This is a pre-existing inconsistency not introduced here. Resolution: unify in a follow-up plan by mapping `ITEM_LOGIN_REQUIRED` error_code → `relink_required` in the dispatcher, consistent with `sync.ts`. Tracked here so it's a conscious decision. |

---

## 10. Acceptance criteria

- [ ] Migration adds `disconnected` to `PlaidItemStatus` and runs cleanly on the dev DB.
- [ ] `dispatchItemEvent` updates `plaid_items.status` for all 3 actionable codes.
- [ ] Webhook handler dispatches ITEM-relevant events; route still returns 200.
- [ ] Unit + integration tests pass; existing 261 API tests stay green.
- [ ] Smoke test instructions verified manually with a sandbox ITEM webhook.
