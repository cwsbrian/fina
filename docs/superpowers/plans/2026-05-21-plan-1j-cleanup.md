# Plan 1J-cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 8 small tech-debt items in one coordinated plan so the Phase 1 codebase is consistent and free of known foot-guns before Phase 2 dogfooding.

**Architecture:** Nine task-commits, smallest blast radius first. Task 0 lands a `@fina/shared` addition (`RATE_LIMITS.authStrict`) per CLAUDE.md "shared first" rule. Tasks 1-7 are isolated apps/api or apps/web edits. Task 8 consumes Task 0's shared addition to wire the new strict bucket onto the Better Auth sign-in/sign-up paths.

**Tech Stack:** Fastify 5, Prisma 5, Pino 9, Zod 3, croner, Better Auth, `@fina/shared`. Web: Next.js 15, React 18, sonner (new). Tests: Vitest singleFork, real Postgres at port 5433.

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-21-plan-1j-cleanup-design.md`. Authoritative. Re-read §3.<task-letter> before each task.
- **Working dir:** `/home/cwsbr/personal/fina` (or a worktree off `main` if using subagent-driven-development).
- **Worktree convention:** Per established pattern (plans 1H, 1C-*, 2-chat-user-scope), implementation runs in `.worktrees/plan-1j-cleanup` branched off `main`. The `using-git-worktrees` skill handles this at execution time.
- **Test command:** `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>`.
- **CLAUDE.md rule:** every `@fina/shared` addition ships in its own commit BEFORE any API/web/mobile consumer. Task 0 enforces this.
- **Memory rule:** `vi.spyOn(prisma, "$queryRaw")` (and any Prisma delegate property) is **FORBIDDEN**. Use manual save/restore. See commit `3ecc538`.

## File map

| File | Action | Task |
|---|---|---|
| `libs/shared/src/constants.ts` | Modify — add `authStrict` to `RATE_LIMITS`, update `auth` comment | T0 |
| `apps/api/src/routes/plaid.ts:232` | Modify — `workspace:` → `workspaceId:` | T1 |
| `apps/api/src/env.ts` | Modify — `TRUST_PROXY` strict opt-in | T2 |
| `apps/api/tests/helpers/test-env.ts` | Create — `testEnv()` helper | T2 |
| `apps/api/tests/env.test.ts` | Modify — update TRUST_PROXY tests | T2 |
| `apps/api/tests/**/*.test.ts` | Modify — migrate ~48 fixtures to `testEnv()` | T2 |
| `.env.example` | Modify — `TRUST_PROXY=` → `TRUST_PROXY=false`; add explanation | T2 |
| `apps/web/package.json` + lockfile | Modify — add `sonner` | T3 |
| `apps/web/src/app/layout.tsx` | Modify — mount `<Toaster />` | T3 |
| `apps/web/src/lib/api.ts` | Modify — `rate_limit_exceeded` toast in `apiFetch` catch | T3 |
| `apps/web/src/lib/api.test.ts` | Create — verify toast fires on 429 | T3 |
| `apps/api/src/routes/invites.ts` | Modify — 2 `app.log.*` → singleton logger | T4 |
| `apps/api/src/routes/plaid.ts` | Modify — 3 `app.log.*` → singleton logger | T4 |
| `apps/api/src/routes/plaid-webhook.ts` | Modify — 2 `app.log.*` → singleton logger | T4 |
| `apps/api/src/chat/tools/find-transactions.ts` | Modify — use tz-aware date math | T5 |
| `apps/api/tests/chat.tools.find-transactions.test.ts` | Modify — add KST tz fixture | T5 |
| `apps/api/src/chat/tools/detect-recurring-merchants.ts` | Modify — currency grouping via `account` join | T6 |
| `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts` | Modify — add multi-currency fixture | T6 |
| `apps/api/src/cron/jobs/cleanup-events.ts` | Modify — add ScheduledSpend TTL deletion | T7 |
| `apps/api/src/env.ts` | Modify (again) — add `SCHEDULED_SPEND_TTL_DAYS` | T7 |
| `apps/api/tests/cron.cleanup-events.test.ts` | Modify — assert ScheduledSpend cleanup | T7 |
| `apps/api/src/server.ts` | Modify — extract `makeBetterAuthHandler` + split routes | T8 |
| `apps/api/tests/rate-limit.test.ts` | Modify — split auth test into strict + read | T8 |

---

## Task 0: `@fina/shared` — `RATE_LIMITS.authStrict`

**Goal:** Add the `authStrict` rate-limit key (5/min/IP) to the shared `RATE_LIMITS` table BEFORE any API code references it. Existing `auth` (30/min/IP) is updated only with a comment; no value change (the 5→30 hotfix at `4108020` already shipped).

**Files:**
- Modify: `libs/shared/src/constants.ts`

- [ ] **Step 0.1: Update `RATE_LIMITS`**

In `libs/shared/src/constants.ts`, locate the `RATE_LIMITS` block (~line 24) and replace the `auth` entry with two entries:

```ts
export const RATE_LIMITS = {
  /** Default for any route without an explicit override. Keyed by IP. */
  globalDefault: { max: 60, windowMs: 60_000 },
  /** Heaviest cost — guards LLM token spend. Keyed by user id. */
  chatMessages: { max: 30, windowMs: 60_000 },
  /** Credential-stuffing protection — sign-in / sign-up only. 5 attempts per
   *  minute per IP is realistic for humans and slows automated guessing to
   *  near-zero throughput. Wired by server.ts onto /api/auth/sign-in/* and
   *  /api/auth/sign-up/* (Plan 1J Task 8). */
  authStrict: { max: 5, windowMs: 60_000 },
  /** All other /api/auth/* paths (get-session, list-sessions, sign-out, etc.).
   *  30/min/IP accommodates Better Auth's get-session polling fired on every
   *  page load by the web client. 5/min was too tight — a logged-in user
   *  would hit 429 after ~5 page navigations. (Was 5/min in plan 1H; raised
   *  to 30 in hotfix 4108020 and reaffirmed here as the long-term value.) */
  auth: { max: 30, windowMs: 60_000 },
  /** Plaid Link callback / re-exchange. Keyed by user id. */
  plaidExchange: { max: 5, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;
```

Order: `globalDefault, chatMessages, authStrict, auth, plaidExchange`. `authStrict` listed before `auth` so readers see the stricter sibling first.

- [ ] **Step 0.2: Typecheck shared lib**

```bash
pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json
```

Expected: no output (success).

- [ ] **Step 0.3: Typecheck apps/api (consumer)**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: no output. `withRateLimit("auth")` in `apps/api/src/server.ts` and `withRateLimit("plaidExchange")` in `apps/api/src/routes/plaid.ts` still typecheck — the union expanded but didn't shrink.

- [ ] **Step 0.4: Commit**

```bash
git add libs/shared/src/constants.ts
git commit -m "feat(@fina/shared): add RATE_LIMITS.authStrict (5/min/IP)

Splits the credential-stuffing protection out of the broad /api/auth/*
bucket. Task 8 will wire authStrict onto /api/auth/sign-in/* and
/api/auth/sign-up/* specifically while keeping the lenient 30/min auth
bucket on the rest (get-session polling et al.).

This commit only adds the constant. Per CLAUDE.md spec-authoring rule,
shared additions ship before any API code references them. The auth
constant value (30/min) is unchanged — was raised to 30 in hotfix
4108020 and that's the long-term policy."
```

---

## Task 1: H — Log key spelling fix

**Goal:** Rename the `workspace:` key in `apps/api/src/routes/plaid.ts:232` to `workspaceId:` so it conforms to the `LogContext` schema in `@fina/shared`.

**Files:**
- Modify: `apps/api/src/routes/plaid.ts:232`

- [ ] **Step 1.1: Read the current call site**

Confirm the actual line content (the log call may have multi-line form). Run:

```bash
grep -n "workspace:" apps/api/src/routes/plaid.ts
```

Expected: exactly one match on or near line 232. Confirm it's a log/context call (not a route literal).

- [ ] **Step 1.2: Edit the key**

Replace `workspace:` with `workspaceId:` on that line. Use the Edit tool:

- old_string: `workspace: ` (with the surrounding context to make it unique — include 1-2 lines around)
- new_string: `workspaceId: ` with the same surrounding lines

The value (`verifiedWsId` or similar) is unchanged; only the key name changes.

- [ ] **Step 1.3: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: no errors. The `LogContext` type's `workspaceId?: string | null` field accepts the value `verifiedWsId` (which is a `string`).

- [ ] **Step 1.4: Run the targeted route test**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/plaid.exchange.test.ts
```

Expected: all tests pass. Behavior didn't change — only a log key name.

- [ ] **Step 1.5: Commit**

```bash
git add apps/api/src/routes/plaid.ts
git commit -m "fix(api): plaid log key 'workspace' → 'workspaceId'

Conform to the LogContext schema in @fina/shared. The previous key
was a one-off and would not show up under workspaceId filters in
log aggregators."
```

---

## Task 2: E — `TRUST_PROXY` strict opt-in + testEnv helper

**Goal:** Remove the NODE_ENV-based default for `TRUST_PROXY`. Every environment must set it explicitly. Provide a `testEnv()` helper to absorb the resulting ~48-file fixture sweep.

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `.env.example`
- Modify: `apps/api/tests/env.test.ts`
- Create: `apps/api/tests/helpers/test-env.ts`
- Modify: ~48 test files in `apps/api/tests/` that inline-construct an `env` object

- [ ] **Step 2.1: Write the failing env.test.ts cases**

Open `apps/api/tests/env.test.ts`. Find the `TRUST_PROXY` block (around lines 73-83). Replace the existing two cases with three new ones:

```ts
describe("loadEnv TRUST_PROXY strict opt-in", () => {
  it("rejects production with unset TRUST_PROXY", () => {
    const old = process.env;
    process.env = {
      ...baseEnv(),
      NODE_ENV: "production",
      RESEND_API_KEY: "re_" + "a".repeat(24),
    };
    expect(() => loadEnv()).toThrow(/TRUST_PROXY/);
    process.env = old;
  });

  it("rejects dev with unset TRUST_PROXY", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development" };
    expect(() => loadEnv()).toThrow(/TRUST_PROXY/);
    process.env = old;
  });

  it("accepts TRUST_PROXY=true in production (assumed behind a CDN)", () => {
    const old = process.env;
    process.env = {
      ...baseEnv(),
      NODE_ENV: "production",
      RESEND_API_KEY: "re_" + "a".repeat(24),
      TRUST_PROXY: "true",
    };
    expect(loadEnv().TRUST_PROXY).toBe(true);
    process.env = old;
  });

  it("accepts TRUST_PROXY=false in dev", () => {
    const old = process.env;
    process.env = { ...baseEnv(), NODE_ENV: "development", TRUST_PROXY: "false" };
    expect(loadEnv().TRUST_PROXY).toBe(false);
    process.env = old;
  });
});
```

- [ ] **Step 2.2: Run test — expect failure**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts
```

Expected: the new "rejects unset" cases pass (because `TRUST_PROXY` is currently optional, but `loadEnv()` doesn't throw — wait, actually it would still default to NODE_ENV-based value, so the tests would fail). Confirm failures on the first two new tests.

- [ ] **Step 2.3: Tighten `env.ts`**

In `apps/api/src/env.ts`, find the `TRUST_PROXY` field in `Schema` (around line 27). Replace:

```ts
  TRUST_PROXY: z.preprocess(
    (v) => (v === "true" || v === "1" ? true : v === "false" ? false : v),
    z.boolean().optional(),
  ),
```

with:

```ts
  // Strict opt-in (Plan 1J Task 2): no default — production deployments
  // must explicitly state whether they're behind a CDN/LB that strips
  // client-set X-Forwarded-For. Setting true without that infrastructure
  // lets attackers spoof X-Forwarded-For to rotate rate-limit buckets and
  // pollute audit IPs.
  TRUST_PROXY: z.preprocess(
    (v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v),
    z.boolean(),
  ),
```

Then find the `.transform` block at the bottom of `ParsedSchema` (around line 70). Remove the `TRUST_PROXY` defaulting line:

```ts
// BEFORE:
.transform((e) => ({
  ...e,
  TRUST_PROXY: e.TRUST_PROXY ?? e.NODE_ENV === "production",
}));

// AFTER (no transform needed for TRUST_PROXY now):
;
```

Since the transform's only job was the TRUST_PROXY default, remove the entire `.transform(...)` chain. `ParsedSchema` becomes just the `.refine(...)` result:

```ts
const ParsedSchema = Schema.refine(
  (e) => {
    if (e.NODE_ENV !== "production") return true;
    if (!e.RESEND_API_KEY) return false;
    return e.RESEND_API_KEY.startsWith("re_") && e.RESEND_API_KEY.length >= 24;
  },
  { message: "RESEND_API_KEY must be a real Resend key in production", path: ["RESEND_API_KEY"] },
);

export type Env = z.infer<typeof ParsedSchema>;
```

- [ ] **Step 2.4: Run env.test.ts — expect pass on the new cases, FAIL on others**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts
```

Expected: the 4 new `TRUST_PROXY` cases pass. Existing cases like "PRISMA_CONNECTION_LIMIT defaults to 10" might fail because their `baseEnv()` doesn't include `TRUST_PROXY`. Update `baseEnv()`:

In `apps/api/tests/env.test.ts`, find `function baseEnv()` and add `TRUST_PROXY: "false"` to the returned object. Then re-run. Expected: all env.test.ts cases pass.

- [ ] **Step 2.5: Create the testEnv helper**

Create `apps/api/tests/helpers/test-env.ts`:

```ts
import type { Env } from "../../src/env.js";

/** Single source of truth for test env fixtures. Inline `const env = {...}`
 *  literals in test files break every time the Env schema gains a required
 *  field. This helper absorbs that churn. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    PORT: 0,
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://fina:fina@localhost:5433/fina_test",
    BETTER_AUTH_SECRET: "x".repeat(48),
    BETTER_AUTH_URL: "http://localhost:0",
    EMAIL_FROM: "test@fina.app",
    WEB_APP_URL: "http://localhost:3000",
    PLAID_CLIENT_ID: "x",
    PLAID_SECRET: "x",
    PLAID_ENV: "sandbox",
    ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    GEMINI_API_KEY: "x",
    PRISMA_CONNECTION_LIMIT: 10,
    TRUST_PROXY: false,
    ...overrides,
  };
}
```

- [ ] **Step 2.6: Audit existing fixtures**

Run:

```bash
grep -rln "NODE_ENV.*test\|TRUST_PROXY: false" apps/api/tests/ | sort -u
```

Capture the list (~51 files at plan time). Skip files already using `testEnv()` (none yet). For each file:

1. Add at the top: `import { testEnv } from "./helpers/test-env.js";` (adjust relative path: `./helpers/...` for tests in `apps/api/tests/`, `../helpers/...` for tests in subdirs).
2. Find the inline `const env = { NODE_ENV: "test" as const, ... } as Env;` or similar literal.
3. Replace with `const env = testEnv();` (or `testEnv({ RATE_LIMIT_TEST: "1" })` for the rate-limit test, etc. — preserve any overrides as a Partial).
4. Remove the now-unused `import type { Env }` if no other references.

This is mechanical. Do all files in this step; commit at Step 2.10.

- [ ] **Step 2.7: Update `.env.example`**

Find the `TRUST_PROXY=` line in repo-root `.env.example`. Replace with:

```
# Trust X-Forwarded-For when behind a load balancer / CDN. MUST be set
# explicitly — no default. Set to "true" ONLY if your deployment is
# behind a CDN/LB that strips client-set X-Forwarded-For headers. Setting
# true without that infrastructure lets attackers spoof their source IP.
# In dev / direct-connection deployments, set "false".
TRUST_PROXY=false
```

- [ ] **Step 2.8: Run the full test suite to catch any missed fixtures**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -30
```

Expected: all tests pass. If any test fails with `TRUST_PROXY` errors, that file was missed in Step 2.6 — fix and re-run.

- [ ] **Step 2.9: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean. If any test file's `as Env` cast no longer matches the schema, address by switching to `testEnv()`.

- [ ] **Step 2.10: Commit**

```bash
git add apps/api/src/env.ts apps/api/tests/ .env.example
git commit -m "feat(api): TRUST_PROXY strict opt-in + testEnv helper

env.ts: removed the NODE_ENV-based TRUST_PROXY default. Production
deploys must explicitly set TRUST_PROXY=true (behind CDN/LB) or
false (direct). 1H's default-to-true-in-prod was a deployment
foot-gun — setting trustProxy on a non-CDN deploy lets attackers
spoof X-Forwarded-For to rotate rate-limit buckets and pollute
audit IPs.

apps/api/tests/helpers/test-env.ts: single-source-of-truth testEnv()
factory absorbs the ~48-file fixture sweep that the schema change
required. Each migrated fixture replaces an inline 'const env = {...}'
literal with 'testEnv(overrides?)', so future schema changes ripple
through one file instead of fifty.

.env.example documents the new requirement and warns about the
spoofing risk if mis-set."
```

---

## Task 3: G — Frontend `rate_limit_exceeded` toast

**Goal:** When `apiFetch` rejects with `ApiError` code `rate_limit_exceeded`, fire a localized sonner toast. Install sonner as a new `apps/web` dep.

**Files:**
- Modify: `apps/web/package.json` (+ lockfile)
- Modify: `apps/web/src/app/layout.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/api.test.ts`

- [ ] **Step 3.1: Install sonner**

```bash
pnpm --filter @fina/web add sonner
```

Expected: `apps/web/package.json` gains `"sonner"` dep; lockfile updated.

- [ ] **Step 3.2: Mount `<Toaster />` in root layout**

Read `apps/web/src/app/layout.tsx`. Find the JSX root (typically `<html><body>{children}</body></html>` or a wrapper component). Add:

```tsx
import { Toaster } from "sonner";

// inside the body, after {children}:
<Toaster richColors position="bottom-right" />
```

The exact placement: as the last child of `<body>` (or whatever the outermost JSX element is, just before its closing tag). Sonner's Toaster mounts a portal-managed container — order doesn't affect z-index, but conventionally goes last.

- [ ] **Step 3.3: Add the toast call in apiFetch**

Read `apps/web/src/lib/api.ts`. The file constructs `apiFetch` via `makeApiFetch(...)` from `@fina/shared`. Locate the error-throwing path. The factory in `@fina/shared` throws `ApiError`-shaped plain objects; the consumer doesn't directly catch — instead, callers in pages do.

The cleanest interception: wrap `makeApiFetch`'s return in a thin adapter that catches `rate_limit_exceeded` before re-throwing.

Edit `apps/web/src/lib/api.ts`. After the `export const apiFetch = makeApiFetch({ ... })` line, replace with:

```ts
import { isApiError } from "@fina/shared";
import { toast } from "sonner";

const rawApiFetch = makeApiFetch({
  baseUrl: env.NEXT_PUBLIC_API_URL,
  getActiveWorkspaceId,
  withCredentials: true,
});

function parseRetryAfter(msg: string): number | null {
  const m = msg.match(/Retry in (\d+)s/);
  return m ? Number(m[1]) : null;
}

export const apiFetch: typeof rawApiFetch = async (...args) => {
  try {
    return await rawApiFetch(...args);
  } catch (err) {
    if (isApiError(err) && err.code === "rate_limit_exceeded") {
      const secs = parseRetryAfter(err.message ?? "");
      toast.error(
        secs !== null
          ? `잠시 후 다시 시도해 주세요 (${secs}초 후)`
          : "잠시 후 다시 시도해 주세요",
      );
    }
    throw err;
  }
};
```

The variable names `rawApiFetch` and `apiFetch` keep callers (`import { apiFetch } from "../lib/api"`) unchanged. The TypeScript `typeof rawApiFetch` preserves the generic signature of `makeApiFetch`'s return so existing call sites' `apiFetch<MeDTO>(...)` still typecheck.

Verify the `env` import (`import { env } from "..."`) and `getActiveWorkspaceId` reference still resolve — these come from the file's existing imports and shouldn't need changes.

- [ ] **Step 3.4: Write the api.test.ts case**

Create `apps/web/src/lib/api.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from "vitest";

// Hoisted mock — sonner's toast must be mocked BEFORE the api module imports it.
vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

// Mock global fetch.
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Provide NEXT_PUBLIC_API_URL via process.env (the api module reads it from a
// validated env object — adjust if your env loader uses something else).
process.env.NEXT_PUBLIC_API_URL = "http://localhost:0";

afterEach(() => {
  fetchMock.mockReset();
  vi.clearAllMocks();
});

describe("apiFetch rate_limit_exceeded handler", () => {
  it("fires a localized sonner toast with the parsed retry seconds", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "rate_limit_exceeded",
          message: "Rate limit exceeded. Retry in 28s.",
          statusCode: 429,
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toMatchObject({
      code: "rate_limit_exceeded",
    });
    expect(toast.error).toHaveBeenCalledWith("잠시 후 다시 시도해 주세요 (28초 후)");
  });

  it("omits the seconds when the message doesn't include a Retry in N pattern", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "rate_limit_exceeded",
          message: "no retry hint here",
          statusCode: 429,
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("잠시 후 다시 시도해 주세요");
  });

  it("does NOT fire toast for non-rate-limit errors", async () => {
    const { toast } = await import("sonner");
    const { apiFetch } = await import("./api.js");
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "not_found", statusCode: 404 }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(apiFetch("/anything")).rejects.toBeTruthy();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3.5: Run the new test**

```bash
pnpm --filter @fina/web exec vitest run --config vitest.config.ts src/lib/api.test.ts
```

(Adjust the command if `apps/web` uses a different test setup — check `apps/web/package.json` for the `"test"` script and use whatever command it points to.)

Expected: 3 tests pass.

- [ ] **Step 3.6: Typecheck**

```bash
pnpm --filter @fina/web exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 3.7: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/layout.tsx apps/web/src/lib/api.ts apps/web/src/lib/api.test.ts
git commit -m "feat(web): localized rate_limit_exceeded toast via sonner

apiFetch now wraps the @fina/shared makeApiFetch factory and
intercepts rate_limit_exceeded errors with a sonner toast: '잠시
후 다시 시도해 주세요 (Xs 후)' where X is parsed from the API's
'Retry in Ns' message. Other error codes are re-thrown unchanged.

sonner is a small (~5KB gzipped), React 18-compatible toast lib
chosen because apps/web had no toast infrastructure (verified no
sonner / react-hot-toast / Radix-toast deps before this commit).
<Toaster richColors position='bottom-right' /> mounts once in
the root layout.

The handler fires the toast SIDE-EFFECT and still re-throws the
error so caller-level catch blocks see the rejection and can
handle their own retry logic — the toast is purely UX feedback."
```

---

## Task 4: F — `app.log.*` → singleton logger sweep

**Goal:** Migrate 7 `app.log.*` callsites in route handlers (`invites.ts`, `plaid.ts`, `plaid-webhook.ts`) to the singleton logger established in 1H Task 2. Add one smoke assertion that catches regressions.

**Files:**
- Modify: `apps/api/src/routes/invites.ts`
- Modify: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/src/routes/plaid-webhook.ts`
- Modify: `apps/api/tests/plaid.webhook.routes.test.ts` (or similar) — add the smoke assertion

- [ ] **Step 4.1: Confirm callsite locations**

```bash
grep -n "app\.log\." apps/api/src/routes/invites.ts apps/api/src/routes/plaid.ts apps/api/src/routes/plaid-webhook.ts
```

Expected: exactly 7 hits (2 in invites, 3 in plaid, 2 in plaid-webhook). If the count drifted, update this task's expectations and proceed with whatever the grep returns — DO NOT skip any.

- [ ] **Step 4.2: Migrate `invites.ts`**

For each `app.log.error("msg", ctx)` or `app.log.warn(...)` etc., apply the transform:

```ts
// Before
app.log.error("msg", { foo: 1, err });
// After
import { logError } from "../logger.js";
logError({ foo: 1, err }, "msg");
```

Steps per file:
1. Add the import at the top: `import { logError, logWarn, logInfo } from "../logger.js";` (only import the helpers you actually use — `logInfo` if there's a `app.log.info`, etc.).
2. For each `app.log.LEVEL(msg, ctx)`, swap the arg order: `logLEVEL(ctx, msg)`. Note: Fastify's `app.log.error(msg, ctx)` puts msg first; pino's argument order via our wrappers is `(ctx, msg)`.
3. Use `LogContext` keys appropriate to the site: `plaidEvent`, `plaidItemId`, `workspaceId`, `userId`, etc. If the existing context object had nonstandard keys, fold them into the message string OR add a one-off `note: "..."` field via `LogContext.err` only if it's an error context.

Read `apps/api/src/routes/invites.ts`, locate the 2 `app.log.*` callsites, edit them.

- [ ] **Step 4.3: Migrate `plaid.ts`**

Same pattern. Read `apps/api/src/routes/plaid.ts`, locate the 3 `app.log.*` callsites (~lines vary), edit each.

- [ ] **Step 4.4: Migrate `plaid-webhook.ts`**

Same pattern for the 2 callsites in `apps/api/src/routes/plaid-webhook.ts`.

- [ ] **Step 4.5: Verify the grep is clean**

```bash
grep -rn 'app\.log\.' apps/api/src/routes/
```

Expected: zero output. If anything remains, migrate it.

- [ ] **Step 4.6: Add the smoke assertion**

Pick the test file most likely to exercise one of the migrated routes — e.g., `apps/api/tests/plaid.webhook.routes.test.ts` (already exists from 1H Task 9). Find a test that hits one of the migrated callsites' route. Add a spy assertion:

```ts
import * as loggerMod from "../src/logger.js";

// In an existing test that triggers a route logging an error:
const spy = vi.spyOn(loggerMod, "logError").mockImplementation(() => {});
try {
  // ... trigger the error path (existing test body) ...
  expect(spy).toHaveBeenCalled(); // smoke check
} finally {
  spy.mockRestore();
}
```

Pick the simplest existing failure-path test that goes through a migrated callsite. If no such test exists, write a tiny dedicated one — but check first; one likely exists for invites or plaid-webhook's error paths.

- [ ] **Step 4.7: Run the targeted test files**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/invites.test.ts tests/plaid.exchange.test.ts tests/plaid.webhook*.test.ts
```

Expected: all tests pass.

- [ ] **Step 4.8: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 4.9: Commit**

```bash
git add apps/api/src/routes/invites.ts apps/api/src/routes/plaid.ts apps/api/src/routes/plaid-webhook.ts apps/api/tests/
git commit -m "refactor(api): finish app.log → singleton logger migration

The seven app.log.* callsites in routes/{invites,plaid,plaid-webhook}.ts
were the last holdouts after 1H T8/T10 migrated cron + chat + audit +
categorize + email. All now use logInfo/Warn/Error from
apps/api/src/logger.ts so log aggregators see one consistent shape
(LogContext) across the whole API.

Added a smoke assertion on one of the migrated callsites (vi.spyOn
on loggerMod.logError) to catch regressions where a contributor
re-introduces app.log.* on a touched route."
```

---

## Task 5: C — `findTransactions` tz fix

**Goal:** `findTransactions` interprets `start_date` / `end_date` in the user's local timezone instead of UTC. Use the existing `resolveUserTz` + `localMidnightToUtc` helpers from `apps/api/src/chat/tools/periods.ts`.

**Files:**
- Modify: `apps/api/src/chat/tools/find-transactions.ts`
- Modify: `apps/api/tests/chat.tools.find-transactions.test.ts`

- [ ] **Step 5.1: Write the failing KST test**

Read `apps/api/tests/chat.tools.find-transactions.test.ts` to understand its existing fixture pattern (how it seeds a user with a tz, how it inserts transactions with specific `occurredAt`).

Add a new test case in a new `describe("tz-aware date boundaries", ...)` block:

```ts
import { resolveUserTz } from "../src/chat/tools/periods.js"; // adjust if needed
import { describe, expect, it } from "vitest";

describe("findTransactions tz-aware boundaries", () => {
  it("includes a transaction at KST 00:30 on the start_date day", async () => {
    // Seed: user with tz="Asia/Seoul", one transaction at occurredAt = 2026-03-31T15:30Z
    // (which is 2026-04-01T00:30 KST — the user's notion of April 1 begins here).
    const { userId, workspaceId } = await seedTestUser({ tz: "Asia/Seoul" }); // use existing helper
    const accountId = await seedTestBankAccount(workspaceId, { currency: "KRW" });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId,
        amount: "10000",
        merchantRaw: "Coffee KST",
        occurredAt: new Date("2026-03-31T15:30:00.000Z"),
        rawData: {},
      },
    });

    const result = await findTransactions.run(
      { userId, workspaceId },
      { start_date: "2026-04-01", end_date: "2026-04-01" },
    );

    expect(result.transactions.some((t) => t.id === tx.id)).toBe(true);
  });

  it("excludes a transaction at KST 00:30 on the day AFTER end_date", async () => {
    const { userId, workspaceId } = await seedTestUser({ tz: "Asia/Seoul" });
    const accountId = await seedTestBankAccount(workspaceId, { currency: "KRW" });
    // occurredAt = 2026-04-01T15:30Z = 2026-04-02T00:30 KST
    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId,
        amount: "10000",
        merchantRaw: "Coffee KST next day",
        occurredAt: new Date("2026-04-01T15:30:00.000Z"),
        rawData: {},
      },
    });

    const result = await findTransactions.run(
      { userId, workspaceId },
      { start_date: "2026-04-01", end_date: "2026-04-01" },
    );

    expect(result.transactions.some((t) => t.id === tx.id)).toBe(false);
  });
});
```

Replace `seedTestUser`, `seedTestBankAccount`, etc. with whatever helpers the existing test file uses (read it first to find the actual helper names). Use the existing test's `tz` setting mechanism for the user. The `Transaction.currency` selector etc. — but Transaction has no currency field; use `BankAccount.currency` via the account relation if the existing fixture pattern needs it.

- [ ] **Step 5.2: Run test — expect fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.find-transactions.test.ts
```

Expected: both new tests fail. The first because UTC midnight excludes KST 00:30; the second because UTC end-of-day at 04-01T23:59Z (which is 04-02T08:59 KST) erroneously includes the 04-01T15:30Z transaction.

- [ ] **Step 5.3: Edit `find-transactions.ts`**

In `apps/api/src/chat/tools/find-transactions.ts`, find the `occurredAt` build (lines 165-177). Replace:

```ts
// Before (lines 168-169, 177):
if (args.start_date) occurredAt.gte = new Date(`${args.start_date}T00:00:00.000Z`);
if (args.end_date) occurredAt.lte = new Date(`${args.end_date}T23:59:59.999Z`);
// ...
if (occurredAt.gte || occurredAt.lte) where.occurredAt = occurredAt;
```

with:

```ts
// After: tz-aware, using existing helpers from ./periods.ts.
const tz = await resolveUserTz(ctx.userId);
if (args.start_date) {
  const [y, m, d] = args.start_date.split("-").map(Number);
  occurredAt.gte = localMidnightToUtc(y!, m!, d!, tz);
}
if (args.end_date) {
  const [y, m, d] = args.end_date.split("-").map(Number);
  // Exclusive upper bound: start of the next day in user tz. The +1 on the
  // day passes through localMidnightToUtc's DST-aware date math.
  occurredAt.lt = localMidnightToUtc(y!, m!, d! + 1, tz);
}
// ...
if (occurredAt.gte || occurredAt.lt) where.occurredAt = occurredAt;
```

Add the import at the top of the file (if not already present): `import { resolveUserTz, localMidnightToUtc } from "./periods.js";`

Update the `describe` field of the tool (the `description` literal around line 117) to add: `"Date ranges are interpreted in your local timezone."`

- [ ] **Step 5.4: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.find-transactions.test.ts
```

Expected: all tests pass (the new KST ones + any existing).

- [ ] **Step 5.5: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 5.6: Commit**

```bash
git add apps/api/src/chat/tools/find-transactions.ts apps/api/tests/chat.tools.find-transactions.test.ts
git commit -m "fix(api): findTransactions date range respects user tz

Previously start_date/end_date were interpreted as UTC midnight
boundaries — KST users querying 'April 1' missed transactions
from KST 00:00-08:59 on April 1 (which are 03/31 15:00-23:59 UTC).

Now uses resolveUserTz + localMidnightToUtc from ./periods.ts
(same helpers lookbackMonthStart and other tz-aware tools already
use). Switched the upper bound from .lte UTC-end-of-day to .lt
exclusive next-day-in-tz for cleaner math.

Other chat tools (listTransactions, getSpendingSummary, etc.) have
the same bug pattern; explicitly out of scope for 1J. A follow-up
plan should apply this fix uniformly once verified here."
```

---

## Task 6: D — `detectRecurringMerchants` currency grouping

**Goal:** Fix the bug where same-merchant transactions across different currencies are bucketed into one Candidate with the workspace's default currency.

**Files:**
- Modify: `apps/api/src/chat/tools/detect-recurring-merchants.ts`
- Modify: `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts`

- [ ] **Step 6.1: Write the failing multi-currency test**

Read `apps/api/tests/chat.tools.detect-recurring-merchants.test.ts` for fixture helpers. Add:

```ts
describe("multi-currency grouping", () => {
  it("returns separate Candidates for the same merchant in different currencies", async () => {
    const { userId, workspaceId } = await seedTestUser({ tz: "America/Toronto" });
    const usdAccount = await seedTestBankAccount(workspaceId, { currency: "USD" });
    const cadAccount = await seedTestBankAccount(workspaceId, { currency: "CAD" });
    // 4 USD transactions, monthly cadence
    for (let i = 0; i < 4; i++) {
      await prisma.transaction.create({
        data: {
          workspaceId,
          accountId: usdAccount,
          amount: "9.99",
          merchantRaw: "Netflix",
          occurredAt: new Date(`2026-0${i + 1}-15T00:00:00.000Z`),
          rawData: {},
        },
      });
    }
    // 4 CAD transactions, same merchant + same cadence
    for (let i = 0; i < 4; i++) {
      await prisma.transaction.create({
        data: {
          workspaceId,
          accountId: cadAccount,
          amount: "13.99",
          merchantRaw: "Netflix",
          occurredAt: new Date(`2026-0${i + 1}-20T00:00:00.000Z`),
          rawData: {},
        },
      });
    }

    const result = await detectRecurringMerchants.run(
      { userId, workspaceId },
      { lookback_months: 6, min_occurrences: 3 },
    );

    const netflixUsd = result.candidates.find((c) => c.currency === "USD");
    const netflixCad = result.candidates.find((c) => c.currency === "CAD");
    expect(netflixUsd).toBeDefined();
    expect(netflixCad).toBeDefined();
    expect(netflixUsd?.medianAmount).toBe("9.99");
    expect(netflixCad?.medianAmount).toBe("13.99");
    expect(netflixUsd?.transactionIds.length).toBe(4);
    expect(netflixCad?.transactionIds.length).toBe(4);
  });
});
```

- [ ] **Step 6.2: Run test — expect fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.detect-recurring-merchants.test.ts
```

Expected: the new test fails — currently merges into one Candidate.

- [ ] **Step 6.3: Edit `detect-recurring-merchants.ts`**

Read `apps/api/src/chat/tools/detect-recurring-merchants.ts`. Make four changes:

**Change 1**: Remove the `prisma.workspace.findUniqueOrThrow({...})` from `Promise.all` (lines ~98-104). The workspace.currency lookup is no longer needed for the result; group currency comes from `r.account.currency`. Keep `lookbackMonthStart`:

```ts
// Before (lines 98-104):
const [lookbackStart, workspace] = await Promise.all([
  lookbackMonthStart(ctx.userId, lookbackMonths),
  prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  }),
]);

// After:
const lookbackStart = await lookbackMonthStart(ctx.userId, lookbackMonths);
```

**Change 2**: Update the `findMany` select to join `account`:

```ts
// Before (lines 106-121):
const rows = await prisma.transaction.findMany({
  where: { ... },
  select: {
    id: true,
    amount: true,
    merchantRaw: true,
    merchantNormalized: true,
    occurredAt: true,
  },
  orderBy: { occurredAt: "asc" },
});

// After:
const rows = await prisma.transaction.findMany({
  where: { ... }, // unchanged
  select: {
    id: true,
    amount: true,
    merchantRaw: true,
    merchantNormalized: true,
    occurredAt: true,
    account: { select: { currency: true } },
  },
  orderBy: { occurredAt: "asc" },
});
```

**Change 3**: Update the `Group` type and the group-building loop (lines ~123-158):

```ts
// Before (Group type, lines 123-131):
type Group = {
  key: string;
  merchantKey: string;
  displayName: string;
  latestDisplayTs: number;
  transactionIds: string[];
  amounts: Prisma.Decimal[];
  occurredAts: Date[];
};

// After:
type Group = {
  key: string;
  merchantKey: string;
  currency: string;
  displayName: string;
  latestDisplayTs: number;
  transactionIds: string[];
  amounts: Prisma.Decimal[];
  occurredAts: Date[];
};
```

And in the loop (lines ~134-158):

```ts
// Before:
for (const r of rows) {
  const merchantKey = (r.merchantNormalized ?? normalizeMerchant(r.merchantRaw)).trim();
  if (!merchantKey) continue;
  const key = merchantKey;
  let g = groups.get(key);
  if (!g) {
    g = {
      key,
      merchantKey,
      displayName: r.merchantRaw,
      latestDisplayTs: r.occurredAt.getTime(),
      transactionIds: [],
      amounts: [],
      occurredAts: [],
    };
    groups.set(key, g);
  }
  ...
}

// After:
for (const r of rows) {
  const merchantKey = (r.merchantNormalized ?? normalizeMerchant(r.merchantRaw)).trim();
  if (!merchantKey) continue;
  const currency = r.account.currency;
  const key = `${merchantKey}|${currency}`;
  let g = groups.get(key);
  if (!g) {
    g = {
      key,
      merchantKey,
      currency,
      displayName: r.merchantRaw,
      latestDisplayTs: r.occurredAt.getTime(),
      transactionIds: [],
      amounts: [],
      occurredAts: [],
    };
    groups.set(key, g);
  }
  ...
}
```

**Change 4**: Update the Candidate result push (line ~204):

```ts
// Before:
candidates.push({
  key: g.key,
  merchantNormalized: g.merchantKey,
  ...
  currency: workspace.currency,
  ...
});

// After:
candidates.push({
  key: g.key,
  merchantNormalized: g.merchantKey,
  ...
  currency: g.currency,
  ...
});
```

- [ ] **Step 6.4: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.detect-recurring-merchants.test.ts
```

Expected: all tests pass (the new multi-currency test + any existing).

- [ ] **Step 6.5: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 6.6: Commit**

```bash
git add apps/api/src/chat/tools/detect-recurring-merchants.ts apps/api/tests/chat.tools.detect-recurring-merchants.test.ts
git commit -m "fix(api): detectRecurringMerchants — separate Candidates per currency

The merchant grouping key now includes the transaction's account
currency (joined via BankAccount.currency), and the result
Candidate.currency reports the actual per-group currency rather
than the workspace default.

Before: Netflix USD subscription + Netflix CAD subscription on
the same workspace would merge into one Candidate with the
workspace's default currency, producing nonsense median/latest
amounts. After: two Candidates, each with the correct currency
and amount stats.

Schema reality: Transaction has no currency column. Currency
lives on BankAccount.currency (required, default 'CAD'). The fix
selects via the existing 'account' relation — no migration needed.

The workspace.currency lookup at the tool's top level was removed
entirely (no other code path needed it)."
```

---

## Task 7: B — Scheduled-spend resolved TTL

**Goal:** `cleanup-events` cron deletes resolved `ScheduledSpend` rows older than `SCHEDULED_SPEND_TTL_DAYS` (default 90). Uses `updatedAt` as a proxy for "time of last resolution change" since the schema has no `resolvedAt` column.

**Files:**
- Modify: `apps/api/src/env.ts` (add `SCHEDULED_SPEND_TTL_DAYS`)
- Modify: `apps/api/src/cron/jobs/cleanup-events.ts`
- Modify: `apps/api/tests/cron.cleanup-events.test.ts`

- [ ] **Step 7.1: Add the env key**

In `apps/api/src/env.ts`, locate the cron-related env keys (around the existing `CRON_EVENT_TTL_DAYS` field). Add:

```ts
// TTL for resolved ScheduledSpend rows in days. Default 90 applied at use
// site with ?? 90. "Resolved" = dismissedAt set OR matchedTxId set.
SCHEDULED_SPEND_TTL_DAYS: z.coerce.number().int().positive().optional(),
```

- [ ] **Step 7.2: Write the failing test**

Read `apps/api/tests/cron.cleanup-events.test.ts` for existing test patterns. Add a new describe block:

```ts
describe("cleanup-events ScheduledSpend pass", () => {
  it("deletes resolved ScheduledSpends older than the TTL (default 90 days)", async () => {
    // Resolved + old: should delete
    const oldDismissed = await prisma.scheduledSpend.create({
      data: {
        workspaceId,
        categoryId,
        amount: "20.00",
        scheduledDate: new Date("2025-12-01"),
        dismissedAt: new Date("2026-01-01"),
      },
    });
    await prisma.$executeRaw`UPDATE scheduled_spends SET updated_at = NOW() - INTERVAL '91 days' WHERE id = ${oldDismissed.id}`;

    // Resolved + recent: should NOT delete
    const recentMatched = await prisma.scheduledSpend.create({
      data: {
        workspaceId,
        categoryId,
        amount: "30.00",
        scheduledDate: new Date("2026-04-01"),
        matchedTxId: existingTxId, // use a real tx in the same workspace
      },
    });
    await prisma.$executeRaw`UPDATE scheduled_spends SET updated_at = NOW() - INTERVAL '30 days' WHERE id = ${recentMatched.id}`;

    // Unresolved + old: should NOT delete (neither dismissedAt nor matchedTxId set)
    const oldUnresolved = await prisma.scheduledSpend.create({
      data: {
        workspaceId,
        categoryId,
        amount: "40.00",
        scheduledDate: new Date("2025-12-15"),
      },
    });
    await prisma.$executeRaw`UPDATE scheduled_spends SET updated_at = NOW() - INTERVAL '120 days' WHERE id = ${oldUnresolved.id}`;

    await runCleanupEvents(env);

    expect(await prisma.scheduledSpend.findUnique({ where: { id: oldDismissed.id } })).toBeNull();
    expect(await prisma.scheduledSpend.findUnique({ where: { id: recentMatched.id } })).not.toBeNull();
    expect(await prisma.scheduledSpend.findUnique({ where: { id: oldUnresolved.id } })).not.toBeNull();
  });
});
```

Replace `workspaceId`, `categoryId`, `existingTxId`, `env`, `runCleanupEvents` with whatever symbols the existing test file already imports / seeds. If the existing test seeds a workspace + category at module scope, reuse those.

- [ ] **Step 7.3: Run test — expect fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/cron.cleanup-events.test.ts
```

Expected: the new test fails — currently `cleanup-events` doesn't touch `ScheduledSpend`.

- [ ] **Step 7.4: Edit `cleanup-events.ts`**

Read `apps/api/src/cron/jobs/cleanup-events.ts`. Add after the existing `plaid_webhook_events` delete:

```ts
import { prisma } from "../../db.js";
import { logInfo } from "../../logger.js";
import type { Env } from "../../env.js";

const CRON_NAME = "cleanup-events";

export async function runCleanupEvents(env: Env): Promise<void> {
  // ... existing plaid_webhook_events delete ...
  // (keep the existing block unchanged)

  // ScheduledSpend resolved TTL (Plan 1J Task 7). Uses updatedAt as a proxy
  // for "time of resolution" since the schema has no resolvedAt column.
  // "Resolved" = dismissedAt set OR matchedTxId set.
  const ttlDays = env.SCHEDULED_SPEND_TTL_DAYS ?? 90;
  const scheduledSpendCutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  const ssDeleted = await prisma.scheduledSpend.deleteMany({
    where: {
      OR: [
        { dismissedAt: { not: null } },
        { matchedTxId: { not: null } },
      ],
      updatedAt: { lt: scheduledSpendCutoff },
    },
  });
  logInfo(
    { cron: CRON_NAME, deletedScheduledSpends: ssDeleted.count, ttlDays },
    "cleanup-events scheduled-spend pass",
  );
}
```

If the existing file already has `CRON_NAME` and the import of `logInfo`, don't duplicate — splice into the existing structure.

- [ ] **Step 7.5: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/cron.cleanup-events.test.ts
```

Expected: all tests pass.

- [ ] **Step 7.6: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 7.7: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/cron/jobs/cleanup-events.ts apps/api/tests/cron.cleanup-events.test.ts
git commit -m "feat(api): cleanup-events deletes old resolved ScheduledSpends

Adds a second deletion pass to the existing cleanup-events cron
(daily 3am UTC). Deletes ScheduledSpend rows where (dismissedAt
is not null OR matchedTxId is not null) AND updatedAt < now - TTL.

Schema reality: ScheduledSpend has no 'resolvedAt' column and no
'status' enum — 'resolved' is computed from (matchedTxId,
dismissedAt). updatedAt is the closest proxy for 'time of last
state change'. Imprecise edge case: a 95-day-old resolved row that
gets touched (e.g., user re-dismisses) resets updatedAt, delaying
deletion by one TTL cycle. Acceptable for cleanup semantics.

New env key SCHEDULED_SPEND_TTL_DAYS (default 90 at use site) —
apps/api-only, matches the existing CRON_EVENT_TTL_DAYS pattern."
```

---

## Task 8: I — Auth bucket split

**Goal:** Wire `RATE_LIMITS.authStrict` (5/min/IP) onto `/api/auth/sign-in/*` and `/api/auth/sign-up/*` specifically; keep the lenient `RATE_LIMITS.auth` (30/min/IP) on the catch-all `/api/auth/*` for read paths like get-session. Extract the Better Auth fetch bridge into a factory to avoid handler duplication.

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/tests/rate-limit.test.ts`

- [ ] **Step 8.1: Write the failing tests**

In `apps/api/tests/rate-limit.test.ts`, find the existing `"auth bucket — 30/min per IP on /api/auth/*"` test (it was the 31-iteration test from 1H's hotfix). Replace with two tests:

```ts
it("authStrict bucket — 5/min per IP on /api/auth/sign-in/*", async () => {
  const app = await buildApp(env);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: `r${i}@t.co`, password: "wrong" }),
    });
  }
  expect(last?.statusCode).toBe(429);
  expect(last?.json().error).toBe("rate_limit_exceeded");
  await app.close();
});

it("authStrict bucket — 5/min per IP on /api/auth/sign-up/*", async () => {
  const app = await buildApp(env);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: `n${i}@t.co`, password: "validpw1234", name: `n${i}` }),
    });
  }
  expect(last?.statusCode).toBe(429);
  await app.close();
});

it("auth (lenient) bucket — 30/min per IP on /api/auth/get-session", async () => {
  const app = await buildApp(env);
  let last;
  for (let i = 0; i < 31; i++) {
    last = await app.inject({ method: "GET", url: "/api/auth/get-session" });
  }
  expect(last?.statusCode).toBe(429);
  await app.close();
});

it("sign-in failures do NOT consume the auth/get-session bucket", async () => {
  // Burn 4 sign-in attempts (under the authStrict 5/min limit) then verify
  // get-session still works (auth bucket untouched).
  const app = await buildApp(env);
  for (let i = 0; i < 4; i++) {
    await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: `s${i}@t.co`, password: "wrong" }),
    });
  }
  const sessionRes = await app.inject({ method: "GET", url: "/api/auth/get-session" });
  expect(sessionRes.statusCode).not.toBe(429);
  await app.close();
});
```

- [ ] **Step 8.2: Run test — expect fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/rate-limit.test.ts
```

Expected: the new sign-in / sign-up tests will pass under the CURRENT code (because /api/auth/* catch-all uses auth 30/min, so sign-in 5th attempt does NOT 429 yet — the test asserts 6th IS 429 because the limit is 30). Actually the FIRST test expects 6th = 429 but with current 30/min it won't. So this test fails until Task 8 wires authStrict.

- [ ] **Step 8.3: Edit `server.ts` — extract `makeBetterAuthHandler`**

Read `apps/api/src/server.ts:88-122` to capture the full existing Better Auth handler. Extract into a factory function declared OUTSIDE `buildApp`:

```ts
// Add this function near the top of server.ts, after imports:
import type { RouteHandler } from "fastify";

function makeBetterAuthHandler(auth: FinaAuth, env: Env): RouteHandler {
  return async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});
    const init: RequestInit =
      body === undefined
        ? { method: req.method, headers }
        : { method: req.method, headers, body };
    const response = await auth.handler(new Request(url, init));

    reply.code(response.status);
    // Forward all headers EXCEPT set-cookie via forEach (forEach combines
    // multiple set-cookie values into a comma-joined string, which browsers
    // misparse as a single broken cookie). Use getSetCookie() — which returns
    // a string[] per spec — and pass that array to reply.header so Fastify
    // emits one Set-Cookie per entry.
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      reply.header(key, value);
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) reply.header("set-cookie", setCookies);
    const buf = Buffer.from(await response.arrayBuffer());
    return reply.send(buf);
  };
}
```

- [ ] **Step 8.4: Wire the three route registrations**

In `buildApp`, find the existing `app.all("/api/auth/*", { config: withRateLimit("auth") }, async (req, reply) => { ... });` block (lines 88-122). Replace with three lines + the existing import for `withRateLimit` (already present from 1H):

```ts
const betterAuthHandler = makeBetterAuthHandler(auth, env);

// Order matters for Fastify route matching: more-specific patterns must
// register first so /api/auth/sign-in/* and /api/auth/sign-up/* take
// precedence over the catch-all /api/auth/*. Verified by Step 8.2's
// authStrict tests (5/min sign-in vs 30/min get-session).
app.all("/api/auth/sign-in/*", { config: withRateLimit("authStrict") }, betterAuthHandler);
app.all("/api/auth/sign-up/*", { config: withRateLimit("authStrict") }, betterAuthHandler);
app.all("/api/auth/*",          { config: withRateLimit("auth")       }, betterAuthHandler);
```

- [ ] **Step 8.5: Run test — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/rate-limit.test.ts
```

Expected: all 5 rate-limit tests pass. If Fastify route matching does NOT prefer the more-specific pattern, the authStrict tests will not see 429 at the 6th request (they'd see 429 only at the 31st instead). In that case:

**Fallback (only if Step 8.5 fails on the authStrict tests):** Replace the per-route config approach with an in-handler URL check. Keep ONE `app.all("/api/auth/*", ...)` but inside the handler, before forwarding to `auth.handler`, look at `req.url`:

```ts
// Inside makeBetterAuthHandler, BEFORE the auth.handler call:
// Manually enforce strict rate limit on sign-in/sign-up paths since
// @fastify/rate-limit's per-route config didn't take precedence over
// the catch-all on this Fastify version.
const isStrict = req.url.startsWith("/api/auth/sign-in/") || req.url.startsWith("/api/auth/sign-up/");
if (isStrict) {
  // Use a separate rate-limit store keyed by IP + bucket name. The simplest
  // approach is a manual counter — but we already have @fastify/rate-limit
  // running. So instead, RE-architect: define two route-prefixes with separate
  // registrations OUTSIDE the catch-all.
}
```

This fallback should NOT be needed — Fastify's specificity-first matching has been stable since 3.x and this codebase is on 5.x. If you hit it, document the Fastify version in the commit message and we'll revisit.

- [ ] **Step 8.6: Run the full suite for regressions**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -10
```

Expected: 952+ tests pass (the 4 split auth tests replace the previous 1 combined auth test, so net +3 cases).

- [ ] **Step 8.7: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 8.8: Commit**

```bash
git add apps/api/src/server.ts apps/api/tests/rate-limit.test.ts
git commit -m "feat(api): split /api/auth/* rate-limit — authStrict for sign-in/up

After 1H's hotfix raised the auth bucket from 5 to 30/min/IP to
accommodate get-session polling (commit 4108020), credential-
stuffing protection was effectively neutralized — an attacker could
make 30 sign-in attempts per minute per IP, vs the original 5.

Now restored properly: /api/auth/sign-in/* and /api/auth/sign-up/*
get withRateLimit('authStrict') (5/min/IP), while the catch-all
/api/auth/* keeps the lenient auth (30/min/IP). Fastify route
specificity orders the sign-in/up registrations before the
catch-all so they win the match.

Extracted the 33-line Better Auth fetch bridge into
makeBetterAuthHandler(auth, env) so the three route registrations
share the same handler — including the set-cookie forwarding
workaround that splits the comma-joined getSetCookie() response
into individual Set-Cookie headers."
```

---

## Final verification

After all 9 tasks land:

- [ ] **Verify the success criteria from §6 of the spec**

```bash
# H — no more "workspace:" log key:
grep -n "workspace:" apps/api/src/routes/plaid.ts
# Expected: 0 matches.

# E — TRUST_PROXY strict:
NODE_ENV=production DATABASE_URL=x BETTER_AUTH_SECRET="$(printf 'x%.0s' {1..48})" BETTER_AUTH_URL=http://0 WEB_APP_URL=http://0 PLAID_CLIENT_ID=x PLAID_SECRET=x ENCRYPTION_KEY="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" GEMINI_API_KEY=x RESEND_API_KEY=re_aaaaaaaaaaaaaaaaaaaaaaaa pnpm --filter @fina/api exec node -e "import('./dist/env.js').then(m => m.loadEnv()).catch(e => { console.error(e.message); process.exit(1); })"
# Expected: exits with "TRUST_PROXY" error.

# F — no app.log in routes:
grep -rn 'app\.log\.' apps/api/src/routes/
# Expected: 0 matches.

# Full suite:
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -5
# Expected: 'Test Files XXX passed' with no failures.

# Web suite:
pnpm --filter @fina/web exec vitest run 2>&1 | tail -5
# Expected: api.test.ts passes (3 cases).
```

- [ ] **Smoke (optional, in a staging container)**

Manual verification per spec §6:
- KST user `findTransactions(start_date="2026-04-01")` includes 2026-04-01 KST transactions.
- USD + CAD same-merchant transactions yield 2 separate Candidates.
- `cleanup-events` cron deletes 91-day-old resolved ScheduledSpends.
- 6th sign-in attempt from same IP → 429; 6th get-session call → 200.
- 429 response in the web dev server pops a sonner toast.
