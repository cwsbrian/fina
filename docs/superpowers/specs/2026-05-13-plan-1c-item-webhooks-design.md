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

```sql
-- prisma migration
ALTER TYPE "PlaidItemStatus" ADD VALUE 'disconnected';
```

Resulting enum: `active | error | relink_required | disconnected`.

Semantic distinction:
- `error` — Plaid SDK error during sync or item-error webhook (something broke; may be transient).
- `relink_required` — Plaid signaled token expiry / MFA re-auth needed; same item can be relinked.
- `disconnected` — User revoked access at the bank or in their bank's app; new Plaid Link required.

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
  parsed.webhook_type === "ITEM" &&
  item !== null &&
  ["ERROR", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"].includes(parsed.webhook_code);

if (isItemRelevant) {
  void dispatchItemEvent(item, parsed as ItemBody).catch((e) => {
    app.log.error({ err: e, itemId: parsed.item_id }, "ITEM webhook dispatch failed");
  });
}
```

The handler still returns `200` immediately (Plaid retries on non-2xx). Dispatch is detached.

## 5. Concurrency

`dispatchItemEvent` is a single `prisma.update` — atomic. No advisory lock needed. If two ITEM webhooks for the same item arrive simultaneously, the last-write-wins is acceptable: status flips reflect the latest signal from Plaid.

## 6. Cron interaction

No changes needed:
- `daily-refresh` already filters `status: 'active'` → automatically skips disconnected/error/relink_required items.
- `retry-unprocessed` retries TRANSACTIONS events regardless of item status; sync calls on disconnected items will fail with a Plaid error and be stamped with `processError` by `dispatchWebhookSync`. That's correct — we don't want stuck NULL events for dead items.

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

### 8.2 Integration — extend `plaid.webhook.routes.test.ts`

Add cases for the route handler:
- POST with `webhook_type='ITEM'`, `webhook_code='ERROR'` and a known `item_id` → 200 + status updated to `error`
- POST with `webhook_type='ITEM'`, unknown `item_id` → 200 + no DB write (since `item === null`)
- POST with `webhook_type='ITEM'`, `webhook_code='WEBHOOK_UPDATE_ACKNOWLEDGED'` → 200 + status unchanged

### 8.3 E2E

Not added. The route + dispatcher are fully covered by unit + integration tests. Live Plaid ITEM webhooks require manual setup (Plaid sandbox `fire_webhook` accepts ITEM events too) — covered by smoke test.

### 8.4 Smoke

Extend the 1B-webhooks smoke doc with a new section: fire an `ITEM/ERROR` webhook from Plaid sandbox, verify the item's status flips to `error`.

## 9. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | Should `disconnected` items be cleaned up automatically? | No. The user owns the data — orphan transactions stay. Mobile can offer a "remove" action later. |
| 2 | What about `error` items going stale? | Cron retry on TRANSACTIONS events still tries them once, fails, stamps. Mobile shows the error badge. Owner can re-trigger sync from the UI. |
| 3 | Bulk re-link if many items expire at once? | Out of scope. Mobile UI handles per-item reconnect. |
| 4 | Does `errorCode='unknown'` ever happen? | Plaid always provides `error.error_code` for ITEM/ERROR webhooks per their docs. The `?? 'unknown'` is defensive only. |

---

## 10. Acceptance criteria

- [ ] Migration adds `disconnected` to `PlaidItemStatus` and runs cleanly on the dev DB.
- [ ] `dispatchItemEvent` updates `plaid_items.status` for all 3 actionable codes.
- [ ] Webhook handler dispatches ITEM-relevant events; route still returns 200.
- [ ] Unit + integration tests pass; existing 261 API tests stay green.
- [ ] Smoke test instructions verified manually with a sandbox ITEM webhook.
