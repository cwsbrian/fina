# Plan 1N-notification-prefs-test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 15-test coverage to `notification_prefs` system across 3 layers (shared lib resolveNotificationPrefs / me.routes PATCH+GET / push.send channel gate) — currently 0 tests.

**Architecture:** 3 task-commits, no production code changes. T1 ships pure unit tests in `libs/shared/src/notifications.test.ts` (new). T2 extends `apps/api/tests/me.test.ts` with PATCH/GET prefs cases. T3 extends `apps/api/tests/push.send.test.ts` with channel-gate spot check for 2 representative channels.

**Tech Stack:** Vitest 2.1.5, Prisma 5.22, real Postgres :5433 for API tests, pure unit tests for shared.

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-25-plan-1n-notification-prefs-test-design.md` (HEAD `12756a3`). Authoritative.
- **Production code (unchanged):**
  - `libs/shared/src/notifications.ts:71-78` — `resolveNotificationPrefs(stored)`: returns defaults if not object; copies only known boolean keys.
  - `libs/shared/src/notifications.ts:35-44` — `DEFAULT_NOTIFICATION_PREFS` (8 channels all true).
  - `libs/shared/src/notifications.ts:46-57` — `NotificationPrefsSchema` (`z.object({...}).partial()` — strips unknowns by default).
  - `apps/api/src/routes/me.ts:71` — GET /me returns `resolveNotificationPrefs(user.notificationPrefs)`.
  - `apps/api/src/routes/me.ts:175-186` — PATCH merge: `{ ...current, ...body.notificationPrefs }`.
  - `apps/api/src/push/send.ts:11-22` — `isChannelEnabled(userId, channel)` private.
  - `apps/api/src/push/send.ts:145,168,185,205,231,252,271,289` — 8 wrappers gated.
- **Test infra:**
  - `libs/shared/vite.config.ts` — `include: src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}` (verified covers new `notifications.test.ts`).
  - `apps/api/tests/me.test.ts:55+` — per-test `buildApp(env)` pattern, `signUpAndGetCookie(app, { email })` returns `{ userId, email, cookie }`.
  - `apps/api/tests/push.send.test.ts:31-42` — `makeUserWithDevices(tokens)` helper. Module-scope `vi.mock("expo-server-sdk")` with prototype `sendPushNotificationsAsync`. `afterEach(restoreAllMocks)`.
- **Discipline:**
  - `vi.spyOn(prisma, ...)` and Prisma delegate properties FORBIDDEN (commit `3ecc538`).
  - T1 has no @fina/shared API change (test file only) — commit ordering is convention not hard dependency.

## File map

| File | Action | Task |
|---|---|---|
| `libs/shared/src/notifications.test.ts` | Create — 7 unit tests for resolveNotificationPrefs | T1 |
| `apps/api/tests/me.test.ts` | Modify — append `describe("notificationPrefs", ...)` block with 4 tests | T2 |
| `apps/api/tests/push.send.test.ts` | Modify — extend `makeUserWithDevices` helper signature + append 4 channel-gate tests | T3 |

---

## Task 1: `libs/shared/src/notifications.test.ts` — 7 unit tests

**Goal:** Pure-function unit tests for `resolveNotificationPrefs`. Smallest task, no DB, no API.

**Files:**
- Create: `libs/shared/src/notifications.test.ts`

- [ ] **Step 1.1: Create the test file**

Create `libs/shared/src/notifications.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { resolveNotificationPrefs, DEFAULT_NOTIFICATION_PREFS } from "./notifications.js";

