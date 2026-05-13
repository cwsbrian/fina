# Plan 1B-cron — Scheduled background jobs (design)

**Date:** 2026-05-13
**Builds on:** Plan 1B-plaid-foundation, Plan 1B-categorize, Plan 1B-webhooks
**Status:** design / pre-implementation

---

## 1. Goal

Provide a single in-process scheduler that runs the four background jobs deferred from 1B-webhooks:

1. **Daily refresh** — periodic `syncTransactions` for every active `plaid_items` row, as a backstop for any missed webhook.
2. **lock_held retry** — re-dispatch `plaid_webhook_events` rows whose `processedAt` is still NULL (sync skipped earlier under advisory-lock contention).
3. **TTL cleanup** — delete `plaid_webhook_events` rows older than `CRON_EVENT_TTL_DAYS` (default 30).
4. **Tier gate** — every background sync checks the item-owner's `effectiveTier`; non-Pro users get sync-skipped (data preserved, item stays active for trial resumption).

## 2. Scope

### In

- Single in-process scheduler (`croner`) registered from `main.ts` after server start.
- `CRON_ENABLED` env toggle (default `false`; dev/test off, production on).
- Pure async job functions, callable from tests and the smoke shell.
- Per-item failure isolation: one item's sync error does not abort the tick.
- Reuse of existing `tryAdvisoryLockTimeout` (1B-plaid-foundation) for cross-source concurrency safety.
- Reuse of existing `effectiveTier()` / `computeEffectiveTier()` helpers in `apps/api/src/auth/tier.ts`.
- New unit + integration tests for each job + the scheduler wiring.
- New smoke-test doc.

### Out

- ITEM webhook → status mapping (`USER_PERMISSION_REVOKED`, `PENDING_EXPIRATION`, `ERROR`). Separate follow-up plan.
- UI surfaces ("trial expired" banner, "paused" badge). Owned by the mobile/web plan.
- Subscription wire-up — `effectiveTier` returns `pro` only via `trialEndsAt`. Real Stripe/Apple-IAP wiring is a separate plan.
- Catchup for missed daily-refresh ticks (if the API was down at 09:00 UTC, that day is silently skipped).
- Distributed coordination across multiple Node processes (single-process deployment assumed).
- Alerting / paging on failure (log-only for now).

## 3. Data Model

No schema migrations. Two new env vars only:

```ts
// apps/api/src/env.ts
CRON_ENABLED: z.preprocess(
  (v) => v === "true" || v === "1",
  z.boolean().default(false),
),
CRON_EVENT_TTL_DAYS: z.coerce.number().int().positive().default(30),
```

`CRON_ENABLED` accepts string `"true"` / `"1"` because every env-var arrives as a string. Anything else (`undefined`, `""`, `"false"`) → false.

`CRON_EVENT_TTL_DAYS` is env-overridable so a smoke test can use a small TTL (e.g. 1) without waiting 30 days.

## 4. Architecture

### 4.1 New files

```
apps/api/src/cron/
  scheduler.ts             # startScheduler(env) / stopScheduler() — registers all jobs
  tier-gate.ts             # checkBackgroundSyncGate(userId) → { ok: true } | { ok: false, reason: string }
  jobs/
    daily-refresh.ts       # runDailyRefresh(env)
    retry-unprocessed.ts   # runRetryUnprocessed(env)
    cleanup-events.ts      # runCleanupEvents(env)
```

Public job signatures:

```ts
export async function runDailyRefresh(env: Env): Promise<void>;
export async function runRetryUnprocessed(env: Env): Promise<void>;
export async function runCleanupEvents(env: Env): Promise<void>;
```

Each is a **pure async function** that does its job once. The scheduler only owns the cron expression → function binding. Tests invoke these directly without involving `croner`.

### 4.2 `scheduler.ts`

```ts
import { Cron } from "croner";

let jobs: Cron[] = [];

export function startScheduler(env: Env): void {
  if (!env.CRON_ENABLED) return;

  jobs = [
    new Cron("0 9 * * *",   { protect: true, name: "daily-refresh" },     () => safe("daily-refresh", () => runDailyRefresh(env))),
    new Cron("*/10 * * * *",{ protect: true, name: "retry-unprocessed" }, () => safe("retry-unprocessed", () => runRetryUnprocessed(env))),
    new Cron("0 3 * * *",   { protect: true, name: "cleanup-events" },    () => safe("cleanup-events", () => runCleanupEvents(env))),
  ];
}

export function stopScheduler(): void {
  for (const j of jobs) j.stop();
  jobs = [];
}

async function safe(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (e) { console.error({ jobName: name, err: e }, "cron job uncaught"); }
}
```

