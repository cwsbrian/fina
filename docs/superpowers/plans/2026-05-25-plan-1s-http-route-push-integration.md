# Plan 1S — HTTP route → push integration tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 6 integration tests verifying HTTP routes fire push effects (anomaly + member fan-out + invite). Real Fastify, real Postgres, partial `vi.mock` for 3 push helpers. 1 task, 1 commit. Closes Plan 1P §7 #3.

**Architecture:** Three partial `vi.mock`s — `../src/push/anomaly.js`, `../src/push/transaction-added.js`, `../src/push/send.js` — replacing the three call-site helpers with `vi.fn().mockResolvedValue(...)`. Other exports preserved via `...actual` spread. `afterEach(vi.clearAllMocks)` per Plan 1M precedent. `await new Promise(setImmediate)` drains fire-and-forget queue between request and assertion (mocked helpers resolve in 1 microtask tick — safe).

**Tech Stack:** Vitest 2.x, Fastify (real app via `buildApp`), Prisma, `app.inject` for HTTP.

---

## File Structure

- **Create:** `apps/api/tests/http.push-integration.test.ts` — Task 1.

No production code changes. No `@fina/shared` changes.

---

## Task 1: `http.push-integration.test.ts` (6 tests, 1 commit)

**Files:**
- Create: `apps/api/tests/http.push-integration.test.ts`

- [ ] **Step 1: Read precedent + production**

Read these files to ground the test:
- `apps/api/src/routes/transactions.ts:395-450` — POST manual route, focusing on the `void checkLargeChargeAndPush(...)` + `void notifyTransactionAdded(...)` block at lines 421-440.
- `apps/api/src/routes/invites.ts:47-120` — POST invites route, focusing on `sendWorkspaceInvitePush` call at line 105 inside try/catch (99-114).
- `apps/api/src/push/anomaly.ts` — confirm `checkLargeChargeAndPush(env, args)` signature.
- `apps/api/src/push/transaction-added.ts` — confirm `notifyTransactionAdded(env, args)` signature.
- `apps/api/src/push/send.ts` (line 283) — confirm `sendWorkspaceInvitePush(env, userId, inviterName, workspaceName)` signature.
- `apps/api/tests/push.anomaly.test.ts` lines 13-24 — Plan 1M partial-mock + clearAllMocks pattern.
- `apps/api/tests/helpers/auth.ts:33` — `signUpAndGetCookie({name?, email?})` returns `{userId, email, cookie}`; `getOwnerWorkspaceId(userId)` returns workspace id.

**Schema reminders:**
- `ManualTxBody = { merchantRaw: string (required), amount: number, occurredAt?, categoryId?, note?, accountId? }`. **`merchantRaw` is required.**
- `CreateInviteBody = { email: string, role: "editor"|"viewer" }`.

**Guardrail:** Do NOT edit any production file. Test-only addition.

- [ ] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
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

/** Flush microtask + macrotask once so `void asyncFn()` settles. Mocks
 *  resolve synchronously, so a single setImmediate is sufficient. */
async function drainFireAndForget(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("POST /workspaces/:id/transactions/manual — push integration", () => {
  it("fires checkLargeChargeAndPush with env + correct args", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o1@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ merchantRaw: "Coffee Shop", amount: 30 }),
    });
    expect(res.statusCode).toBe(201);

    await drainFireAndForget();

    const calls = vi.mocked(anomalyMod.checkLargeChargeAndPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      env,
      expect.objectContaining({
        transactionId: expect.any(String),
        workspaceId: wsId,
        amount: 30,
        merchant: expect.any(String),
      }),
    ]);

    await app.close();
  });

  it("fires notifyTransactionAdded with env + excludeUserId=actor + categoryName null", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ merchantRaw: "Restaurant", amount: 30 }),
    });
    expect(res.statusCode).toBe(201);

    await drainFireAndForget();

    const calls = vi.mocked(addedMod.notifyTransactionAdded).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      env,
      expect.objectContaining({
        workspaceId: wsId,
        merchant: expect.any(String),
        amount: 30,
        categoryName: null,
        excludeUserId: owner.userId,
      }),
    ]);

    await app.close();
  });

  it("invalid body (missing merchantRaw) → 400, no push fires", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ amount: 30 }),  // missing merchantRaw
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");

    await drainFireAndForget();

    expect(vi.mocked(anomalyMod.checkLargeChargeAndPush)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(addedMod.notifyTransactionAdded)).toHaveBeenCalledTimes(0);

    await app.close();
  });
});

