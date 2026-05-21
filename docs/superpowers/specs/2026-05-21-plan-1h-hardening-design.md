# Plan 1H-hardening — production hardening before Phase 2 dogfooding

**Date:** 2026-05-21
**Status:** Spec
**Sub-plan of:** Phase 1 closure. Last batch of work before Phase 2 (Magic
Ritual). Pairs with **Plan 1J-cleanup** (tech-debt, scheduled separately).

---

## 1. Goal

Phase 1 is feature-complete (932 tests pass, all spec deliverables shipped),
but the API has nine production-hardening gaps surfaced by the
`2026-05-21` audit. Close all nine in one batch so Phase 2 (daily ritual
+ push notifications + family dogfooding) ships onto a stable base.

The nine items in scope:

| # | Item | Severity | Effort |
|---|---|---|---|
| 1 | `@fastify/rate-limit` + per-route policy | BLOCKING | M |
| 2 | `@fastify/helmet` security headers | IMPORTANT | S |
| 3 | `/live` + `/ready` split, DB-ping in `/ready` | IMPORTANT | S |
| 4 | Singleton Pino logger; replace 33 `console.*` callsites | IMPORTANT | M |
| 5 | `unhandledRejection` + `uncaughtException` handlers | IMPORTANT | S |
| 6 | Prisma `connectionLimit` env-tunable | IMPORTANT | S |
| 7 | `RESEND_API_KEY` required in production | IMPORTANT | S |
| 8 | Cron observability via structured log events | IMPORTANT | M |
| 9 | Plaid webhook dispatch silent `.catch(() => {})` removed | IMPORTANT | S |

### Out of scope

| Item | Why deferred |
|---|---|
| `@fina/shared` tech-debt (1C-audit-http, scheduled-spend cleanup hooks, findTransactions tz, detectRecurringMerchants polish) | Plan 1J-cleanup (separate plan) |
| Redis-backed rate limit | v1 is single-instance; in-memory is sufficient. Re-evaluate when scaling to multi-instance. |
| Log shipping transport (Datadog, CloudWatch, …) | Deployment concern, not application code. Pino's default JSON-on-stdout is the contract; shipper is configured at the container layer. |
| Health endpoint Plaid/Resend dependency checks | External-service flakiness should not kill pods. `/ready` only verifies DB connectivity, which is the API's hard prerequisite. |
| Metrics endpoint (`/metrics` Prometheus) | Defer until log-based alerting is exhausted. |
| Multi-instance scaling (PgBouncer, shared session store) | v1 is single-instance. |

---

## 2. Shared library additions

Per the CLAUDE.md rule "API response/request types go to `@fina/shared` first".
Four additions land before any API code:

### 2.1 `rate_limit_exceeded` error code (`errors.ts`)

Extend `API_ERROR_CODES` with `"rate_limit_exceeded"`. Frontend `switch
(code)` exhaustiveness will catch the addition next time it's recompiled.

### 2.2 `RATE_LIMITS` constants (`constants.ts`)

```ts
export const RATE_LIMITS = {
  /** Default for any route without an explicit override. Keyed by IP. */
  globalDefault: { max: 60, windowMs: 60_000 },
  /** Heaviest cost — guards LLM token spend. Keyed by user id. */
  chatMessages: { max: 30, windowMs: 60_000 },
  /** Credential stuffing protection. Keyed by IP. */
  auth: { max: 5, windowMs: 60_000 },
  /** Plaid Link callback / re-exchange. Keyed by user id. */
  plaidExchange: { max: 5, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;
```

API registers the plugin with these values. Frontend may import the same
numbers later to render "X requests remaining" UI without copying values.

### 2.3 `HealthDTO` (`dto/health.ts`)

```ts
export type HealthDTO = {
  status: "ok" | "degraded";
  checks: { db: "ok" | "down" };
};
```

`/ready` returns this shape. `/live` returns `{ status: "ok" }` only — no
checks payload, because liveness is "process responding" by definition.

