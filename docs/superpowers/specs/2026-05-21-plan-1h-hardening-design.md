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

## 2. Shared library touchpoints

Per CLAUDE.md "When writing a design spec" — every spec lists what
the feature uses from `@fina/shared` and what new shared exports it
creates.

### Uses (existing shared)

- `ApiError`, `ApiErrorCode`, `isApiError` — for the 429 rate-limit
  response and any future code-matching frontend handlers.
- `MeDTO` (no change) — unchanged but verifying that login → me path
  still works after env validation tightens.

### Adds (new shared)

Four additions land **before** any API-side code, in their own commit:

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
  /** Nullable because post-Plan-2 `ChatThread.workspaceId` is `String?` —
   *  unbound threads log `null`. */
  workspaceId?: string | null;
  /** Chat / LLM */
  threadId?: string;
  tool?: string;
  /** Cron */
  cron?: string;
  event?: "start" | "protected_skip" | "success" | "fail";
  durationMs?: number;
  /** Plaid */
  plaidEvent?: string;
  plaidItemId?: string;
  /** Audit log linkage */
  auditAction?: string;
  /** Error context. Pino accepts Error directly (serializes message +
   *  stack); pass other shapes if no Error is available. */
  err?: Error | unknown;
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
helper `withRateLimit(key: RateLimitKey)` in `src/auth/rate-limit.ts`.

**Session id extraction is async** (Better Auth's `getSession` returns
a Promise). Two equivalent options — the implementation plan picks
one and sticks with it:

**Option A (preferred)** — a Fastify `onRequest` hook resolves the
session and decorates `req.userId` BEFORE rate-limit runs. The
`keyGenerator` then reads `req.userId` synchronously:

```ts
// auth/session-decorator.ts
app.addHook("onRequest", async (req) => {
  try {
    const s = await app.fina.auth.api.getSession({ headers: buildHeaders(req) });
    if (s?.user) (req as any).userId = s.user.id;
  } catch { /* leave undefined; route auth handles */ }
});
```

**Option B** — `keyGenerator` itself is async (the plugin accepts
`string | Promise<string>`). Skip the decorator, but every keyed
route pays the session-lookup cost twice (once for the limiter, once
for `requireSession`). Plan-phase picks A unless there's a reason.

```ts
import { RATE_LIMITS, type RateLimitKey } from "@fina/shared";

const userKey = (req: FastifyRequest): string =>
  (req as { userId?: string }).userId ?? `ip:${req.ip}`;
const ipKey = (req: FastifyRequest): string => `ip:${req.ip}`;

export function withRateLimit(key: RateLimitKey) {
  const policy = RATE_LIMITS[key];
  return {
    rateLimit: {
      max: policy.max,
      timeWindow: policy.windowMs,
      keyGenerator:
        key === "chatMessages" || key === "plaidExchange" ? userKey : ipKey,
    },
  };
}
```

On unauth requests `userKey` falls back to IP — fine because the
route itself returns 401 before the limit window matters.

**Test environment**: skip plugin registration entirely when
`process.env.NODE_ENV === "test" && process.env.RATE_LIMIT_TEST !== "1"`.
Rate-limit integration tests set `RATE_LIMIT_TEST=1` in their env
block to opt in. Avoids the `skipOnError` / `max: Infinity` ambiguity
flagged by R1.

`env.ts` adds `RATE_LIMIT_TEST: z.string().optional()` so the zod
validator doesn't reject the opt-in env.

**Hook registration order matters.** Fastify executes `onRequest`
hooks in registration order. The session-decorator hook MUST be
registered before `app.register(rateLimit, ...)` so `req.userId` is
populated when the plugin's own `onRequest` evaluates the
`keyGenerator`. Document this in `server.ts` with a one-line comment
at the registration site.

### 3.3 Helmet (`server.ts`)

Default Helmet config plus:
- `contentSecurityPolicy: { directives: { "default-src": ["'none'"] } }` — API
  serves no HTML; null CSP is safe and strictest.
- `crossOriginResourcePolicy: { policy: "same-site" }`.
- `frameguard: { action: "deny" }`.

### 3.4 Health routes (`routes/health.ts`)

Three routes, all unauthenticated:
- `GET /live` — returns `{ status: "ok" }` with 200, always.
- `GET /ready` — runs `prisma.$queryRaw\`SELECT 1\`` with a 1s timeout.
  Prisma doesn't accept an `AbortSignal`, so the timeout is a manual
  `Promise.race`:

  ```ts
  const dbCheck = Promise.race([
    prisma.$queryRaw<[{ "?column?": number }]>`SELECT 1`,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("db_timeout")), 1000),
    ),
  ]);
  try {
    await dbCheck;
    return reply.code(200).send({ status: "ok", checks: { db: "ok" } });
  } catch {
    return reply.code(503).send({ status: "degraded", checks: { db: "down" } });
  }
  ```

  On success returns `HealthDTO` with `checks.db: "ok"` and 200. On
  failure returns the same DTO with `checks.db: "down"` and 503.
