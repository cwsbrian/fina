# Plan 2C-push-cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mobile sign-out 시 `DELETE /devices`를 호출해서 해당 device의 `UserDevice` row를 즉시 제거 (lazy `DeviceNotRegistered` cleanup 의존도 해소).

**Architecture:** 4 task-commits, shared-first. `@fina/shared`에 `UnregisterDeviceBody` zod + `removedDeviceCount` LogContext 필드 추가 → API에 `DELETE /devices` 핸들러 + 6 신규 테스트 → mobile push 헬퍼에 `unregisterForPushNotifications` 추가 → `more.tsx` sign-out 두 callsite에서 wire. Best-effort: cleanup 실패해도 signOut 정상 진행.

**Tech Stack:** Fastify 5, Prisma 5 (`userDevice.deleteMany`), Vitest singleFork (real Postgres on port 5433), Better-Auth (mobile sign-out via `authClient.signOut`), `expo-notifications` + `expo-constants` (mobile token re-fetch).

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-22-plan-2c-push-cleanup-design.md` (HEAD `a1f9f80`). Authoritative.
- **2C-push base:** shipped at merge `5c2da1b`. `UserDevice` table, `POST /devices`, `registerForPushNotifications`, EAS projectId placeholder check — all 이미 존재.
- **Worktree:** Implementation runs in `.worktrees/plan-2c-push-cleanup` (will be created at implementation kickoff via `using-git-worktrees`).
- **Test command:** `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>`.
- **CLAUDE.md rule:** `@fina/shared` 변경은 자기 commit으로 먼저, 그 후 consumer commit. T1이 강제함.
- **Test discipline:** `vi.spyOn(prisma, ...)` and Prisma delegate properties FORBIDDEN (commit `3ecc538`). Use real DB + truncate.
- **Patterns reused:**
  - `requireSession(req, app)` from `apps/api/src/auth/context.ts`.
  - `HttpError` from same file.
  - `prisma` from `apps/api/src/db.js`.
  - `logInfo`/`logWarn`/`logError` from `apps/api/src/logger.js`.
  - `signUpAndGetCookie` from `apps/api/tests/helpers/auth.js` → returns `{ userId, email, cookie }`.
  - `truncateAll`, `disconnect` from `apps/api/tests/helpers/db.js`.
  - `testEnv()` from `apps/api/tests/helpers/test-env.js`.
  - Devices route test pattern: shared `app` via `beforeAll` + `truncateAll` per test (1K cleanup convention).

## File map

| File | Action | Task |
|---|---|---|
| `libs/shared/src/schemas/devices.ts` | Modify — append `UnregisterDeviceBody` zod | T1 |
| `libs/shared/src/logging.ts` | Modify — add `removedDeviceCount?: number` to `LogContext` | T1 |
| `apps/api/src/routes/devices.ts` | Modify — add `DELETE /devices` handler inside `devicesRoutes()` | T2 |
| `apps/api/tests/devices.routes.test.ts` | Modify — add `describe("DELETE /devices", ...)` block with 6 tests | T2 |
| `apps/mobile/src/api/push.ts` | Modify — add `unregisterForPushNotifications` sibling helper | T3 |
| `apps/mobile/app/(tabs)/more.tsx` | Modify — wire both sign-out callsites | T4 |

---

## Task 1: `@fina/shared` — `UnregisterDeviceBody` + `removedDeviceCount`

**Goal:** Land shared additions BEFORE any API/mobile consumer.

**Files:**
- Modify: `libs/shared/src/schemas/devices.ts`
- Modify: `libs/shared/src/logging.ts`

- [ ] **Step 1.1: Append `UnregisterDeviceBody` to `devices.ts`**

In `libs/shared/src/schemas/devices.ts`, append below the existing `RegisterDeviceBody` block:

```ts
/** Body for DELETE /devices. Mobile sends on sign-out (after re-fetching
 *  the current Expo push token via Notifications.getExpoPushTokenAsync).
 *  See Plan 2C-push-cleanup. */
export const UnregisterDeviceBody = z.object({
  expoPushToken: z.string().min(1, "expoPushToken required"),
}).strict();

export type UnregisterDeviceBody = z.infer<typeof UnregisterDeviceBody>;
```

- [ ] **Step 1.2: Verify shared `index.ts` already re-exports devices**

```bash
grep "schemas/devices" libs/shared/src/index.ts
```

Expected: `export * from "./schemas/devices.js";` (added by 2C T1). Wildcard re-export → new `UnregisterDeviceBody` auto-flows. No edit needed.

- [ ] **Step 1.3: Add `removedDeviceCount` to `LogContext`**

In `libs/shared/src/logging.ts`, find the closing `};` of the `LogContext` type. Insert before it:

```ts
  /** Sign-out cleanup (Plan 2C-push-cleanup). deleteMany count
   *  (보통 0 또는 1; 0이어도 audit trail로 로깅). */
  removedDeviceCount?: number;
