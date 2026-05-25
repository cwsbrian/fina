# Plan 1S-http-route-push-integration Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1R (computeGoalSavings unit tests). Closes Plan 1P §7 follow-up #3.

## 1. Goal & scope

Verify HTTP routes that fire push effects (anomaly + member fan-out + invite) wire correctly through to the push helpers. Plan 1L-1R tested every wrapper and helper in isolation; Plan 1S tests the **integration boundary** — does the HTTP layer actually invoke the push wiring?

**HTTP → push call sites in the codebase:**

| Route | Helper called | Pattern |
|---|---|---|
| `POST /workspaces/:id/transactions/manual` | `checkLargeChargeAndPush` | fire-and-forget `void ...()` |
| `POST /workspaces/:id/transactions/manual` | `notifyTransactionAdded` | fire-and-forget `void ...()` |
| `POST /workspaces/:id/invites` | `sendWorkspaceInvitePush` | awaited, caught (best-effort) |

Add **6 integration tests** in 1 commit using real Fastify app, real Postgres, partial `vi.mock` for the 3 helpers.

**Out of scope:**
- Plaid webhook `sendBankReconnectPush` integration — `plaid.webhook.routes.test.ts` already covers webhook plumbing; the push call is one line at `webhook-item.ts:35` and is exercised by the existing webhook tests indirectly. Out-of-scope here to avoid touching JWKS/signature setup.
- POST `/me/notifications/test` (test-only endpoint at `me.ts:113-134`) — debugging surface; covered by manual QA.
- Cron-driven HTTP-less paths — Plan 1L-1R covered.
- Receipt polling integration — Plan 1Q covered the cron; no HTTP layer.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. Pure test addition.

## 3. Production change

**없음.** No edits to `transactions.ts`, `invites.ts`, `push/anomaly.ts`, `push/transaction-added.ts`, `push/send.ts`.

## 4. Test file — `apps/api/tests/http.push-integration.test.ts` (new, 6 tests)

**Mock strategy:**
- `vi.mock("../src/push/anomaly.js", ...)` partial — `checkLargeChargeAndPush` → `vi.fn().mockResolvedValue(undefined)`
- `vi.mock("../src/push/transaction-added.js", ...)` partial — `notifyTransactionAdded` → `vi.fn().mockResolvedValue(undefined)`
- `vi.mock("../src/push/send.js", ...)` partial — `sendWorkspaceInvitePush` → `vi.fn().mockResolvedValue({ sent: 0, failed: 0 })`. Other exports preserved via `...actual`.

`afterEach(vi.clearAllMocks)` — partial mocks; NOT restoreAllMocks (Plan 1M precedent).

**Fire-and-forget drain pattern**: after the HTTP call, await `new Promise(setImmediate)` to flush the macrotask queue once. This lets `void checkLargeChargeAndPush(...)` complete before assertion. Established Node test idiom.

### File header

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";
import * as anomalyMod from "../src/push/anomaly.js";
import * as addedMod from "../src/push/transaction-added.js";
import * as sendMod from "../src/push/send.js";