describe("POST /workspaces/:id/invites — push integration", () => {
  it("invite to existing user → sendWorkspaceInvitePush called with displayName", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv1@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    // Pre-create the invitee user
    const invitee = await prisma.user.create({
      data: { id: `inv-${Date.now()}`, email: "bob@t.co", name: "Bob" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "bob@t.co", role: "viewer" }),
    });
    expect(res.statusCode).toBe(201);

    const calls = vi.mocked(sendMod.sendWorkspaceInvitePush).mock.calls;
    expect(calls).toHaveLength(1);
    // Args: (env, inviteeId, inviterDisplayName, workspaceName)
    expect(calls[0]?.[0]).toBe(env);
    expect(calls[0]?.[1]).toBe(invitee.id);
    expect(calls[0]?.[2]).toBe("Alice");  // displayName({name: "Alice"}) → "Alice"
    expect(typeof calls[0]?.[3]).toBe("string");  // workspaceName auto-bootstrapped

    await app.close();
  });

  it("invite to non-existing email → no push fires (best-effort skip)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv2@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "stranger@nowhere.com", role: "viewer" }),
    });
    expect(res.statusCode).toBe(201);

    expect(vi.mocked(sendMod.sendWorkspaceInvitePush)).toHaveBeenCalledTimes(0);

    await app.close();
  });

  it("push throws → invite still succeeds (caught at invites.ts:99-114)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "inv3@t.co", name: "Alice" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    await prisma.user.create({
      data: { id: `inv-throws-${Date.now()}`, email: "bob3@t.co", name: "Bob" },
    });

    // Override only this call to reject; subsequent calls fall back to factory's mockResolvedValue.
    vi.mocked(sendMod.sendWorkspaceInvitePush).mockRejectedValueOnce(new Error("boom"));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "content-type": "application/json", "x-workspace-id": wsId },
      payload: JSON.stringify({ email: "bob3@t.co", role: "viewer" }),
    });
    // Route's try/catch swallows the push error; invite is created.
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(sendMod.sendWorkspaceInvitePush)).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
```

- [ ] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/http.push-integration.test.ts`
Expected: `Tests  6 passed (6)`.

Common gotchas:
- `app.inject` needs both `cookie` AND `x-workspace-id` headers per CLAUDE.md HTTP rules.
- `transactions/manual` returns 201 on success per route code; verify in `transactions.ts`.
- POST invites response code — verify (could be 200 or 201). Adjust if needed.
- `void` fire-and-forget: tests 1, 2, 3 need `drainFireAndForget`. Test 4, 5, 6 await directly (sendWorkspaceInvitePush is NOT fire-and-forget; it's `await`-ed inside the route).
- `mockRejectedValueOnce` (test 6) → after the rejection, subsequent calls to the same mock fall back to `mockResolvedValue({ sent: 0, failed: 0 })` from the factory.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "http.push-integration" | head -5`
Expected: 0 lines.

- [ ] **Step 5: Commit**

Branch confirmation: `git branch --show-current` must show `worktree-plan-1s-http-route-push-integration`.

```bash
git add apps/api/tests/http.push-integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): http→push integration — anomaly + notify + invite fan-out (6 tests)

Closes Plan 1P §7 follow-up #3. Verifies POST /transactions/manual fires
both checkLargeChargeAndPush + notifyTransactionAdded with correct args,
POST /workspaces/:id/invites fires sendWorkspaceInvitePush with displayName
for existing users only, and the route's try/catch swallows push errors.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
