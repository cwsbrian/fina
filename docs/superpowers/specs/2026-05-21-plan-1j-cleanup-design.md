# Plan 1J-cleanup — Design

**Date:** 2026-05-21
**Status:** Draft
**Pairs with:** [Plan 1H-hardening](2026-05-21-plan-1h-hardening-design.md) (production hardening that shipped at `31a1291`). 1J completes the cleanup batch that 1H explicitly deferred (§Out of scope) plus four follow-ups surfaced during the 1H paranoid review and one hotfix surfaced post-merge.

---

## 1. Goal

Close 8 small tech-debt items in a single coordinated plan so the Phase 1 codebase is consistent and free of the known foot-guns before Phase 2 dogfooding begins. Each item is independently testable and small (≤2 files of behavioral change apiece); bundling them avoids 8 separate plan-cycles.

### In scope (8 items)

| Code | Item | Source |
|---|---|---|
| **H** | `routes/plaid.ts:232` log key `workspace:` → `workspaceId` | 1H paranoid review |
| **E** | `TRUST_PROXY` default policy — strict opt-in (no NODE_ENV auto-true) | 1H paranoid review |
| **G** | Frontend `rate_limit_exceeded` handler in `apps/web` | 1H paranoid review |
| **F** | Migrate 7 `app.log.*` callsites in `routes/{invites,plaid,plaid-webhook}.ts` to singleton logger | 1H paranoid review |
| **C** | `findTransactions` date-range uses user tz (was UTC midnight) | 1H Out of scope |
| **D** | `detectRecurringMerchants` currency grouping bug — same merchant across currencies merges into one candidate | 1H Out of scope |
| **B** | Scheduled-spend resolved-row TTL cleanup hook | 1H Out of scope |
| **I** | Split `auth` rate-limit bucket: `authStrict` (5/min/IP, sign-in/up only) + `auth` (30/min/IP, get-session etc.) | 1H post-merge hotfix (`4108020` raised `auth` 5→30 as a stopgap) |

### Out of scope (deferred to future plans)

| Item | Why deferred |
|---|---|
| `1C-audit-http` — audit hooks on non-chat HTTP routes | Feature-shaped (not cleanup). Own plan. |
| `detectRecurringMerchants` cadence range (quarterly/yearly) + displayName stability | P1 polish — file a separate plan if needed. 1J handles the P0 currency bug only. |
| Other chat tools' tz fix (`listTransactions`, `getSpendingSummary`, etc.) | C limited to `findTransactions` for blast control. Other tools follow the same pattern but in a follow-up plan once C is verified. |
| Redis-backed rate-limit, multi-instance scaling, metrics endpoint | Inherited "out of scope" from 1H §1. |

---

## 2. Shared library touchpoints

Per CLAUDE.md "When writing a design spec" — every spec lists what the feature uses from `@fina/shared` and what new shared exports it creates.

### Uses (existing shared)

- `RATE_LIMITS`, `RateLimitKey` (`libs/shared/src/constants.ts`) — I expands the union.
- `ApiError`, `isApiError`, `ApiErrorCode` (`libs/shared/src/errors.ts`) — G's frontend handler matches on `code === "rate_limit_exceeded"` exhaustively.
- `LogContext` (`libs/shared/src/logging.ts`) — F's logger migration narrows the new call sites.
- `DEFAULT_TZ` (`libs/shared/src/constants.ts`) — C's tz fallback chain.
- `resolveUserTz`, `localMidnightToUtc` (`apps/api/src/chat/tools/periods.ts`) — C's day-boundary computation. (Lives in API today; consider promoting later if web/mobile need tz math.)

### Adds (new shared)

One addition lands in its own commit BEFORE any API code references it (Task 0).

**`RATE_LIMITS.authStrict` (new key in `libs/shared/src/constants.ts`)**

