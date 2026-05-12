# Plan 1B-webhooks — Plaid Webhook Handler — Design Spec

**Date:** 2026-05-12
**Status:** Brainstorm complete, ready for implementation planning
**Owner:** Brian (cwsbrian@gmail.com)
**Implements:** master spec `docs/superpowers/specs/2026-05-07-fina-design.md` §9.4 (webhook security) + §15 Phase 1B
**Builds on:**
- Plan 1B-foundation (`docs/superpowers/specs/2026-05-11-plan-1b-plaid-foundation-design.md`) — `plaid_items`, `syncTransactions` already exist
- Plan 1B-categorize (`docs/superpowers/specs/2026-05-12-plan-1b-categorize-design.md`) — `categorizeNewTransactions` already wired to sync

---

## 1. Goal

Receive Plaid webhook callbacks, verify their authenticity, and trigger `syncTransactions` + `categorizeNewTransactions` in the background — so new transactions appear automatically without the user hitting Refresh.

**Exit criterion (smoke):** Plaid sandbox fires `SYNC_UPDATES_AVAILABLE` → API logs show webhook received → `plaid_webhook_events` row appears → new transactions + categories in DB. Duplicate webhook delivery deduped (second row not created, sync not triggered twice).

This plan is **backend only.** No web/mobile UI changes. Cron-based daily fallback sync is a separate plan (Plan 1B-cron).

---

## 2. Scope

**In:**
- `POST /plaid/webhook` — unauthenticated Plaid-signature-verified endpoint.
- Plaid JWT (ES256) signature verification + body SHA-256 check + `iat` 5-minute replay window.
- JWK memory cache (Map<kid, jwk>, 24h TTL) to avoid per-request Plaid API calls.
- `plaid_webhook_events` table — idempotency (body hash dedup) + audit trail.
- Detached `sync + categorize` dispatch for `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE`. All other webhook types logged and stored but not acted on.
- Helper module for test key injection (`apps/api/tests/helpers/plaid-webhook-mock.ts`).
- Smoke test doc with Tailscale Funnel setup + Plaid Dashboard sandbox URL (already registered by owner).
- Unit tests (signature, routes, dispatch) + E2E test (skip-guarded on real PLAID_* creds + Funnel URL).

**Out (deferred):**
- `ITEM` webhook codes (`ERROR`, `USER_PERMISSION_REVOKED`, `PENDING_EXPIRATION`) — status update + relink UI. Deferred to a follow-up plan; these events are logged but not acted on in 1B-webhooks.
- `NEW_ACCOUNTS_AVAILABLE` — update_mode Plaid Link re-open. Phase 2.
- Persistent job queue (pg-boss etc.) — in-process detached promise is sufficient; queue deferred to when Phase 2 chat writes need it.
- `plaid_webhook_events` TTL cleanup — Plan 1B-cron will implement the 7-day cleanup (master spec §9.4).
- Production webhook URL configuration — documented in deployment runbook, not this plan.

---

## 3. Data Model

### 3.1 New table

```prisma
model PlaidWebhookEvent {
  id            String    @id @default(cuid())
  // NULL when item_id is not found in our DB (disconnected item, stale Plaid delivery).
  plaidItemId   String?
  webhookType   String    // e.g. "TRANSACTIONS"
  webhookCode   String    // e.g. "SYNC_UPDATES_AVAILABLE"
  // SHA-256 (hex) of raw request body bytes. Dedupes exact replay deliveries.
  // Two consecutive SYNC_UPDATES_AVAILABLE webhooks differ in timestamp/count → different hash → both processed.
  bodyHash      String    @unique
  // Full body stored for debugging + future audit consistency.
  body          Json
  receivedAt    DateTime  @default(now())
  // Set by the detached dispatchWebhookSync after sync+categorize completes (or fails).
  // NULL while in-flight or if webhook type was not dispatched.
  processedAt   DateTime?
  processError  String?   // Short error message (≤500 chars); full stack goes to structured log.

  plaidItem PlaidItem? @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)

  @@index([plaidItemId, receivedAt])
  @@index([webhookType, webhookCode])
  @@map("plaid_webhook_events")
}
```

`processedAt` / `processError` are written by `dispatchWebhookSync` after the webhook handler has already returned 200, so the handler does not await them. Their purpose is operational: a single query reveals "webhook received but sync failed" cases.