`protect: true` skips a tick when the previous run is still in flight — prevents overrun pile-up.

### 4.3 `main.ts` integration

```ts
async function start(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp(env);
  await app.listen({ host: "0.0.0.0", port: env.PORT });

  void backfillWebhookUrls(env).catch((err) =>
    console.error("webhook backfill failed", err));

  if (env.CRON_ENABLED) {
    const { startScheduler } = await import("./cron/scheduler.js");
    startScheduler(env);
  }
}
```

Dynamic import keeps the cron module out of the bundle when disabled — tests and dev never load `croner`.

### 4.4 Dependency

```
pnpm --filter @fina/api add croner
```

`croner` is zero-dep, ~30 KB, TypeScript-native, actively maintained.

## 5. Jobs

### 5.1 `daily-refresh` — `0 9 * * *` (UTC 09:00)

```ts
export async function runDailyRefresh(env: Env): Promise<void> {
  const items = await prisma.plaidItem.findMany({
    where: { status: "active" },
    // connectedBy is the userId of the member who ran Plaid Link.
    // Workspace has no ownerUserId column; connectedBy is the correct handle for
    // per-user tier gating.  It is nullable (SetNull on user delete) — see below.
    select: { id: true, workspaceId: true, connectedBy: true },
  });

  const t0 = Date.now();
  let synced = 0, gated = 0, failed = 0, lockHeld = 0;

  for (const item of items) {
    if (!item.connectedBy) {
      // Item pre-dates connectedBy tracking. No userId → cannot gate.
      // Allow the sync so stale items are not silently frozen.
      console.warn("daily-refresh: connectedBy null, skipping tier gate", { itemId: item.id });
    } else {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) { gated++; continue; }
    }

    try {
      const r = await syncTransactions(env, item.workspaceId, item.id);
      if ("skipped" in r && r.skipped === "lock_held") lockHeld++;
      else synced++;

      if ("newTxIds" in r && r.newTxIds.length > 0) {
        await categorizeNewTransactions(env, item.workspaceId, r.newTxIds)
          .catch((e) => console.error("categorize after daily-refresh failed", { itemId: item.id, err: e }));
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

Sequential, not parallel — Plaid rate limit is conservative; the user-base in dogfood is small enough that 10 sequential syncs at 09:00 UTC is well under the per-second rate ceiling.

### 5.2 `retry-unprocessed` — `*/10 * * * *` (every 10 min)

```ts
export async function runRetryUnprocessed(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600_000);

  const events = await prisma.plaidWebhookEvent.findMany({
    where: {
      processedAt: null,
      webhookCode: "SYNC_UPDATES_AVAILABLE",
      plaidItemId: { not: null },
      receivedAt: { gte: cutoff },
    },
    // No workspace join needed — tier gate uses plaidItem.connectedBy directly.
    include: { plaidItem: { select: { id: true, workspaceId: true, connectedBy: true } } },
    take: 50,
    orderBy: { receivedAt: "asc" },
  });

  // `attempted` counts rows we passed to dispatchWebhookSync.
  // lock_held dispatches remain NULL and reappear on the next tick — this is intentional.
  let attempted = 0, gated = 0;

  for (const ev of events) {
    // Guard: plaidItemId filter ensures plaidItem is non-null at query time, but a
    // concurrent user deletion applies SetNull between findMany and here.
    if (!ev.plaidItem) continue;

    const item = ev.plaidItem;

    if (!item.connectedBy) {
      // Pre-dates connectedBy tracking — allow sync, no gate possible.
    } else {
      const gate = await checkBackgroundSyncGate(item.connectedBy);
      if (!gate.ok) {
        // Stamp the row so it stops appearing in the NULL retry set.
        await prisma.plaidWebhookEvent.update({
          where: { id: ev.id },
          data: { processedAt: new Date(), processError: `tier_gated:${gate.reason}` },
        });
        gated++;
        continue;
      }
    }

    // dispatchWebhookSync handles its own try/catch + processedAt semantics:
    //  - normal sync: processedAt set
    //  - sync throws: processedAt + processError set
    //  - lock_held:   processedAt stays NULL (we'll see this row again next tick)
    await dispatchWebhookSync(env, item.workspaceId, item.id, ev.id);
    attempted++;
  }

  console.info("retry-unprocessed complete", {
    found: events.length, attempted, gated,
  });
}
```

**Why the 24h floor.** Plaid retries undelivered webhooks for up to 24 hours; within that window a retry can be the difference between catching the delta and missing it. Older NULL rows are either:
- already-superseded by a later webhook + sync (cursor advanced — re-dispatching does nothing), or
- a stuck `lock_held` chain that needs investigation, not autopilot.

Either way, TTL cleanup will sweep them eventually. No alarm on these in this plan — the log line is enough for dogfood.

**Why `take: 50`.** Hard cap so a burst (e.g. mass webhook outage replay) cannot make a single tick run for half an hour. Next tick handles the next 50.

### 5.3 `cleanup-events` — `0 3 * * *` (UTC 03:00)

```ts
export async function runCleanupEvents(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - env.CRON_EVENT_TTL_DAYS * 86_400_000);
  const r = await prisma.plaidWebhookEvent.deleteMany({
    where: { receivedAt: { lt: cutoff } },
  });
  console.info("cleanup-events complete", { deleted: r.count, cutoff });
}
```

Schedule deliberately spaced from `daily-refresh` (03:00 vs 09:00) to avoid query overlap.

### 5.4 `tier-gate.ts`

```ts
import { effectiveTier } from "../auth/tier.js";