```

- [ ] **Step 1.4: Typecheck shared lib**

```bash
pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json
```

Expected: no output.

- [ ] **Step 1.5: Commit**

```bash
git add libs/shared/src/schemas/devices.ts libs/shared/src/logging.ts
git commit -m "feat(@fina/shared): UnregisterDeviceBody + removedDeviceCount

Body schema for DELETE /devices (Plan 2C-push-cleanup) — mobile
sends on sign-out (best-effort) to immediately remove the
UserDevice row, before lazy DeviceNotRegistered cleanup kicks in.

removedDeviceCount LogContext field for typed audit logging
(deleteMany count, usually 0 or 1).

No new error codes; reuses invalid_body / unauthorized from
POST /devices contract."
```

---

## Task 2: API `DELETE /devices` route + 6 integration tests

**Goal:** New route on the existing `devicesRoutes(app)` plugin + 6 tests covering auth gate, idempotency, userId scoping, multi-account scenario.

**Files:**
- Modify: `apps/api/src/routes/devices.ts`
- Modify: `apps/api/tests/devices.routes.test.ts`

- [ ] **Step 2.1: Write the 6 failing tests**

In `apps/api/tests/devices.routes.test.ts`, append a new `describe` block AFTER the existing `describe("POST /devices", ...)` block (use the existing `app`, `beforeAll`, `truncateAll` infrastructure — do NOT duplicate it):

```ts
describe("DELETE /devices", () => {
  it("requires session (401 when no cookie)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[abc]" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("deletes the matching UserDevice row (204)", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "del1@t.co" });
    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[del1]", platform: "ios" }),
    });
    expect(await prisma.userDevice.count({ where: { userId } })).toBe(1);

    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[del1]" }),
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.userDevice.count({ where: { userId } })).toBe(0);
  });

  it("idempotent — returns 204 even when row already absent", async () => {
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "del2@t.co" });
    expect(await prisma.userDevice.count({ where: { userId } })).toBe(0);
    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[never-registered]" }),
    });
    expect(res.statusCode).toBe(204);
  });

  it("rejects empty token (400 invalid_body)", async () => {
    const { cookie } = await signUpAndGetCookie(app, { email: "del3@t.co" });
    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("only deletes the caller's row, never another user's (same-token scope)", async () => {
    // Multi-account device scenario (2C T3): UserA and UserB BOTH register the
    // same token T. UserA DELETE → only UserA's row gone, UserB's intact.
    const userA = await signUpAndGetCookie(app, { email: "del4-a@t.co" });
    const userB = await signUpAndGetCookie(app, { email: "del4-b@t.co" });
    const sharedToken = "ExponentPushToken[shared-delete]";
    for (const u of [userA, userB]) {
      await app.inject({
        method: "POST",
        url: "/devices",
        headers: { cookie: u.cookie, "content-type": "application/json" },
        payload: JSON.stringify({ expoPushToken: sharedToken, platform: "ios" }),
      });
    }
    expect(await prisma.userDevice.count()).toBe(2);

    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { cookie: userA.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: sharedToken }),
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.userDevice.count({ where: { userId: userA.userId } })).toBe(0);
    expect(await prisma.userDevice.count({ where: { userId: userB.userId } })).toBe(1);
  });

  it("delete with a token nobody else owns is a no-op for others", async () => {
    // UserA has token T. UserB has different token T'. UserA DELETE with T →
    // UserA gone, UserB untouched (WHERE userId=A AND token=T).
    const userA = await signUpAndGetCookie(app, { email: "del5-a@t.co" });
    const userB = await signUpAndGetCookie(app, { email: "del5-b@t.co" });
    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie: userA.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[A]", platform: "ios" }),
    });
    await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie: userB.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[B]", platform: "android" }),
    });

    const res = await app.inject({
      method: "DELETE",
      url: "/devices",
      headers: { cookie: userA.cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[A]" }),
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.userDevice.count({ where: { userId: userA.userId } })).toBe(0);
    expect(await prisma.userDevice.count({ where: { userId: userB.userId } })).toBe(1);
  });
});
```

- [ ] **Step 2.2: Run the failing tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/devices.routes.test.ts
```