### 3.2 Existing schema — no changes

`PlaidItem` needs no new columns. Plaid routes webhook delivery by the registered URL in the Dashboard; the webhook URL is not stored per-item in our DB.

### 3.3 Migration

Single migration: `add_plaid_webhook_events`.

---

## 4. Architecture

### 4.1 New files

```
apps/api/src/plaid/webhook-jwks.ts        JWK cache + signature verification
apps/api/src/plaid/webhook-dispatch.ts    dispatchWebhookSync (sync + categorize + row update)
apps/api/src/routes/plaid-webhook.ts      Fastify route plugin
apps/api/tests/plaid.webhook.signature.test.ts
apps/api/tests/plaid.webhook.routes.test.ts
apps/api/tests/plaid.webhook.dispatch.test.ts
apps/api/tests/helpers/plaid-webhook-mock.ts
e2e/plan-1b-webhooks.spec.ts
docs/superpowers/smoke-tests/2026-05-12-plan-1b-webhooks.md
```

`server.ts` gets one new `app.register(plaidWebhookRoutes)` line.

### 4.2 Request flow

```
Plaid server ─POST─▶ POST /plaid/webhook
                      │
                      1. Raw body read as Buffer (custom Fastify content-type parser,
                         webhook route only — does not affect other routes' JSON parsing)
                      │
                      2. JWT signature verify (verifyPlaidWebhook in webhook-jwks.ts)
                         a. Decode JWT header → extract kid
                         b. getJwk(env, kid): check memory cache; on miss call
                            plaid.webhookVerificationKeyGet({ key_id: kid }) → cache result 24h
                         c. jose.compactVerify(jwt, jwk, { algorithms: ['ES256'] })
                         d. Assert payload.request_body_sha256 === sha256hex(rawBody)
                         e. Assert |now - payload.iat| ≤ 300s
                         f. Failure at any step → 401 + return (body not stored)
                      │
                      3. JSON.parse(rawBody) + zod schema validation
                         Failure → 400
                      │
                      4. PlaidItem lookup by webhook.item_id
                         Not found → plaidItemId = null (store for audit, skip dispatch)
                      │
                      5. Idempotency: INSERT INTO plaid_webhook_events (bodyHash, ...)
                         P2002 conflict → already processed → 200 + return
                      │
                      6. Dispatch decision
                         webhookType === "TRANSACTIONS"
                           && webhookCode === "SYNC_UPDATES_AVAILABLE"
                           && plaidItemId !== null
                         → void dispatchWebhookSync(env, wsId, plaidItemId, eventId).catch(log)
                         All other types/codes → log only, no dispatch
                      │
                      7. reply.code(200).send({})
```

### 4.3 Body parsing

```typescript
// In plaidWebhookRoutes plugin only:
app.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (_req, body, done) => done(null, body),
);
```

This override is scoped to the plugin's encapsulation context (Fastify's `register` isolates `addContentTypeParser` by default), so no impact on other routes.

### 4.4 Route placement

`POST /plaid/webhook` lives in `routes/plaid-webhook.ts` (separate from `routes/plaid.ts`). Rationale: all existing plaid routes require session auth; webhook is intentionally unauthenticated, so keeping it isolated avoids accidentally inheriting session middleware.

---

## 5. Signature Verification (`webhook-jwks.ts`)

### 5.1 JWK cache

```typescript
const cache = new Map<string, { key: jose.KeyLike; fetchedAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getJwk(env: Env, kid: string): Promise<jose.KeyLike> {
  const hit = cache.get(kid);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.key;
  const res = await plaidClient(env).webhookVerificationKeyGet({ key_id: kid });
  const jwk = res.data.key;
  const key = await jose.importJWK(jwk, 'ES256');
  cache.set(kid, { key, fetchedAt: Date.now() });
  return key;
}
```

Exported `_clearCacheForTest()` allows tests to reset between cases without restarting the process.

### 5.2 Verification function