### 2.4 `LogContext` type (`logging.ts`)

```ts
export type LogContext = {
  /** Request-scoped */
  requestId?: string;
  userId?: string;
  workspaceId?: string;
  /** Chat / LLM */
  threadId?: string;
  tool?: string;
  /** Cron */
  cron?: string;
  event?: "start" | "skip" | "protected_skip" | "success" | "fail";
  durationMs?: number;
  /** Plaid */
  plaidEvent?: string;
  plaidItemId?: string;
  /** Audit log linkage */
  auditAction?: string;
  /** Error context — arbitrary error shape allowed under `err` */
  err?: unknown;
};
```

API's logger module narrows `info(payload: LogContext, msg?: string)` so a
typo in a key (`workspaceID` vs `workspaceId`) is a TS error. New fields
land here, not as free-floating keys.

---

## 3. Architecture

### 3.1 Logger module (`apps/api/src/logger.ts`)

```ts
import pino from "pino";
import type { LogContext } from "@fina/shared";

export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Typed wrapper so log payloads must match LogContext.
export function logInfo(ctx: LogContext, msg: string): void { logger.info(ctx, msg); }
export function logWarn(ctx: LogContext, msg: string): void { logger.warn(ctx, msg); }
export function logError(ctx: LogContext, msg: string): void { logger.error(ctx, msg); }
export function logFatal(ctx: LogContext, msg: string): void { logger.fatal(ctx, msg); }
```

Fastify reuses this instance via `buildApp({ env, logger })` — Fastify
accepts a Pino instance directly and `app.log` becomes the same logger.

### 3.2 Rate limit (`server.ts`)

`@fastify/rate-limit` registered with a route-aware policy. The plugin
supports `config: { rateLimit: ... }` on individual routes; we expose a
helper `withRateLimit(key: RateLimitKey)` in `src/auth/rate-limit.ts`:

```ts
import { RATE_LIMITS, type RateLimitKey } from "@fina/shared";

export function withRateLimit(key: RateLimitKey) {
  const policy = RATE_LIMITS[key];
  return {
    rateLimit: {
      max: policy.max,
      timeWindow: policy.windowMs,
      keyGenerator: key === "chatMessages" || key === "plaidExchange"
        ? userKeyGenerator   // session-based
        : ipKeyGenerator,    // IP-based
    },
  };
}
```

User-keyed routes pull the session id from the request via Better Auth
cookie reading (same path as `requireSession`). On unauth requests the
plugin falls back to IP keying.

Test environment: `process.env.NODE_ENV === "test"` ⇒ plugin globally
disabled via `skipOnError + max: Infinity` on registration. Rate limit
integration tests opt in by setting an env var that toggles.

### 3.3 Helmet (`server.ts`)

Default Helmet config plus:
- `contentSecurityPolicy: { directives: { "default-src": ["'none'"] } }` — API
  serves no HTML; null CSP is safe and strictest.
- `crossOriginResourcePolicy: { policy: "same-site" }`.
- `frameguard: { action: "deny" }`.

### 3.4 Health routes (`routes/health.ts`)

Three routes, all unauthenticated:
- `GET /live` — returns `{ status: "ok" }` with 200, always.
- `GET /ready` — runs `prisma.$queryRaw\`SELECT 1\`` with a 1s timeout. On
  success returns `HealthDTO` with `checks.db: "ok"` and 200. On failure
  returns the same DTO with `checks.db: "down"` and 503.
- `GET /health` — alias for `/ready` (back-compat for existing LB configs).

### 3.5 Process handlers (`main.ts`)

```ts
process.on("unhandledRejection", (reason) => {
  logFatal({ err: reason }, "unhandled_rejection");
  // Allow logger to flush before exit.
  setTimeout(() => process.exit(1), 100);
});
process.on("uncaughtException", (err) => {
  logFatal({ err }, "uncaught_exception");
  setTimeout(() => process.exit(1), 100);
});
```