```ts
export const RATE_LIMITS = {
  globalDefault: { max: 60, windowMs: 60_000 },
  chatMessages: { max: 30, windowMs: 60_000 },
  /** Credential-stuffing protection — sign-in / sign-up only. 5 attempts per
   *  minute per IP is realistic for humans and slows automated guessing to
   *  near-zero throughput. */
  authStrict: { max: 5, windowMs: 60_000 },
  /** All other /api/auth/* paths (get-session, list-sessions, sign-out, etc.).
   *  30/min/IP accommodates Better Auth's get-session polling fired on every
   *  page load by the web client. */
  auth: { max: 30, windowMs: 60_000 },
  plaidExchange: { max: 5, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;
```

`RateLimitKey` union auto-extends from 4 → 5 keys. Existing `withRateLimit("auth")` callers continue to work (now resolves to 30/min — already shipped as a hotfix on `4108020`). New `withRateLimit("authStrict")` will be wired by Task 8.

No new DTOs. No new schemas. No new error codes. No new helpers in `@fina/shared/format/`.

### Adds (apps/api only — not shared)

- New env key `SCHEDULED_SPEND_TTL_DAYS` in `apps/api/src/env.ts` (z.coerce.number().int().positive().optional()) with use-site default `?? 90`. Pattern matches existing `CRON_EVENT_TTL_DAYS` from 1C. apps/api-internal — no shared lib change.

---

## 3. Architecture

Each task is a self-contained commit. Order (smallest → largest blast radius) is chosen so that early commits land safe wins quickly and the riskier reshuffles (D, B, I) come after the codebase is already on the new logger / tz patterns:

```
Task 0 — shared:    RATE_LIMITS.authStrict + auth rename comment
Task 1 — H:         log key spelling fix
Task 2 — E:         TRUST_PROXY policy tightening
Task 3 — G:         frontend 429 handler
Task 4 — F:         app.log → singleton logger sweep
Task 5 — C:         findTransactions tz
Task 6 — D:         detectRecurringMerchants currency grouping
Task 7 — B:         scheduled-spend TTL cleanup
Task 8 — I:         auth bucket split (consumes Task 0's authStrict)
```

No task depends on a task more than 2 positions back. Task 0 is the only cross-app commit (shared lib); everything else lives in `apps/api` or `apps/web`.

### 3.1 H — log key spelling (Task 1)

`apps/api/src/routes/plaid.ts:232` currently logs `{ workspace: "..." }`. Per the `LogContext` schema in `@fina/shared`, the reserved key is `workspaceId`. Rename. One file, one line.

### 3.2 E — TRUST_PROXY default policy (Task 2)

Current (`apps/api/src/env.ts` after 1H):

```ts
.transform((e) => ({
  ...e,
  TRUST_PROXY: e.TRUST_PROXY ?? e.NODE_ENV === "production",
}));
```

This silently flips `trustProxy: true` whenever `NODE_ENV=production`. If the production deploy is **not** behind a CDN/LB that strips client-set `X-Forwarded-For`, an attacker can spoof `X-Forwarded-For: 1.2.3.4` and rotate rate-limit buckets / pollute audit IPs.

New behavior: **no default** — `TRUST_PROXY` must be explicitly set to `true` or `false`. Production startup with unset `TRUST_PROXY` is an `Invalid environment` error.

```ts
TRUST_PROXY: z.preprocess(
  (v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
  z.boolean(),
),
```

No transform on TRUST_PROXY. `.env.example` clearly states "must be set; use `true` only behind a CDN that overwrites X-Forwarded-For from clients, otherwise `false`".

Test/dev `.env` files in the repo set `TRUST_PROXY=false` so the rest of the suite keeps building. The buildApp test fixture (already passes `TRUST_PROXY: false`) is unaffected.

### 3.3 G — frontend `rate_limit_exceeded` handler (Task 3)

When `apiFetch` throws an `ApiError` with `code === "rate_limit_exceeded"`, surface a localized toast: "잠시 후 다시 시도해 주세요 (Xs 후)". The X is parsed from the message field (`Rate limit exceeded. Retry in 28s.` → `28`); if parsing fails, omit the duration.