describe("resolveNotificationPrefs", () => {
  it("null → all defaults", () => {
    expect(resolveNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("undefined → all defaults", () => {
    expect(resolveNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("non-object inputs (string/number/array) → all defaults", () => {
    expect(resolveNotificationPrefs("foo")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs(42)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs([])).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("empty object → all defaults", () => {
    expect(resolveNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("partial { morningBrief: false } → that key false, others default", () => {
    const out = resolveNotificationPrefs({ morningBrief: false });
    expect(out.morningBrief).toBe(false);
    expect(out.largeCharges).toBe(true);
    expect(out.bankReconnect).toBe(true);
    expect(out.workspaceInvites).toBe(true);
    expect(out.trialExpiring).toBe(true);
    expect(out.goalMilestones).toBe(true);
    expect(out.transactionAdded).toBe(true);
    expect(out.productUpdates).toBe(true);
  });

  it("non-boolean values for known keys are ignored (default kept)", () => {
    const out = resolveNotificationPrefs({ morningBrief: "yes", largeCharges: 0 });
    expect(out.morningBrief).toBe(true);  // "yes" rejected → default
    expect(out.largeCharges).toBe(true);  // 0 rejected → default
  });

  it("unknown keys are silently dropped from the result", () => {
    const out = resolveNotificationPrefs({ foo: false, bar: true, morningBrief: false });
    expect(out.morningBrief).toBe(false);
    // Result shape matches the 8-key contract exactly — no extra keys leak.
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(DEFAULT_NOTIFICATION_PREFS).sort(),
    );
  });
});
```

- [ ] **Step 1.2: Run T1 tests**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec vitest run 2>&1 | tail -10
```

Expected: 7/7 pass. Vitest's `include` pattern picks up `src/**/*.test.ts`.

- [ ] **Step 1.3: Typecheck shared**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json 2>&1 | tail -5
```

Expected: clean (no errors).

**Note**: `tsconfig.lib.json` excludes `*.test.ts` files. The correct command for typechecking the new test file is:

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.spec.json 2>&1 | tail -5
```

Use the `spec` variant for any test-file typecheck verification.

- [ ] **Step 1.4: Commit T1**

```bash
cd /home/cwsbr/personal/fina && git add libs/shared/src/notifications.test.ts && git commit -m "test(@fina/shared): resolveNotificationPrefs unit tests

Plan 1N-notification-prefs-test T1. 7 pure-function unit tests
covering all branches of resolveNotificationPrefs:
- null / undefined / non-object → all defaults
- empty object → all defaults
- partial known keys → spec'd keys override, others default
- non-boolean values for known keys → ignored (default kept)
- unknown keys → silently dropped from result (8-key contract via
  Object.keys shape assertion)

No production code changes."
```

---

## Task 2: `apps/api/tests/me.test.ts` extension — PATCH/GET notificationPrefs (4 tests)

**Goal:** Verify PATCH /me partial merge + GET /me returns resolved prefs.

**Files:**
- Modify: `apps/api/tests/me.test.ts`

- [ ] **Step 2.1: Read existing file to find insertion point**

Read `apps/api/tests/me.test.ts`. Locate the last `describe(...)` block. The new `describe("notificationPrefs", ...)` block goes at file end.

Existing pattern:
- Per-test `buildApp(env)` — each `it` creates its own app instance.
- `beforeEach(truncateAll)`, `afterAll(disconnect)`.
- `signUpAndGetCookie(app, { email, name? })` → `{ userId, email, cookie }`.
- Direct `prisma.user.update` for fixture setup (e.g., expiring trial).

- [ ] **Step 2.2: Append new describe block**

At the end of `apps/api/tests/me.test.ts`, append:

```ts
describe("PATCH /me notificationPrefs", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("PATCH applies new prefs (single field) → 200 + merged blob persisted", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np1@t.co" });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { morningBrief: false } }),
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, boolean>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.largeCharges).toBe(true);  // default merged in by route
    await app.close();
  });

  it("PATCH merges with existing prefs across 2 sequential patches", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np2@t.co" });

    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { morningBrief: false } }),
    });
    await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ notificationPrefs: { largeCharges: false } }),
    });

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, boolean>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.largeCharges).toBe(false);
    expect(blob.bankReconnect).toBe(true);  // untouched default
    await app.close();
  });

  it("GET returns fully-populated notificationPrefs (defaults for unset)", async () => {
    const app = await buildApp(env);
    const { cookie } = await signUpAndGetCookie(app, { email: "np3@t.co" });

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { notificationPrefs: Record<string, boolean> };
    expect(body.notificationPrefs).toEqual({
      morningBrief: true,
      bankReconnect: true,
      workspaceInvites: true,
      trialExpiring: true,
      goalMilestones: true,
      largeCharges: true,
      transactionAdded: true,
      productUpdates: true,
    });
    await app.close();
  });

  it("PATCH silently drops unknown keys (zod .partial() default-strip)", async () => {
    const app = await buildApp(env);
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "np4@t.co" });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        notificationPrefs: { unknown: false, morningBrief: false },
      }),
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const blob = fresh.notificationPrefs as Record<string, unknown>;
    expect(blob.morningBrief).toBe(false);
    expect(blob.unknown).toBeUndefined();
    await app.close();
  });
});
```

- [ ] **Step 2.3: Run T2 tests + existing**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/me.test.ts 2>&1 | tail -8
```

Expected: existing me.test.ts tests still pass + 4 new tests pass.

- [ ] **Step 2.4: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same baseline count.

- [ ] **Step 2.5: Commit T2**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/me.test.ts && git commit -m "test(api): PATCH /me notificationPrefs partial merge + GET resolved prefs

Plan 1N-notification-prefs-test T2. Appends 4 tests to me.test.ts
in a new describe(\"PATCH /me notificationPrefs\") block:

1. PATCH single field → 200 + merged blob persists with route's
   defaults-spread behavior (me.ts:182-186).
2. 2 sequential PATCHes merge cumulatively — both overrides survive.
3. GET /me on freshly-signed-up user returns all 8 keys = true
   (defaults applied at the route via resolveNotificationPrefs).
4. PATCH with unknown key + known key → zod .partial() strips
   unknown, known persists.

No production code changes."
```

---

## Task 3: `apps/api/tests/push.send.test.ts` extension — channel gate (4 tests)

**Goal:** Spot-check the `isChannelEnabled` gate via 2 representative channels (morningBrief + largeCharges) × {enabled, disabled} = 4 tests.

**Files:**
- Modify: `apps/api/tests/push.send.test.ts`

- [ ] **Step 3.1: Read existing helper**

Read `apps/api/tests/push.send.test.ts` lines 31-42. Locate `makeUserWithDevices(tokens)`. Its current shape (verify):

```ts
async function makeUserWithDevices(tokens: Array<{ token: string; platform: "ios" | "android" }>) {
  const u = await prisma.user.create({
    data: { id: `push-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            email: `push-${Date.now()}@t.co`, name: "P" },
  });
  for (const t of tokens) {
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: t.token, platform: t.platform },
    });
  }
  return u;
}
```

- [ ] **Step 3.2: Extend helper signature**

In `apps/api/tests/push.send.test.ts`, modify `makeUserWithDevices` to accept an optional `notificationPrefs` second arg:

```ts
async function makeUserWithDevices(
  tokens: Array<{ token: string; platform: "ios" | "android" }>,
  notificationPrefs?: Record<string, boolean>,
) {
  const u = await prisma.user.create({
    data: { id: `push-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            email: `push-${Date.now()}@t.co`, name: "P" },
  });
  for (const t of tokens) {
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: t.token, platform: t.platform },
    });
  }
  if (notificationPrefs) {
    await prisma.user.update({
      where: { id: u.id },
      data: { notificationPrefs },
    });
  }
  return u;
}
```

The optional 2nd param is backward-compatible — existing 5 call sites pass only `tokens`.

- [ ] **Step 3.3: Append channel-gate describe block**

At the end of `apps/api/tests/push.send.test.ts`, append:

```ts
describe("channel gate (notificationPrefs)", () => {
  it("sendBriefPush respects morningBrief: false → no Expo call", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices(
      [{ token: "ExponentPushToken[gate-mb-off]", platform: "ios" }],
      { morningBrief: false },
    );

    const { sendBriefPush } = await import("../src/push/send.js");
    await sendBriefPush(testEnv(), u.id, "brief text");

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("sendBriefPush with default prefs (null) → Expo called once", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[gate-mb-on]", platform: "ios" },
    ]);

    const { sendBriefPush } = await import("../src/push/send.js");
    await sendBriefPush(testEnv(), u.id, "brief text");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sendLargeChargePush respects largeCharges: false → no Expo call", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices(
      [{ token: "ExponentPushToken[gate-lc-off]", platform: "ios" }],
      { largeCharges: false },
    );

    const { sendLargeChargePush } = await import("../src/push/send.js");
    await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("sendLargeChargePush with default prefs (null) → Expo called once", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[gate-lc-on]", platform: "ios" },
    ]);

    const { sendLargeChargePush } = await import("../src/push/send.js");
    await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
```

Spies installed per-test. `afterEach(restoreAllMocks)` (already in file at line 28) clears spies between tests.

- [ ] **Step 3.4: Run T3 tests + existing**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.send.test.ts 2>&1 | tail -8
```

Expected: existing push.send tests still pass + 4 new channel-gate tests pass.

- [ ] **Step 3.5: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same baseline.

- [ ] **Step 3.6: Commit T3**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/tests/push.send.test.ts && git commit -m "test(api): push/send channel gate — spot check morningBrief + largeCharges

Plan 1N-notification-prefs-test T3. Extends makeUserWithDevices
helper with optional notificationPrefs 2nd param (backward-compatible
with 5 existing call sites — defaults to null). Appends 4 channel-
gate tests in a new describe block:

- sendBriefPush + morningBrief:false → spy NOT called
- sendBriefPush + default prefs (null) → spy called once
- sendLargeChargePush + largeCharges:false → spy NOT called
- sendLargeChargePush + default prefs (null) → spy called once

Assertion via vi.spyOn(Expo.prototype, sendPushNotificationsAsync)
call count only (NOT result.sent — default mock returns [] so
result.sent stays 0 regardless). Other 6 channels' gates use
identical code path — YAGNI per spec.

No production code changes."
```

---

## Final verification

After all 3 task-commits land:

- [ ] **Full API suite regression**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -8
```

Expected: 0 fail (or known baseline flakes only).

- [ ] **Shared lib tests pass**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/shared exec vitest run 2>&1 | tail -8
```

Expected: 7/7 pass.

- [ ] **3-commit chain verified**

```bash
cd /home/cwsbr/personal/fina && git log --oneline -4
```

Expected: T1 → T2 → T3 in order.

- [ ] **3 files changed total**

```bash
cd /home/cwsbr/personal/fina && git diff main~3 --stat
```

Expected: 3 files — `libs/shared/src/notifications.test.ts` (new), `apps/api/tests/me.test.ts` (modified), `apps/api/tests/push.send.test.ts` (modified). No production code touched.