Existing `SIGTERM` graceful shutdown stays.

### 3.6 Prisma pool (`db.ts` + `env.ts`)

```ts
// db.ts
const connectionString = process.env.DATABASE_URL!;
const limit = Number(process.env.PRISMA_CONNECTION_LIMIT ?? 10);
const url = new URL(connectionString);
url.searchParams.set("connection_limit", String(limit));
export const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
```

`env.ts` adds `PRISMA_CONNECTION_LIMIT: z.coerce.number().int().min(1).default(10)`.
`.env.example` gains the same line.

### 3.7 RESEND_API_KEY enforcement (`env.ts`)

```ts
const envSchema = z.object({
  // … existing
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  RESEND_API_KEY: z.string().optional(),
  // …
}).refine(
  (e) => e.NODE_ENV !== "production" || (e.RESEND_API_KEY && !e.RESEND_API_KEY.startsWith("re_dev_") && e.RESEND_API_KEY !== "re_..."),
  { message: "RESEND_API_KEY must be a real Resend key in production", path: ["RESEND_API_KEY"] },
);
```

Server startup fails with a clear message if production is misconfigured.
Dev/test still allow the existing console-fallback in `email/send.ts`.

### 3.8 Cron observability (`cron/scheduler.ts` + `cron/jobs/*.ts`)

Every cron job's run boundary emits structured logs:

```ts
const startedAt = Date.now();
logInfo({ cron: name, event: "start" }, "cron started");
try {
  await runJob();
  logInfo({ cron: name, event: "success", durationMs: Date.now() - startedAt }, "cron ok");
} catch (err) {
  logError({ cron: name, event: "fail", durationMs: Date.now() - startedAt, err }, "cron failed");
  // existing behaviour: swallow so croner keeps scheduling
}
```

The `protect: true` skip event (croner reports it via the `protect`
callback) emits `logWarn({ cron: name, event: "protected_skip" }, "cron skipped — previous run still in flight")`.

### 3.9 Plaid webhook silent error (`routes/plaid-webhook.ts:67`)

```ts
// Before:
dispatchWebhookSync(...).catch(() => {});

// After:
dispatchWebhookSync(...).catch((err) => {
  logError({ plaidEvent: event.webhook_code, plaidItemId: event.item_id, err }, "plaid dispatch failed");
});
```

Response still returns 200 to prevent Plaid retry storms.

---

## 4. console.* → logger migration map

The audit grep `grep -rn 'console\.' apps/api/src/` reports ~33 lines.
The breakdown below covers the major files. The implementer should
re-run the grep at task start and migrate every match — the table is
illustrative of where the work lives.

| File | Calls | Replacement context |
|---|---|---|
| `audit/service.ts:100` | 1× `console.error` | `{ auditAction, err }` |
| `cron/scheduler.ts` | 3× `console.warn/error` | `{ cron, event, err }` |
| `cron/jobs/daily-refresh.ts` | 4× | `{ cron: "daily-refresh", … }` |
| `cron/jobs/retry-unprocessed-events.ts` | 2× | `{ cron: "retry-unprocessed-events", … }` |
| `cron/jobs/cleanup-events.ts` | 2× | `{ cron: "cleanup-events", … }` |
| `cron/jobs/scheduled-spend-match.ts` | 2× | `{ cron: "scheduled-spend-match", … }` |
| `chat/turn.ts` | 1× `console.error` | `{ threadId, err }` |
| `chat/dispatcher.ts:24` | 1× | `{ tool, err }` |
| `routes/chat.ts:274,314` | 2× | `{ threadId, err }` |
| `chat/auto-title.ts:51` | 1× | `{ threadId, err }` |
| `plaid/sync.ts:234` | 1× | `{ plaidEvent, err }` |
| `plaid/webhook-dispatch.ts:34,55` | 2× | `{ plaidEvent, plaidItemId, err }` |
| `plaid/webhook-backfill.ts:17,44` | 2× | `{ plaidItemId, err }` |
| `email/send.ts:30` | 1× (dev fallback) | leave as `console.log` — intentional dev-only signal |