```typescript
export async function verifyPlaidWebhook(
  env: Env,
  rawBody: Buffer,
  jwtHeader: string | undefined,
): Promise<void> {  // throws PlaidWebhookVerifyError on any failure
  if (!jwtHeader) throw new PlaidWebhookVerifyError('missing_header');
  const { payload, protectedHeader } = await jose.compactVerify(jwtHeader, async (header) => {
    return getJwk(env, header.kid!);
  }).catch(() => { throw new PlaidWebhookVerifyError('invalid_signature'); });
  const claims = PlaidJwtPayloadSchema.parse(JSON.parse(new TextDecoder().decode(payload)));
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  if (claims.request_body_sha256 !== bodyHash) throw new PlaidWebhookVerifyError('body_mismatch');
  if (Math.abs(Date.now() / 1000 - claims.iat) > 300) throw new PlaidWebhookVerifyError('iat_expired');
}
```

`PlaidWebhookVerifyError` carries a `code` string used in the 401 response body.

### 5.3 Library

`jose` (ES256) — already installed as a transitive dependency (`jose@6.2.3` via pnpm). No new package needed.

### 5.4 Replay protection — two layers

| Layer | Mechanism | Catches |
|---|---|---|
| Time-based | `iat` within ±5 minutes | Attacker who intercepts a valid webhook and re-sends it later |
| Content-based | `bodyHash @unique` in DB | Plaid's own retry deliveries of the exact same payload |

---

## 6. Dispatch (`webhook-dispatch.ts`)

```typescript
export async function dispatchWebhookSync(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
  webhookEventId: string,
): Promise<void> {
  try {
    const r = await syncTransactions(env, workspaceId, plaidItemId);
    // Both SyncResult shapes carry newTxIds (including lock_held). Committed inserts
    // from pages that ran before a lock collision still need categorizing.
    if (r.newTxIds.length > 0) {
      await categorizeNewTransactions(env, workspaceId, r.newTxIds);
    }
    await prisma.plaidWebhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date() },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await prisma.plaidWebhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: new Date(), processError: msg },
    }).catch(() => {/* already in catch; swallow update failure */});
    // Structured log — full stack visible in log sink, short message in DB.
    logger.error({ err: e, plaidItemId, webhookEventId }, 'webhook sync failed');
  }
}
```

**lock_held case**: `syncTransactions` returns `{ skipped: 'lock_held', ... }` — treated as success (another sync is in progress; it will pick up the same Plaid delta). `processedAt` is set, `processError` is null.

Caller in route handler:

```typescript
void dispatchWebhookSync(env, wsId, plaidItemId, event.id).catch(() => {
  // Last-resort safety: dispatchWebhookSync already logs internally.
  // This catch prevents unhandled rejection warnings.
});
```

---

## 7. Error Response Matrix

| Condition | HTTP | Notes |
|---|---|---|
| Missing / invalid JWT signature | 401 | Body not stored. Plaid sees 401 and can investigate key rotation. |
| Body hash mismatch | 401 | Same rationale — signals Plaid-side issue. |
| `iat` > 5 min from now | 401 | Replay attempt. |
| Body not valid JSON or fails zod | 400 | Legitimate Plaid would never send this. |
| `item_id` not in our DB | 200 | Row stored with `plaidItemId=null`; sync skipped. 200 prevents Plaid retry storm on stale items. |
| Duplicate body hash (idempotency) | 200 | No new row, no dispatch. |
| `TRANSACTIONS` / `SYNC_UPDATES_AVAILABLE` | 200 | Row stored + dispatch detached. |
| `TRANSACTIONS` / other code (legacy) | 200 | Row stored, no dispatch, logged. |
| Any other `webhookType` | 200 | Row stored, no dispatch, logged. |
| Detached sync throws | — | Handler already returned 200. `processError` written to row. |

**Design principle**: 200 means "Plaid, stop retrying" — not "successfully processed". Operational truth lives in `processedAt`/`processError`.

---

## 8. Testing

### 8.1 Test helper (`tests/helpers/plaid-webhook-mock.ts`)

```typescript
// Generates a throwaway ES256 key pair for tests.
export async function generateWebhookKeys(): Promise<{ privateKey; publicKey; jwk }>;

// Signs a body buffer and returns the plaid-verification JWT header value.
export async function signWebhook(body: Buffer, privateKey, iat?: number): Promise<string>;

// Injects a public key into the JWK cache (bypasses Plaid API call in tests).
export function injectJwkForTest(kid: string, publicKey): void;
```

Mirrors the pattern in `tests/helpers/gemini-mock.ts`.

### 8.2 Unit: `plaid.webhook.signature.test.ts`