- `GET /health` — alias for `/ready` (back-compat for existing LB
  configs). Current `routes/health.ts` returns `{ status: "ok" }`
  unconditionally with 200; the alias preserves that shape on success
  paths (since `/ready` returns 200 + `{ status: "ok", checks: { db: "ok" } }`)
  while adding the failure path (503 + `{ status: "degraded", checks: { db: "down" } }`).
  Downstream LBs that string-match `"status":"ok"` keep working;
  LBs that check 200 vs 503 also keep working.

### 3.5 Process handlers (`main.ts`)

```ts
process.on("unhandledRejection", (reason) => {
  logFatal({ err: reason }, "unhandled_rejection");
  // pino-bound flush is deterministic; fall back to a short timeout
  // if logger.flush isn't available on this transport.
  logger.flush(() => process.exit(1));
});
process.on("uncaughtException", (err) => {
  logFatal({ err }, "uncaught_exception");
  logger.flush(() => process.exit(1));
});
```

Existing `SIGTERM` graceful shutdown stays. In-flight requests are
dropped (see §9.9 — intentional for uncaught state).

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
  (e) => {
    if (e.NODE_ENV !== "production") return true;
    if (!e.RESEND_API_KEY) return false;
    // Real Resend keys are "re_" + 24 random chars (~27 total).
    // 24 is the floor — rejects the doc placeholder "re_..." (6 chars),
    // any "re_dev_*" stub, and most paste-error truncations.
    return e.RESEND_API_KEY.startsWith("re_") && e.RESEND_API_KEY.length >= 24;
  },
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

**`protect` event capture** — croner's `protect: true` (boolean) is a
silent skip; to be notified of skip events we MUST pass a callback:

```ts
new Cron("5 9 * * *", {
  name: "scheduled-spend-match",
  protect: (job) =>
    logWarn({ cron: job.name, event: "protected_skip" },
            "cron skipped — previous run still in flight"),
}, runScheduledSpendMatch);
```

Every existing `new Cron(...)` in `scheduler.ts` migrates from
`protect: true` → the callback form. Behavioural impact: previously
silent skips now emit a `warn` log line; no other change.

### 3.9 Plaid webhook silent error (`routes/plaid-webhook.ts`)

Only the silent `.catch(() => {})` on the dispatch fire-and-forget is
replaced (current location ~line 67 — implementer should grep
`.catch(() => {})` in `routes/plaid-webhook.ts` to confirm). Any
nearby `.catch((e) => { /* log already */ })` blocks are left as-is.

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

`grep -rn 'console\.' apps/api/src/` reports ~32 lines at spec time.
The implementer MUST re-run the grep at task start and migrate every
match. The file list below is illustrative, NOT authoritative — file
names and line numbers will drift.

Known clusters:
- `audit/service.ts` (1× error)
- `cron/scheduler.ts` (3× warn/error) — emit `{ cron, event, err }`
- `cron/jobs/daily-refresh.ts` (multiple)
- `cron/jobs/retry-unprocessed.ts` (multiple) — note file name has no
  `-events` suffix
- `cron/jobs/cleanup-events.ts`
- `cron/jobs/scheduled-spend-match.ts`
- `chat/turn.ts` (a handful)
- `chat/dispatcher.ts`
- `routes/chat.ts` (auto-title trigger paths)
- `chat/auto-title.ts`
- `plaid/sync.ts`, `plaid/webhook-dispatch.ts`, `plaid/webhook-backfill.ts`, `plaid/webhook-item.ts`
- `categorize/service.ts`
- `main.ts` (process-handler bootstrap — these are the new fatal logs added by §3.5)

The lone surviving `console.log` is the dev-mode email fallback in
`email/send.ts`. It writes magic links to stdout when
`RESEND_API_KEY` is unset. Marked with an inline comment explaining
the exception so a future audit sweep doesn't drag it in.

---

## 5. Data flow

No model changes. No new tables. Behaviour additions:
- Request → Helmet adds headers → Rate-limit may reject 429 → Route handler.
- Cron tick → croner protect-check → if running, logger.warn skip; else
  logger.info start → job → logger.info/error end.
- Plaid webhook → JWKS verify (unchanged) → respond 200 immediately →
  fire-and-forget dispatch with logger-bound `.catch`.
- Process crash → handler logs fatal → `logger.flush(cb)` → exit 1.

---

## 6. Concurrency + correctness

### 6.1 Rate limit per-user keying race

