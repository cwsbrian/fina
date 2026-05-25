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

### Helpers used (existing, NOT redefined)

- `signUpAndGetCookie(app, { email, name? })` from `tests/helpers/auth.ts` — creates User + bootstraps a Workspace + owner Membership. Returns `{ userId, email, cookie }`.
- `getOwnerWorkspaceId(userId)` from `tests/helpers/auth.ts` — looks up the user's owner workspace and returns its id. Used after `signUpAndGetCookie` to obtain the bootstrapped wsId.

Bank account / categories are seeded only as required by the manual-tx flow (the route resolves a default account when none is specified — verify in `transactions.ts` whether `accountId` is required in `ManualTxBody`. If yes, pre-create one via `prisma.bankAccount.create`; if no, omit).

### 6 test scenarios

**R1+R2 corrections applied below.** Key facts:
- **Body field is `merchantRaw`** (not `merchant`) — `ManualTxBody` schema requires it.
- **`checkLargeChargeAndPush(env, {...})`** — `env` is first positional arg, then options object.
- **`notifyTransactionAdded(env, {...})`** — same pattern.
- **`categoryName` is hardcoded `null`** at `transactions.ts:437` regardless of body's `categoryId`.
- **`merchant` arg** = `result.transaction.merchantNormalized ?? merchantRaw` — depends on normalization service.
- **`signUpAndGetCookie` returns `{userId, email, cookie}`** — use `getOwnerWorkspaceId(userId)` helper for workspace id.
- **Test 3 invalid-body** — `z.number()` accepts negatives; use missing-`merchantRaw` or non-numeric amount to trigger `safeParse` 400.
- **Test 6** — do NOT mock `sendInviteEmail` to throw; the push try/catch at `invites.ts:99-114` only catches the push path.

| # | Route | Setup | Assertion |
|---|---|---|---|
| 1 | POST /workspaces/:id/transactions/manual | Owner via `signUpAndGetCookie({email, name: "Alice"})`. `wsId` via `getOwnerWorkspaceId(owner.userId)`. Body: `{merchantRaw: "Coffee", amount: 30}`. | 201 created. After drain: `vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls[0]` deep-equals `[env, expect.objectContaining({transactionId: expect.any(String), workspaceId: wsId, amount: 30, merchant: expect.any(String)})]`. |
| 2 | POST /workspaces/:id/transactions/manual | Same setup. | After drain: `vi.mocked(addedMod.notifyTransactionAdded).mock.calls[0]` deep-equals `[env, expect.objectContaining({workspaceId: wsId, merchant: expect.any(String), amount: 30, categoryName: null, excludeUserId: owner.userId})]`. |
| 3 | POST /workspaces/:id/transactions/manual with invalid body | Owner. Body: `{amount: 30}` (missing required `merchantRaw`). | 400 invalid_body. After drain: NEITHER `checkLargeChargeAndPush` NOR `notifyTransactionAdded` called (request rejected by `safeParse` before reaching fire-and-forget block). |
| 4 | POST /workspaces/:id/invites with existing user | Owner via `signUpAndGetCookie({email, name: "Alice"})`. `wsId` via `getOwnerWorkspaceId`. Pre-create invitee: `prisma.user.create({data: {id, email: "invitee@t.co", name: "Bob"}})`. Body: `{email: "invitee@t.co", role: "viewer"}`. | 201 created. `vi.mocked(sendMod.sendWorkspaceInvitePush).mock.calls[0]` deep-equals `[env, inviteeId, "Alice", expect.any(String)]` (workspace name auto-bootstrapped per signup; assert via `expect.any(String)`). |
| 5 | POST /workspaces/:id/invites with NON-existing user (no User row) | Owner via signUp. Body: `{email: "noone@nowhere.com", role: "viewer"}`. | 201 created. `sendWorkspaceInvitePush` NOT called (best-effort skip at `invites.ts:101-110`). |
| 6 | POST /workspaces/:id/invites push throws | Pre-create invitee. **Do NOT mock email send** — it must succeed so the route reaches the push block. Mock `sendMod.sendWorkspaceInvitePush.mockRejectedValueOnce(new Error("boom"))`. | 201 created (route's try/catch at `invites.ts:99-114` swallows the push error). `sendWorkspaceInvitePush` called once. |

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