export type GateResult = { ok: true } | { ok: false; reason: string };

/** Background-sync version of requireProTier — never throws; returns a
 *  structured skip reason instead. Reuses the shared effectiveTier helper
 *  so trial logic stays in one place. */
export async function checkBackgroundSyncGate(userId: string): Promise<GateResult> {
  const t = await effectiveTier(userId);
  if (t.tier === "pro") return { ok: true };
  if (t.trialEndsAt && t.trialEndsAt <= new Date()) return { ok: false, reason: "trial_expired" };
  return { ok: false, reason: "no_subscription" };
}
```

When the subscription column lands (future plan), `effectiveTier` updates and every background sync inherits the new gate automatically.

## 6. Concurrency

### 6.1 Same item, multiple sources

Webhook handler, daily-refresh, and retry-unprocessed can all target the same item. The existing PG advisory lock inside `syncTransactions` (`tryAdvisoryLockTimeout(plaidItemId)`) serializes them: the loser gets `{ skipped: "lock_held" }` and exits cleanly. No new lock is introduced.

### 6.2 Overrun

Each Cron is created with `protect: true`. If a tick is still running when its next slot fires, the next slot is skipped, not queued. Daily-refresh under load won't accumulate behind itself.

### 6.3 Multi-process

This design assumes **one Node process**. A second process would not corrupt data (advisory lock holds), but the schedulers would fire redundantly. Single-instance deployment is the operator's responsibility.

### 6.4 Shutdown

No explicit SIGTERM handling in `main.ts` today. On process exit, in-flight Plaid HTTP calls abort, PG connections drop, advisory locks release. The next tick on the next process start picks up where things left off via the existing webhook-event NULL retry plus the cursor-driven sync. Graceful shutdown is a follow-up.

## 7. Observability

- Every job logs a `start` is implicit (`durationMs` captures the work) and an `*-complete` line with structured counters.
- `safe` wrapper in scheduler ensures an uncaught throw inside a job is logged but doesn't kill the process or stop the cron.
- All sync errors run through `sanitizePlaidError` before logging — same invariant as the rest of the Plaid stack (no access_token in logs).
- No external alerting in this plan; the `pnpm smoke:api` console is the dogfood observability layer.

## 8. Testing

### 8.1 Unit — `cron/jobs/*.test.ts`

Each job invoked directly. Test container DB; `syncTransactions` and `dispatchWebhookSync` mocked.

**`daily-refresh.test.ts`**
- 3 active items across 3 workspaces → 3 sync calls
- one sync throws → counter `failed = 1`, other two proceed
- `status='error'` item not selected
- tier-gated user → no sync call, `gated` counter increments
- `newTxIds.length > 0` → categorize called

**`retry-unprocessed.test.ts`**
- `processedAt = null` + `SYNC_UPDATES_AVAILABLE` + recent → dispatch called
- `processedAt` set → not selected
- `plaidItemId = null` → not selected
- `receivedAt < cutoff` → not selected
- tier-gated → row gets `processedAt` + `processError = 'tier_gated:<reason>'`, dispatch NOT called
- 51 rows present → exactly 50 dispatched in one tick
- `plaidItem` is null at iteration time (race: SetNull between query and loop) → skip silently, no crash
- `dispatchWebhookSync` mock returns normally but leaves `processedAt = null` (lock_held path) → row reappears on next `findMany` (confirm `attempted = 1`, row still NULL)

**`cleanup-events.test.ts`**
- row older than `CRON_EVENT_TTL_DAYS` → deleted
- row within window → kept
- `env.CRON_EVENT_TTL_DAYS = 1` → cutoff respects the override

**`tier-gate.test.ts`**
- active trial (`trialEndsAt > now`) → `{ ok: true }`
- expired trial (`trialEndsAt < now`, trialConsumed is irrelevant — effectiveTier only checks trialEndsAt) → `{ ok: false, reason: 'trial_expired' }`
- no trial ever set (`trialEndsAt = null`) → `{ ok: false, reason: 'no_subscription' }`

### 8.2 Integration — `cron/scheduler.test.ts`

- `CRON_ENABLED = false` → `startScheduler` registers nothing
- `CRON_ENABLED = true` → 3 Cron instances registered; `stopScheduler` clears them
- job throws inside `safe` → caught, logged, scheduler still alive

### 8.3 E2E

Not added. Realtime cron windows + faketimers + live Plaid is too brittle for the verification gained. The 1B-webhooks E2E already covers webhook → sync. Cron logic is covered by 8.1/8.2.

### 8.4 Smoke

New: `docs/superpowers/smoke-tests/2026-05-13-plan-1b-cron.md`

- Start API with `CRON_ENABLED=true pnpm smoke:api`
- Trigger each job manually via `pnpm --filter @fina/api exec tsx -e "..."` rather than waiting for the cron tick
- Verify counters in the log + DB row state (NULL → set, old rows deleted)

## 9. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | Subscription column missing | `effectiveTier` only checks trial today; `checkBackgroundSyncGate` inherits that. When real subscriptions wire in, no cron change needed. |
| 2 | Missed daily-refresh on downtime | Silently skipped that day. Webhook + next day's tick recover via cursor. `lastRunAt` tracking deferred. |
| 3 | 24h retry window | Older NULL rows are not retried; TTL sweeps them. Log line is the only signal. |
| 4 | Timezone | All cron expressions UTC. Local-time scheduling is a future-day cosmetic change (croner accepts `{ timezone }`). |
| 5 | Library choice | `croner` over `node-cron` for TS support, overrun handling, smaller surface. Interface-compatible swap possible if needed. |
| 6 | Load at scale | Sequential per-item sync is fine up to ~50 items per workspace. Past that, batch with sleep or move to a queue (follow-up). |
| 7 | Test isolation | Cron stays off in tests because `CRON_ENABLED` defaults to false and the dynamic import means tests never load `croner`. |
| 8 | Webhook-handler gate parity | The live webhook handler currently dispatches without a tier check (intentional in 1B-webhooks since all users are trial). When this plan ships, optionally fold `checkBackgroundSyncGate` into `dispatchWebhookSync` for parity — out of scope here, listed as the natural next step. |
| 9 | Per-item `effectiveTier` N DB reads | `daily-refresh` calls `checkBackgroundSyncGate` once per item. A user with N items makes N identical `user.findUniqueOrThrow` calls in one tick. At dogfood scale (≤ 5 items total) this is negligible. Implementers may add a `Map<userId, GateResult>` per-tick cache as an easy optimization if N grows. |
| 10 | `syncTransactions` per-item timeout | The Plaid axios client has no request timeout. A hung call in `daily-refresh` can block the entire tick. At dogfood scale this is low-risk; implementers should wrap each `syncTransactions` call in `Promise.race([syncTransactions(...), sleep(60_000).then(() => { throw new Error("timeout") })])` or configure an axios timeout on the Plaid client. Flagged as a follow-up. |

---

## 10. Acceptance criteria

- [ ] `CRON_ENABLED=false` (default): API starts, croner is never loaded, no cron line in logs.
- [ ] `CRON_ENABLED=true`: API logs 3 scheduler registrations on start.
- [ ] `daily-refresh` manual invocation: every active item across all workspaces gets a sync attempt or a tier-gate skip, never silent dropping.
- [ ] `retry-unprocessed` manual invocation with a seeded NULL `plaid_webhook_event` row → row gets `processedAt` set (or remains NULL on lock_held).
- [ ] `cleanup-events` manual invocation with a row older than `CRON_EVENT_TTL_DAYS` → row deleted.
- [ ] Tier-gated user's events get `processedAt + processError='tier_gated:<reason>'` (do not stay NULL forever).
- [ ] Smoke doc lets a fresh contributor verify all four jobs without waiting for real cron ticks.
- [ ] No new test failures; existing 226 API tests stay green.