Expected: 6 NEW tests fail with 404 (route doesn't exist yet); existing POST tests still pass.

- [ ] **Step 2.3: Add imports to `devices.ts`**

In `apps/api/src/routes/devices.ts`, find the existing imports near the top. Add:

```ts
import { UnregisterDeviceBody } from "@fina/shared";
import { logInfo } from "../logger.js";
```

(The existing imports — `RegisterDeviceBody`, `requireSession`, `HttpError`, `prisma` — are already in the file.)

- [ ] **Step 2.4: Add DELETE handler inside `devicesRoutes(app)`**

Inside `apps/api/src/routes/devices.ts`, locate the existing `export async function devicesRoutes(app: FastifyInstance) { ... }`. Directly AFTER the `app.post("/devices", ...)` handler (still inside the function body), add:

```ts
  app.delete("/devices", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = UnregisterDeviceBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const { expoPushToken } = parsed.data;
      const result = await prisma.userDevice.deleteMany({
        where: { userId: session.userId, expoPushToken },
      });
      // count=0도 로깅 — DELETE가 호출됐다는 audit trail (token rotation /
      // lazy cleanup 후 호출 등 무해한 케이스 추적용).
      logInfo(
        { userId: session.userId, removedDeviceCount: result.count },
        "device unregistered via sign-out",
      );
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

- [ ] **Step 2.5: Run tests — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/devices.routes.test.ts
```

Expected: 12 tests pass (6 POST + 6 DELETE).

- [ ] **Step 2.6: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | tail -5
```

Expected: only pre-existing baseline errors. No new errors.

- [ ] **Step 2.7: Commit**

```bash
git add apps/api/src/routes/devices.ts apps/api/tests/devices.routes.test.ts
git commit -m "feat(api): DELETE /devices — sign-out cleanup

Mobile calls on sign-out (best-effort) to immediately drop the
UserDevice row instead of relying on the next push's
DeviceNotRegistered receipt.

deleteMany scoped to (userId, expoPushToken):
- idempotent: 204 even when row already absent (lazy cleanup ran
  first, or token rotated mid-session)
- secure: userId WHERE clause means even if Mallory knows Alice's
  push token, Mallory can't DELETE Alice's row from their session

Returns 204 + structured logInfo with removedDeviceCount (logs
count=0 too — audit trail that DELETE was attempted).

Tests: 6 new in devices.routes.test.ts covering 401, basic delete,
idempotency, invalid body, same-token multi-account scope,
token-mismatch no-op."
```

---

## Task 3: Mobile `unregisterForPushNotifications` helper

**Goal:** Sibling to `registerForPushNotifications` — re-fetch token + DELETE /devices, all failure paths silent.

**Files:**
- Modify: `apps/mobile/src/api/push.ts`

- [ ] **Step 3.1: Add `unregisterForPushNotifications` to `push.ts`**

In `apps/mobile/src/api/push.ts`, append AFTER `registerForPushNotifications`:

```ts
/** Best-effort: re-fetches the current Expo push token + DELETE /devices.
 *  Called from sign-out flow before `signOut()` to immediately drop the
 *  UserDevice row. Failures silent — sign-out continues regardless; stale
 *  rows get cleaned by the next push's DeviceNotRegistered receipt. */
export async function unregisterForPushNotifications(): Promise<void> {
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId || projectId === EAS_PROJECT_ID_PLACEHOLDER) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;

    await apiFetch("/devices", {
      method: "DELETE",
      body: JSON.stringify({ expoPushToken: token }),
    });
  } catch {
    // Best-effort — sign-out 계속 진행. Stale row는 다음 push DeviceNotRegistered.
  }
}
```

- [ ] **Step 3.2: Typecheck mobile**

```bash
pnpm --filter @fina/mobile exec tsc --noEmit 2>&1 | tail -5
```

Expected: no new errors.

- [ ] **Step 3.3: Commit**

```bash
git add apps/mobile/src/api/push.ts
git commit -m "feat(mobile): unregisterForPushNotifications helper

Sibling to registerForPushNotifications:
1. Read EAS projectId from Constants.expoConfig.extra.eas.projectId
   (placeholder guard reuses EAS_PROJECT_ID_PLACEHOLDER constant)
2. getExpoPushTokenAsync({ projectId }) — Expo caches so no network
3. apiFetch DELETE /devices { expoPushToken: token }

Every failure path silent (catch swallows) — sign-out flow must
continue regardless of cleanup outcome. Stale rows fall back to
the next push's DeviceNotRegistered cleanup (2C-push).

Wired into more.tsx sign-out callsites in T4."
```

---

## Task 4: Mobile `more.tsx` — wire two sign-out callsites + manual smoke

**Goal:** Both sign-out callsites call `unregisterForPushNotifications()` BEFORE `signOut()`.

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`

- [ ] **Step 4.1: Read the file to locate callsites**