Under Option A (§3.2), session resolution runs in an `onRequest` hook
BEFORE `@fastify/rate-limit` fires its `keyGenerator`. By the time
`keyGenerator` reads `req.userId`, the async session lookup has
completed (or thrown into the catch, leaving `req.userId`
undefined). Result: `keyGenerator` is a sync function reading a
plain string — no race window. If the cookie is missing/invalid,
the plugin falls back to IP. No user can ever route to another
user's bucket because keys are namespaced by route + key family.

### 6.2 Logger initialisation

The Pino instance is constructed at module load. Fastify reuses it via
`buildApp({ logger })`. Test environments set `level: "silent"` to avoid
log noise in `vitest run` output.

Tests that assert on log shape — `tests/logger.test.ts` + the cron
tests that check `event: "success" | "protected_skip"` — use Pino's
built-in `multistream` with an in-memory `Writable` rather than a
new devDependency:

```ts
import { Writable } from "node:stream";
const lines: string[] = [];
const sink = new Writable({
  write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
});
const testLogger = pino({ level: "info" }, sink);
// assertions read JSON.parse(lines[0]) etc.
```

No new devDependency required.

### 6.3 Health `/ready` DB-ping leak

`SELECT 1` is wrapped in a 1-second `Promise.race` timeout (see §3.4
for the snippet — Prisma doesn't accept `AbortSignal`). A hung DB
doesn't pile up requests in the readiness probe path; the racing
`setTimeout` rejects and the handler returns 503.

### 6.4 Process handler ordering

`unhandledRejection` fires before `uncaughtException` for promise
rejections that surface as throws. Both handlers log + flush + exit
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
  per-user, auth per-IP, plaid per-user. Each test sets
  `process.env.RATE_LIMIT_TEST = "1"` BEFORE `buildApp` so the plugin
  registers. Sequential `inject` calls fire `policy.max + 1` requests
  (same session cookie for user-keyed routes); assert the last is
  429 with `error: "rate_limit_exceeded"`. For chat-per-user, reuse
  the existing `signUpAndGetCookie` helper from
  `tests/helpers/auth.ts` (it already extracts a real session
  cookie via Better Auth).
- `tests/helmet.test.ts` (new) — 1 test: GET `/live` response includes
  `x-frame-options: DENY` and `content-security-policy`.
- `tests/health.test.ts` (existing) — extend to cover `/live` 200,
  `/ready` 200, `/ready` with DB disconnected → 503, `/health` alias.
  The DB-disconnect path uses `vi.spyOn(prisma, "$queryRaw")` to
  throw a synthetic error — simulates a DB-down condition without
  actually closing the connection (which would break other tests
  under vitest singleFork).
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
Fastify's `trustProxy` option. `server.ts` reads `TRUST_PROXY` from
env (default `false` in dev / `true` in production via NODE_ENV)
so IP keying is correct from day one of the first prod deploy. Without
this, all requests behind the CDN share a single IP-keyed bucket.
`env.ts` gains `TRUST_PROXY: z.coerce.boolean().optional()`.

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

### 9.9 Process exit drops in-flight requests

`unhandledRejection` / `uncaughtException` handlers exit with code 1
after `logger.flush(cb)` resolves. Any active Fastify request is dropped
mid-flight. This is intentional — uncaught errors mean the process
is in an unknown state and continuing to serve traffic could corrupt
data. Health probes notice the dead pod and re-route. Documented here
so a reviewer doesn't propose `app.close()` integration.

### 9.10 Logger PII

`LogContext` carries `userId` + `workspaceId` on every keyed log
line. These are stable internal cuids (not email or other PII) and
match the values already written to `audit_events`. Safe to ship to
external log aggregators under the same redaction policy as audit
data. Email, password, raw merchant strings, and Plaid access tokens
must never be logged — enforced by code review, not by the type.

### 9.11 Helmet CSP impact

The API serves no HTML, so `default-src 'none'` is safe for the API's
own responses. `crossOriginResourcePolicy: "same-site"` is the right
default for production where api + web share the parent domain
(`api.fina.app` ↔ `fina.app`). Dev environments running web on a
different origin (Tailscale + LAN port) already rely on `cors` with
`DEV_ORIGINS` allowing the dev hosts — the CORP header doesn't block
JSON fetches, only resource embedding, so XHR continues to work.

---

## 10. Success criteria

When this plan ships:

- `pnpm list --filter @fina/api @fastify/rate-limit @fastify/helmet`
  shows both packages installed.
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
- 31st sequential `POST /chat/threads/:tid/messages` (same session
  cookie) from one user inside a 60-second window returns 429 +
  `rate_limit_exceeded`.
- A deliberate `throw` in a route logs `fatal` then exits the process
  with code 1.