The lone surviving `console.log` is the dev-mode email fallback (`email/send.ts:30`). It writes magic links to stdout when `RESEND_API_KEY` is unset. Marked with an inline comment explaining the exception so a future audit doesn't sweep it.

---

## 5. Data flow

No model changes. No new tables. Behaviour additions:
- Request → Helmet adds headers → Rate-limit may reject 429 → Route handler.
- Cron tick → croner protect-check → if running, logger.warn skip; else
  logger.info start → job → logger.info/error end.
- Plaid webhook → JWKS verify (unchanged) → respond 200 immediately →
  fire-and-forget dispatch with logger-bound `.catch`.
- Process crash → handler logs fatal → 100ms drain → exit 1.

---

## 6. Concurrency + correctness

### 6.1 Rate limit per-user keying race

Better Auth cookie parsing inside `keyGenerator` is sync (cookie is on the
request) — no race. If the cookie is missing/invalid, the plugin falls
back to IP. No user can ever route to another user's bucket because
keys are namespaced by route + key family.

### 6.2 Logger initialisation

The Pino instance is constructed at module load. Fastify reuses it via
`buildApp({ logger })`. Test environments set `level: "silent"` to avoid
log noise in `vitest run` output. Existing tests that assert on log
shape (e.g., 1J's audit tests) use `pino-test` (lightweight Pino
test transport) — added as a devDependency.

### 6.3 Health `/ready` DB-ping leak

`SELECT 1` is wrapped in a 1-second `AbortSignal.timeout(1000)`. A hung
DB doesn't pile up requests in the readiness probe path.

### 6.4 Process handler ordering

`unhandledRejection` fires before `uncaughtException` for promise
rejections that surface as throws. Both handlers log + setTimeout + exit
identically, so the order doesn't matter for correctness.

---

## 7. Forward-compat hooks

- **Redis adapter**: `withRateLimit` factory accepts a `store` param
  later. v1 omits — default in-memory.
- **Multi-instance**: when promotion happens, rate-limit and session
  storage both need shared backing. Out of scope.
- **Log transport**: Pino's default JSON on stdout is the production
  contract. Switch to a hosted shipper at the deployment layer
  (Datadog agent, Fluent Bit, etc.) without changing app code.
- **Metrics**: prometheus-style `/metrics` route is YAGNI for v1
  observability. Defer until logs are insufficient.

---

## 8. Testing

### 8.1 New tests

- `tests/rate-limit.test.ts` (new) — 4 tests: global default, chat
  per-user, auth per-IP, plaid per-user. Each fires `policy.max + 1`
  requests and asserts the last is 429 with `error: "rate_limit_exceeded"`.
- `tests/helmet.test.ts` (new) — 1 test: GET `/live` response includes
  `x-frame-options: DENY` and `content-security-policy`.
- `tests/health.test.ts` (existing) — extend to cover `/live` 200,
  `/ready` 200, `/ready` with DB disconnected → 503, `/health` alias.
- `tests/env.test.ts` (existing) — extend to test the new RESEND
  refine: production + missing key throws; production + real key passes;
  dev + missing key passes.
- `tests/logger.test.ts` (new) — 2 tests: `logInfo({ workspaceId }, "x")`
  produces a JSON line containing `workspaceId`; `logger` is silent in
  `NODE_ENV=test`.

### 8.2 Updated tests

- All cron tests (`cron.scheduler.test.ts`, `cron.jobs.*.test.ts`)
  assert at least one structured log event with `cron: <name>, event:
  "success"|"fail"|"protected_skip"`.
- Webhook tests (`plaid.webhook-dispatch.test.ts`) assert
  `dispatchWebhookSync` failures emit `logError` (mocked).