Implementation site: `apps/web/src/lib/api.ts` (or wherever `apiFetch` is constructed). Use the existing toast system (sonner / Radix; check what's in repo). No new shared additions — `isApiError(e) && e.code === "rate_limit_exceeded"` is the discriminant.

Mobile is deferred — `apps/mobile`'s error handling is shared with web via `@fina/shared`'s `ApiError`, but the toast UI is per-app. Mobile keeps its current generic error display.

### 3.4 F — `app.log.*` → singleton logger sweep (Task 4)

7 callsites in `apps/api/src/routes/{invites.ts, plaid.ts, plaid-webhook.ts}`. Each becomes a singleton-logger call (`logInfo|Warn|Error` from `apps/api/src/logger.ts`) with the appropriate `LogContext` keys.

Why singleton (not `req.log`)? Consistency with the cron / chat / audit migration done in 1H T8/T10. The single source of truth pattern is what 1H established; F finishes the job. `req.log`'s automatic `reqId` correlation is a nice-to-have but `LogContext` already supports `requestId` if a future commit decides to thread it explicitly.

### 3.5 C — `findTransactions` tz (Task 5)

`apps/api/src/chat/tools/find-transactions.ts:168-169` currently:

```ts
if (args.start_date) occurredAt.gte = new Date(`${args.start_date}T00:00:00.000Z`);
if (args.end_date) occurredAt.lte = new Date(`${args.end_date}T23:59:59.999Z`);
```

The user's `Transaction.occurredAt` is stored as a UTC instant whose date-portion-in-user-tz is the day the user perceives. Querying with UTC midnight misses up to 9–14 hours of transactions on either side for far-east / far-west users.

Fix:

```ts
const tz = await resolveUserTz(ctx.userId);
if (args.start_date) {
  const [y, m, d] = args.start_date.split("-").map(Number);
  occurredAt.gte = localMidnightToUtc(y!, m!, d!, tz);
}
if (args.end_date) {
  const [y, m, d] = args.end_date.split("-").map(Number);
  // exclusive upper bound: start of next day in tz
  const next = new Date(localMidnightToUtc(y!, m!, d!, tz).getTime() + 24 * 60 * 60 * 1000);
  occurredAt.lt = next;
}
```

Switches from `lte` to `lt` for the upper bound (cleaner — no `.999ms` magic). Existing call sites that pass `endDate` won't care; result set is identical for users in UTC and shifts by the tz offset for non-UTC users.

DST edge: `localMidnightToUtc` is already DST-aware (used by `lookbackMonthStart`). The `+24h` step on the upper bound is fine because the result is converted back through `localMidnightToUtc`'s tz math implicitly via the source instant comparison.

### 3.6 D — `detectRecurringMerchants` currency grouping (Task 6)

`apps/api/src/chat/tools/detect-recurring-merchants.ts:137`: `const key = merchantKey;` — merchant key has no currency component, so USD and CAD transactions from the same merchant fold into one Candidate. Worse, line 204 hardcodes `currency: workspace.currency` for the result, regardless of the transactions' actual currency.

Fix:

```ts
// Add currency to the select
const rows = await prisma.transaction.findMany({
  where: { ... },
  select: { id: true, amount: true, currency: true, merchantRaw: true, merchantNormalized: true, occurredAt: true },
  ...
});

// Group key includes currency
const key = `${merchantKey}|${r.currency ?? workspace.currency}`;

// Result uses the group's currency, not workspace.currency
const groupCurrency = g.currency; // captured at group creation
```

Group struct gains a `currency: string` field, populated from the first row's currency (all rows in the group share it by construction). The result Candidate's `currency` field reports that. The workspace.currency lookup stays as a fallback for transactions where `Transaction.currency` is `null` (Plaid sometimes returns null on certain item types).

Tests: add a USD + CAD same-merchant fixture, assert two Candidates.

### 3.7 B — Scheduled-spend resolved TTL (Task 7)

`apps/api/src/cron/jobs/cleanup-events.ts` currently deletes old `plaid_webhook_events` rows. Add a sibling query in the same job:

```ts
// In cleanup-events.ts after the existing plaid_webhook_events delete:
const scheduledSpendCutoff = new Date(Date.now() - (env.SCHEDULED_SPEND_TTL_DAYS ?? 90) * 24 * 60 * 60 * 1000);
const ssDeleted = await prisma.scheduledSpend.deleteMany({
  where: {
    status: { in: ["resolved-matched", "resolved-dismissed"] },
    resolvedAt: { lt: scheduledSpendCutoff, not: null },
  },
});
logInfo({ cron: CRON_NAME, deletedScheduledSpends: ssDeleted.count }, "cleanup-events scheduled-spend pass");
```

`ScheduledSpend.resolvedAt` must be set when the row transitioned to a resolved status — check the existing scheduled-spend-match job to confirm. If not, this fix needs that field populated first; verify before Task 7 begins.

Why the existing `cleanup-events` cron (not a new one)? Same cleanup-on-schedule semantics, low frequency (daily 3am UTC), no need for a separate timer.

No new env key in `env.ts` Schema — `SCHEDULED_SPEND_TTL_DAYS` is added as `z.coerce.number().int().positive().optional()` with use-site default 90. Matches existing `CRON_EVENT_TTL_DAYS` pattern.

### 3.8 I — Auth bucket split (Task 8)

`apps/api/src/server.ts:89` registers a single catch-all `app.all("/api/auth/*", { config: withRateLimit("auth") }, handler)`. After Task 0, `auth` means 30/min/IP (already on main from hotfix). To restore credential-stuffing protection on sign-in/sign-up specifically, register two more specific routes BEFORE the catch-all:

```ts
const betterAuthHandler = async (req, reply) => { /* existing fetch-bridge */ };

app.all("/api/auth/sign-in/*", { config: withRateLimit("authStrict") }, betterAuthHandler);
app.all("/api/auth/sign-up/*", { config: withRateLimit("authStrict") }, betterAuthHandler);
app.all("/api/auth/*",          { config: withRateLimit("auth")       }, betterAuthHandler);
```

Fastify's route matching: more-specific patterns (`/api/auth/sign-in/*`) beat less-specific (`/api/auth/*`) for the same method. **Verify this empirically in Task 8** — if matching priority is unstable, fall back to a single catch-all with an inline URL check that calls `reply.context.skipRateLimit` for known-read paths (but the per-route option is cleaner and is the recommended approach in Fastify docs).

Handler extraction: the existing 33-line fetch bridge inside the catch-all moves into a named function `makeBetterAuthHandler(auth, env)` returning a Fastify handler, so the three routes share it without duplication.

Test:
- 6th request to `/api/auth/sign-in/email` from same IP → 429 (authStrict 5/min)
- 31st request to `/api/auth/get-session` from same IP → 429 (auth 30/min)
- 6th `/api/auth/sign-in/...` does NOT count against `auth` bucket and vice-versa

---

## 4. Testing strategy

Every task follows TDD: failing test → implementation → green test. Test surface per task:

| Task | New / modified tests |
|---|---|
| 0 (shared) | None — types-only. Typecheck is the test. |
| 1 (H) | None — log key spelling. Visual inspection of one line. |
| 2 (E) | `apps/api/tests/env.test.ts` — add: prod with unset TRUST_PROXY throws, prod with `TRUST_PROXY=false` accepts. Remove the "defaults to true in prod" assertion (no longer defaults). |
| 3 (G) | `apps/web/src/lib/api.test.ts` — given a 429 response with shape `{error:"rate_limit_exceeded", message:"... Retry in 28s."}`, the toast subscriber is called with the localized text. Use vitest + a mock toast. |
| 4 (F) | Each modified route file's existing test runs unchanged; logger spies if any. No new tests. |
| 5 (C) | `apps/api/tests/chat.tools.find-transactions.test.ts` — fixture: user with `tz="Asia/Seoul"`, transaction at `occurredAt = 2026-03-31T15:30Z` (which is `2026-04-01T00:30 KST`). With `start_date="2026-04-01"`, OLD impl excludes (UTC midnight boundary), NEW impl INCLUDES (KST midnight boundary). Assert the row appears in the result. Second case: `occurredAt = 2026-04-01T15:30Z` (`2026-04-02T00:30 KST`) with `end_date="2026-04-01"` — OLD includes (UTC 04-01T23:59 boundary), NEW excludes (KST day rolled to 04-02). Assert NOT in result. |
| 6 (D) | `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts` — USD + CAD same-merchant fixture, assert two Candidates with distinct currencies. |
| 7 (B) | `apps/api/tests/cron.cleanup-events.test.ts` — seed a `resolved-matched` ScheduledSpend with `resolvedAt = now - 91 days`, run job, assert deleted. Seed one with `resolvedAt = now - 30 days`, assert NOT deleted. |
| 8 (I) | `apps/api/tests/rate-limit.test.ts` — split the existing "auth bucket" test into two: (a) sign-in 6th = 429 (authStrict), (b) get-session 31st = 429 (auth). |

Full suite must pass at each commit boundary.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| C: KST/non-UTC users see different findTransactions results than before. Confusing? | Medium | The new behavior matches user-intent ("April 1 transactions" = "April 1 in my timezone"). Document in the chat tool's `describe` field. The other tz-affected tools (listTransactions, etc.) are explicitly out of scope to limit blast. |
| D: Existing users have multi-currency merchants where the old behavior bundled them — result shape now shows two rows instead of one. | Low | Acceptable correction; the old "single row with wrong currency" was a bug. No DB migration needed (read-side fix). |
| I: Fastify route matching may not actually prefer `/api/auth/sign-in/*` over `/api/auth/*`. | Low–Medium | Verify with an integration test before relying on it. Fallback: skip-rate-limit inside the catch-all. |
| B: ScheduledSpend.resolvedAt might not be populated on all `resolved-*` rows. | Medium | Audit the scheduled-spend-match cron + dismiss handler before Task 7. If missing, add a `WHERE resolvedAt IS NOT NULL` guard so unfixed rows are NEVER deleted — they need a migration first, deferred to a follow-up. |
| E: Existing prod deploys with implicit `TRUST_PROXY=true` (via NODE_ENV=production) suddenly require explicit env. | High at deploy time | Document in commit message + .env.example. The 1H hotfix has not yet been deployed to prod — the cutover window is ours. |

---

## 6. Success criteria

After all 9 commits land and merge to main:

- `grep -n "workspace:" apps/api/src/routes/plaid.ts` returns 0 matches (H fixed).
- `loadEnv` with `NODE_ENV=production` and unset `TRUST_PROXY` throws (E fixed).
- A 429 response in `apps/web` triggers a localized toast in dev (G fixed).
- `grep -rn 'app\.log\.' apps/api/src/routes/` returns 0 matches outside `apps/api/src/server.ts` (F fixed).
- A KST user's `findTransactions(start_date="2026-04-01")` includes a transaction at `2026-04-01T01:00 KST` (C fixed).
- USD + CAD same-merchant transactions yield 2 Candidates from `detectRecurringMerchants` (D fixed).
- `cleanup-events` cron deletes `resolved-*` ScheduledSpends older than 90 days (B fixed).
- 6th sign-in attempt from same IP = 429, but 6th get-session call = 200 (I fixed).
- All `pnpm --filter @fina/api exec vitest run` tests pass (≥952 today).
- `tsc --noEmit` clean across `@fina/shared`, `@fina/api`, `@fina/web`.

---

## 7. Open questions

None at design time. Brainstorming resolved all scope ambiguities. Items deferred to other plans are listed in §1 Out of scope.

---

## 8. Follow-ups (post-1J)

- Cadence range expansion + displayName stability for `detectRecurringMerchants` (D's P1 items).
- Other chat tools' tz fix (listTransactions, getSpendingSummary, getTransactionDetails, etc.). Single plan after 1J's findTransactions pattern is proven.
- `1C-audit-http` — audit hooks on non-chat HTTP routes.
- Promote `resolveUserTz` / `localMidnightToUtc` to `@fina/shared` if web/mobile ever need tz math.
- Mobile `rate_limit_exceeded` toast (parallel to G).