- Valid JWT + matching body hash → `verifyPlaidWebhook` resolves
- Invalid signature → throws `PlaidWebhookVerifyError('invalid_signature')`
- Body hash mismatch → throws `PlaidWebhookVerifyError('body_mismatch')`
- `iat` 301s ago → throws `PlaidWebhookVerifyError('iat_expired')`
- JWK cache hit: second call with same kid does not call `webhookVerificationKeyGet`
- JWK cache miss after 24h: re-fetches

### 8.3 Unit: `plaid.webhook.routes.test.ts`

Signature module is mocked (pass-through by default, throw on demand).

- Valid `SYNC_UPDATES_AVAILABLE` → 200, `plaid_webhook_events` row created, dispatch spy called once
- Invalid signature (mock throws) → 401, no row
- Same body twice → first 200 + insert, second 200 + no insert, dispatch called once total
- Unknown `item_id` → 200, row with `plaidItemId=null`, dispatch not called
- `webhookType=ITEM` → 200, row stored, dispatch not called
- Bad JSON body → 400
- Body > 1MB → 413 (Fastify default `bodyLimit: 1048576`)

### 8.4 Unit: `plaid.webhook.dispatch.test.ts`

`syncTransactions` and `categorizeNewTransactions` are mocked.

- Normal sync + categorize → `processedAt` set, `processError` null
- Sync throws → `processedAt` + `processError` set, no unhandled rejection
- `syncTransactions` returns `lock_held` → `processedAt` set, `processError` null
- `newTxIds` empty → `categorizeNewTransactions` not called

### 8.5 E2E (`e2e/plan-1b-webhooks.spec.ts`)

Skip-guarded: requires `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_WEBHOOK_URL` (the Tailscale Funnel URL).

```
1. Sign up + connect Plaid sandbox (Tartan-Dominion Bank)
2. Wait for initial sync (from exchange)
3. Call POST /sandbox/item/fire_webhook { item_id, webhook_type: TRANSACTIONS,
     webhook_code: SYNC_UPDATES_AVAILABLE }
4. Poll plaid_webhook_events for receivedAt within 10s → expect 1 row
5. Poll transactions for processedAt on the event row → expect non-null within 15s
6. Assert transaction count ≥ initial (webhook triggered a sync)
```

---

## 9. Dev / Smoke Setup

### 9.1 Tailscale Funnel (one-time)

```bash
sudo tailscale funnel --bg 4000   # expose localhost:4000 as HTTPS on ts.net
tailscale funnel status            # confirm public URL
```

Tailscale Funnel proxies HTTPS (443) → local port 4000. The resulting `https://<machine>.<tailnet>.ts.net` URL is stable across API restarts.

### 9.2 Plaid Dashboard

Webhook URL already registered by owner in Plaid sandbox environment:
`https://<machine>.<tailnet>.ts.net/plaid/webhook`

For production: register the production API base URL's `/plaid/webhook` path in Plaid Dashboard production environment (deployment runbook, out of scope here).

### 9.3 Env vars

No new env vars required. `PLAID_CLIENT_ID` + `PLAID_SECRET` + `PLAID_ENV` already present. JWK fetching uses the Plaid SDK client already initialized in `src/plaid/client.ts`.

For E2E tests, one new optional var:
```
PLAID_WEBHOOK_URL=https://<machine>.<tailnet>.ts.net/plaid/webhook
```
If absent, E2E webhook tests are skipped.

---

## 10. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | ITEM webhook handling | Deferred. Events logged but no status update in 1B-webhooks. Follow-up plan handles `ERROR` → `status=error`, `USER_PERMISSION_REVOKED` → disconnect, `PENDING_EXPIRATION` → `status=relink_required`. |
| 2 | Webhook event TTL cleanup | Deferred to Plan 1B-cron. Rows accumulate indefinitely in 1B-webhooks (low volume for single user). |
| 3 | Production URL | Registered in Plaid Dashboard production environment at deployment time. Not stored in DB. |
| 4 | Plaid key rotation | If Plaid rotates the JWK kid, the cache miss path re-fetches automatically. No manual intervention needed. |
| 5 | Process restart between 200 and sync | Webhook event row exists (`processedAt=null`). Plan 1B-cron can query and retry these on startup. Acceptable gap given Plaid retry window + daily cron safety net. |