- Audit + chat + plaid tests that previously had no log assertions
  remain unchanged — switching from `console.*` to `logger.*` is
  observably the same to functional tests.

### 8.3 Smoke

Manual: after merge, deploy to a staging container with `LOG_LEVEL=info`
and:
- Hit `/live` — 200, JSON `{ status: "ok" }`.
- Hit `/ready` — 200, `HealthDTO`.
- Stop Postgres → hit `/ready` — 503.
- Fire 31 `POST /chat/threads/X/messages` as one user — 31st is 429
  with `rate_limit_exceeded`.
- Trigger a deliberate `throw` in a route — process exits with code 1
  after fatal log.

---

## 9. Risks and known limitations

### 9.1 Rate limit IP keying behind a proxy

If the app is deployed behind a load balancer / CDN, the immediate IP
is the proxy's. The rate-limit plugin reads `req.ip` which honours
Fastify's `trustProxy` option. Document in deployment notes: when
fronted by CloudFront / Vercel / etc., set `trustProxy: true` so X-Forwarded-For
is the source-of-truth.

### 9.2 Per-user rate limit on `chatMessages` requires an authed session

If `keyGenerator` can't extract a user id (cookie missing), it falls
back to IP. In practice every `POST /chat/threads/:tid/messages`
requires a session, so the fallback only fires on unauth requests
which return 401 before the rate-limit window matters. Acceptable.

### 9.3 Production-only env validation surprises

A missing `RESEND_API_KEY` in production now fails *startup*. The
operator must set the env var before the container boots. Document in
deployment runbook. Dev/test paths unchanged.

### 9.4 Pino's default stdout assumption

Containers must collect stdout to render JSON logs. If the deployment
uses a console TTY (interactive dev), JSON is harder to read. Set
`LOG_LEVEL=debug` and use `pino-pretty` in dev (devDependency) — add
to `pnpm dev:api` script: `node ... | pino-pretty`.

### 9.5 Cron observability via logs only

No external alerting on cron-skip events for v1. If a cron stops
running entirely, only log review catches it. Acceptable risk because
v1 is single-instance + actively monitored by the operator.

### 9.6 Multi-instance scaling drift

In-memory rate-limit state is per-process. Two API instances behind a
load balancer would let a user hit `2 × policy.max` per minute. v1 is
single-instance; flag for multi-instance migration.

### 9.7 Plaid webhook log volume

Plaid retries failed webhooks aggressively. The new `.catch(logError)`
will produce one error log per failed retry. If the underlying dispatch
is broken, log volume spikes. Acceptable — that's the signal we want.
Consider sampling later.

### 9.8 Test-DB connection limit

When `PRISMA_CONNECTION_LIMIT=10` and vitest singleFork runs 101 test
files sequentially, the same Prisma instance is reused. No contention.
For parallel tests (not enabled today) the limit would matter.

---

## 10. Success criteria

When this plan ships:

- `npm install` shows `@fastify/rate-limit` and `@fastify/helmet` in dependencies.
- `pnpm typecheck` passes across api/web/mobile/shared with the new
  shared exports.
- All 4 shared additions visible in `@fina/shared`:
  `rate_limit_exceeded`, `RATE_LIMITS`, `HealthDTO`, `LogContext`.
- `grep -rn 'console\.' apps/api/src/` returns only the one
  intentional dev-email fallback line in `email/send.ts`.
- Tests pass: existing 932 + ~10 new (rate-limit, helmet, health, env,
  logger).
- A production deployment without `RESEND_API_KEY` fails to boot with
  a clear error.
- `/live` always returns 200; `/ready` returns 503 if `prisma.$queryRaw\`SELECT 1\``
  fails.
- 31st `POST /chat/threads/:tid/messages` from one user in a minute
  returns 429 + `rate_limit_exceeded`.
- A deliberate `throw` in a route logs `fatal` then exits the process
  with code 1.