Open `apps/mobile/app/(tabs)/more.tsx`. Locate:
1. The Alert dialog's "Sign out" destructive option (`onPress: async () => { await signOut(); router.replace(...); }`).
2. The `__DEV__`-only sign-out button (a second `<Pressable>` styled `[styles.signOutBtn, styles.devBtn]`).

- [ ] **Step 4.2: Add the import**

At the top of the file, add to the existing `push` API import block (or as a new import):

```ts
import { unregisterForPushNotifications } from "../../src/api/push";
```

If `more.tsx` doesn't currently import anything from `../../src/api/push`, add the line as a sibling to `signOut` import:

```ts
import { useSession, signOut } from "../../src/auth/client";
import { unregisterForPushNotifications } from "../../src/api/push";
```

- [ ] **Step 4.3: Wire callsite 1 (regular sign-out)**

Find the `const onSignOut = () => { Alert.alert(...) }` function (`more.tsx` ~line 74). Inside the Alert's buttons array, locate the destructive option (`{ text: "Sign out", style: "destructive", onPress: async () => { ... } }`). Add `await unregisterForPushNotifications()` as the FIRST line inside the async arrow:

```ts
onPress: async () => {
  await unregisterForPushNotifications();
  await signOut();
  router.replace("/" as never);
},
```

- [ ] **Step 4.4: Wire callsite 2 (dev sign-out)**

Find the second `<Pressable>` (in the `__DEV__` block). Its `onPress` also calls `await signOut()`. Add `await unregisterForPushNotifications()` as the FIRST line:

```ts
onPress: async () => {
  await unregisterForPushNotifications();
  await signOut();
  // ... 기존 dev cleanup 코드 그대로 두기
},
```

- [ ] **Step 4.5: Typecheck mobile**

```bash
pnpm --filter @fina/mobile exec tsc --noEmit 2>&1 | tail -5
```

Expected: no new errors (smoke that the `unregisterForPushNotifications` export is reachable from `more.tsx` — fulfills spec §6's "type-level smoke" requirement).

- [ ] **Step 4.6: Manual smoke (도큐먼트만, 실제 실행은 implementer가 환경에서 직접)**

Spec §4 notes DELETE-with-body has no in-repo prior art (web DELETE routes all use path params). Before declaring T4 done, the implementer should perform ONE manual smoke:

1. API + mobile dev 서버 켜기 (Tailscale: `CRON_ENABLED=true pnpm smoke:api:lan` + `pnpm smoke:mobile:lan`).
2. Mobile에서 로그인 → push 권한 grant.
3. `psql "postgresql://fina:fina@localhost:5433/fina" -c "SELECT * FROM user_devices;"` → row 1개 확인.
4. Mobile에서 sign-out (regular).
5. 같은 SELECT 다시 → row 0개 확인.
6. API stdout에서 `device unregistered via sign-out` 로그 확인 (with `removedDeviceCount: 1`).

Smoke 실패 시 (예: row가 여전히 존재) — implementer가 디버그 (apiFetch가 body를 실제로 보냈는지 확인 등). 실패 원인이 RN fetch DELETE-body issue로 판명되면 spec §4의 "no in-repo prior art" 메모가 적중한 것 — fallback으로 query param 패턴 (`DELETE /devices?expoPushToken=...`)으로 전환 고려.

Smoke 통과 시 다음 step.

- [ ] **Step 4.7: Commit**

```bash
git add apps/mobile/app/\(tabs\)/more.tsx
git commit -m "feat(mobile): wire push cleanup into sign-out flow

Both sign-out callsites in more.tsx (regular Alert destructive +
__DEV__-only quick reset) now call unregisterForPushNotifications()
BEFORE signOut() — must run before session cookie expires.

Manual smoke verified (DELETE-with-body works in RN; no need for
fallback to query-param form per spec §4 note)."
```

---

## Final verification

After all 4 tasks land:

- [ ] **Verify spec §8 success criteria**

```bash
# 1. devices.routes.test.ts now has 12 tests (6 POST + 6 DELETE):
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/devices.routes.test.ts 2>&1 | tail -5
# Expected: "Tests  12 passed (12)"

# 2. Full API suite passes (no regression):
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -5
# Expected: ~1053 pass (1047 prior + 6 new) / 2 known plaid baseline flakes / 1 todo.

# 3. All typechecks clean:
pnpm --filter @fina/api exec tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | tail -5
pnpm --filter @fina/mobile exec tsc --noEmit 2>&1 | tail -5
pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json 2>&1 | tail -5
# Expected: only pre-existing baseline errors.
```

- [ ] **Smoke verified at T4.6** (DB row inspection after real mobile sign-out).