vi.mock("../src/push/anomaly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/anomaly.js")>();
  return { ...actual, checkLargeChargeAndPush: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/transaction-added.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/transaction-added.js")>();
  return { ...actual, notifyTransactionAdded: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendWorkspaceInvitePush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

const env = testEnv();

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

/** Drain the fire-and-forget promise queue: setImmediate runs after the
 *  current macrotask, by which point `void promise` callbacks have settled. */
async function drainFireAndForget() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
```

### Helpers

For invites, we need 2 users + 1 workspace. For manual tx, we need 1 user + workspace + bank account + category. These tests use the standard `signUpAndGetCookie` helper.

```ts
async function setupWorkspace(ownerCookie: string) {
  // signUpAndGetCookie creates user. Workspace + owner membership are
  // auto-bootstrapped by /me first-call OR via signUp flow. Check by
  // GET /me first to ensure workspace exists.
  // ...
}
```

Actually the existing test files (e.g., `transactions.create-manual.test.ts`, `invites.routes.test.ts`) have setup patterns we can mirror. We'll mirror their structure rather than redefine helpers.

### 6 test scenarios

| # | Route | Setup | Assertion |
|---|---|---|---|
| 1 | POST /workspaces/:id/transactions/manual | Owner + bank account + category. Body: amount $30. | 201 created. After drain: `checkLargeChargeAndPush` called once with `{transactionId, workspaceId, amount: 30, merchant}`. |
| 2 | POST /workspaces/:id/transactions/manual | Same as #1. | After drain: `notifyTransactionAdded` called once with `{workspaceId, merchant, amount: 30, categoryName, excludeUserId: ownerId}`. |
| 3 | POST /workspaces/:id/transactions/manual with 400 invalid body (negative amount) | Owner. Body amount: -5. | 400 invalid_body. After drain: NEITHER push helper called (request never committed). |
| 4 | POST /workspaces/:id/invites with existing user | Owner workspace. Pre-create invitee User row with email "x@t.co". Body: `{email: "x@t.co", role: "viewer"}`. | 201 created. `sendWorkspaceInvitePush` called once with `(env, inviteeId, inviterDisplayName, wsName)`. |
| 5 | POST /workspaces/:id/invites with NON-existing user (no User row) | Owner workspace. Body: `{email: "noone@nowhere.com", role: "viewer"}`. | 201 created. `sendWorkspaceInvitePush` NOT called (best-effort skip). |
| 6 | POST /workspaces/:id/invites push throws | Pre-create invitee. Mock `sendWorkspaceInvitePush.mockRejectedValueOnce(new Error("boom"))`. | 201 created (invite still succeeds — error caught + logged at invites.ts:113). `sendWorkspaceInvitePush` called once (and threw). |

**Commit:** `test(api): http→push integration — anomaly + notify + invite fan-out (6 tests)`

## 5. Risks

| Risk | Mitigation |
|---|---|
| Fire-and-forget timing — response returns before push fires; assertion would race | `drainFireAndForget` helper awaits `setImmediate` to flush queue once. If pushes have multiple awaits, increase to `setImmediate × 2` or `Promise.resolve()` × N. |
| Multiple `vi.mock` calls — order matters? | Vitest hoists `vi.mock` before imports; all three module replacements happen before any test file import. Each is independent. ✓ |
| `vi.clearAllMocks` resets call history but NOT implementation — partial mocks survive across tests | Plan 1M precedent. ✓ |
| `transactions.ts:427` passes `amount: txAmount` (a `Math.abs(Number(...))`-coerced number, not Decimal). Test must use number, not Decimal, in `.toHaveBeenCalledWith` arg comparison. | Plan documents the exact arg shape. |
| `invites.ts:105` calls `sendWorkspaceInvitePush(env, invitee.id, displayName({...}), ws.name)`. The `displayName` helper returns name OR email-localpart. Test must compute the expected displayName for the assertion. | Either compute it via shared lib OR use `expect.any(String)` if we don't care about exact text. Plan: use `expect.stringContaining(<inviter's name>)` or assert just the userId+wsName args. |
| `signUpAndGetCookie` creates a user + workspace via bootstrap. We need the owner's userId to assert `excludeUserId` in test 2. | `signUpAndGetCookie` returns `{userId, email, cookie}` per Plan 1L precedent. ✓ |
| Invite "existing user" — User row must exist BEFORE invite created. The invite flow does `prisma.user.findUnique({where: {email}})` at invites.ts:101. | Pre-create User via `prisma.user.create({data: {...}})` after owner setup but before POST invite. |
| Plaid + other side effects from POST manual tx | Manual tx route is local-only; no Plaid involvement. ✓ |
| Test 6 mock-rejection setup — `mockRejectedValueOnce` then expect call to NOT throw at the HTTP layer (caught by invites.ts try/catch) | `expect(response.statusCode).toBe(201)` confirms the route succeeded despite the push throw. |

## 6. Success criteria

- 6 new tests pass.
- Full `@fina/api` suite regression: 0 new fails.
- Typecheck baseline unchanged.
- 1 commit, test-only.

## 7. Follow-ups

- Plaid webhook → `sendBankReconnectPush` integration (deferred — JWKS/signature setup).
- `me.ts:/notifications/test` debug endpoint integration tests.
- E2E test through real Expo SDK (separate plan; would require staging credentials).
- Push wiring tests on accept-invite flow (`/invites/by-token/:token/accept`).
