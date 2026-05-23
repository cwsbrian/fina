# Plan 2C-push-cleanup Design

**Status:** Draft → User review pending
**Predecessor:** Plan 2C-push (shipped 2026-05-22, merge `5c2da1b`)

## 1. Goal & scope

User가 mobile 앱에서 sign-out하면 해당 device의 `UserDevice` row를 명시적으로 삭제. Lazy cleanup (다음 push에서 `DeviceNotRegistered` 받을 때 자동 삭제, 2C에서 구현됨)에 의존하지 않고 즉시 정리해서:

- DB 깨끗하게 유지 (사용자가 새 계정으로 같은 device 로그인 시 stale row 누적 방지).
- 다음 사용자가 같은 device로 로그인할 때 잘못된 user에게 push 가지 않도록 보장.
- Multi-account device scenario에서 push routing 정확도 향상.

**Out of scope:**
- Server-side better-auth session-destroy hook (alternative considered + rejected — multi-device 사용자가 한 폰 로그아웃하면 다른 폰까지 token 잃음).
- "이 user의 모든 device 일괄 삭제" — single-token 단위로 정밀하게.
- Settings UI에서 수동 unregister — 2E 영역 (push 설정 화면).
- Receipt polling cron — v1.5 deferred (별도 plan).

## 2. Shared library touchpoints

**`libs/shared/src/schemas/devices.ts`** — 추가:

```ts
/** Body for DELETE /devices. Mobile sends on sign-out (after re-fetching
 *  the current Expo push token via Notifications.getExpoPushTokenAsync). */
export const UnregisterDeviceBody = z.object({
  expoPushToken: z.string().min(1, "expoPushToken required"),
}).strict();

export type UnregisterDeviceBody = z.infer<typeof UnregisterDeviceBody>;
```

**`libs/shared/src/index.ts`** — 변경 없음. `schemas/devices.js`는 이미 re-export 중 (`export * from "./schemas/devices.js";`이라 새 export 자동 노출). T1 implementer가 `grep "schemas/devices" libs/shared/src/index.ts`로 1줄 확인 권장.

**`libs/shared/src/logging.ts`** — 1개 필드 추가:

```ts
  /** Sign-out cleanup (Plan 2C-push-cleanup). deleteMany count
   *  (보통 0 또는 1). */
  removedDeviceCount?: number;
```

기존 `removedDeviceId`는 lazy cleanup 전용으로 의미 분리.

**CLAUDE.md 규칙대로 T1에서 shared 변경 commit 후 T2+ consumer 변경.**

## 3. API 변경

### Route: `DELETE /devices`

**File:** `apps/api/src/routes/devices.ts` (기존 파일에 handler 추가)

**Imports to add at top:**
```ts
import { UnregisterDeviceBody } from "@fina/shared";
import { logInfo } from "../logger.js";
```
(`RegisterDeviceBody`, `requireSession`, `HttpError`, `prisma`는 이미 import 됨.)

**Handler — place inside the existing `export async function devicesRoutes(app: FastifyInstance)` body, directly after the POST handler:**

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
    // count=0도 로깅 — DELETE가 호출됐다는 audit trail (token rotation / lazy
    // cleanup 후 호출 등 무해한 케이스 추적용).
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

**`deleteMany` 사용 이유:**
- Idempotent: row가 이미 lazy cleanup으로 삭제됐어도 204 반환 (count 0).
- `delete`는 not-found 시 `PrismaClientKnownRequestError` 던짐 → 분기 처리 복잡해짐.
- WHERE에 `userId`도 포함 → user A가 user B의 token으로 DELETE 시도해도 자기 row만 영향 (보안).

**Auth:** `requireSession` 게이트. Session 없으면 401. Body shape 잘못되면 400 `invalid_body` (POST /devices와 동일 contract).

### LogContext 활용

`removedDeviceCount` (§2 참조)로 cleanup count를 typed하게 로깅. 기존 `removedDeviceId` (lazy DeviceNotRegistered 전용)와 의미 분리.

## 4. Mobile 변경

### Push helper

**File:** `apps/mobile/src/api/push.ts` (기존 파일에 함수 추가)

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
    // Best-effort — sign-out 계속 진행.
  }
}
```

`registerForPushNotifications` 함수와 동일한 패턴:
- 같은 projectId 추출 / placeholder guard / token 재취득
- 모든 실패 path silent
- `apiFetch("/devices", { method: "DELETE", body: ... })` — DELETE-with-body는 RN 0.71+의 `fetch`가 지원하고 `makeApiFetch` factory가 body 있을 때 `content-type` 자동 설정. **단 in-repo 기존 DELETE callsites는 모두 path param 사용 (no body)** — 본 plan이 첫 사례이니 implementer가 mobile에서 한 번 manual smoke 권장 (curl 또는 mobile 실기기).

### Sign-out callsites

**File:** `apps/mobile/app/(tabs)/more.tsx` — 두 callsite 모두 `signOut()` 직전에 `await unregisterForPushNotifications()` 추가 (코드 컨텍스트 anchor, 라인 번호는 본 plan의 import 추가로 drift 발생 가능):

1. **Regular sign-out button** (Alert dialog의 "Sign out" destructive option, `onPress: async () =>` 안):
```ts
onPress: async () => {
  await unregisterForPushNotifications();
  await signOut();
  router.replace("/" as never);
},
```

2. **Dev-only sign-out button** (`__DEV__` 분기, dev cleanup 직전):
```ts
onPress: async () => {
  await unregisterForPushNotifications();
  await signOut();
  // ... 기존 dev cleanup 코드
},
```

순서 중요: `signOut()` 이후엔 session cookie 만료 → DELETE /devices 호출 시 401. **반드시 signOut() 전에 호출.**

## 5. Edge cases

| Scenario | 동작 |
|---|---|
| User가 sign-out 시 network down | DELETE 실패 → catch → signOut() 계속 진행. Stale row는 다음 push DeviceNotRegistered로 lazy cleanup. |
| User A가 sign-out → 같은 device에서 user B sign-in | A의 row 삭제됨 → B가 POST /devices 호출 → B의 새 row 생성. 정상 분리. |
| User가 push 권한 거부 상태에서 sign-out | `getExpoPushTokenAsync` 실패 → catch → 진행. Stale row 없음 (애초에 register도 안 됐을 것). |
| User가 sign-out 후 즉시 sign-in 다시 (계정 변경) | A row 삭제 → 같은 토큰으로 B에 POST → B의 row 신규 생성. UNIQUE(userId, token)이라 conflict 없음. |
| Mobile이 sign-out 보내기 전에 API가 crash | 토큰 자체는 valid해서 DeviceNotRegistered도 안 옴 → lazy cleanup도 안 됨. **알려진 한계 — v1.5 cron janitor가 lastSeenAt > N일인 row 정리할 때까지 stale row 잔존.** UNIQUE(userId, token)이라 새 user는 자기 row만 가짐, 다른 user의 push 가지 않음 — 무해. |
| Token rotation (Expo가 OS reset / 재설치 후 새 토큰 발급) → DELETE가 OLD token이 아닌 NEW token으로 호출됨 | DELETE finds no row → 204. OLD token row는 stale 상태로 잔존. **알려진 한계.** 다음 push DeviceNotRegistered로 lazy cleanup. |

## 6. Testing

**`apps/api/tests/devices.routes.test.ts`** (기존 파일에 describe block 추가):

```ts
describe("DELETE /devices", () => {
  it("requires session (401 when no cookie)", async () => { ... });
  it("deletes the matching UserDevice row (204)", async () => { ... });
  it("idempotent — returns 204 even when row already absent", async () => { ... });
  it("rejects empty token (400 invalid_body)", async () => { ... });
  it("only deletes the caller's row, never another user's (same-token scope)", async () => {
    // User A and User B BOTH have token T (multi-account device, 2C T3 scenario).
    // User A DELETE /devices with token T → only A's row deleted, B's row intact.
    // This is the actual userId-scoping test.
  });
  it("delete with a token nobody else owns is a no-op for others", async () => {
    // User A has token T. User B has a different token T'.
    // User A DELETE /devices with token T → A's row gone, B's row intact (untouched
    // because the WHERE clause requires userId=A AND token=T).
  });
});
```

총 6개 새 테스트.

**Mobile**: unit test 없음 (Expo APIs는 mock하기 무거움 + helper는 best-effort wrapping). 단 type-level smoke 1개 — `unregisterForPushNotifications: () => Promise<void>` export가 살아있는지 mobile test 또는 typecheck로 확인 (accidental removal 방지).

Spec §5의 edge cases는 manual smoke로 검증 — main에 merge 후 실제 sign-out → DB 확인.

## 7. Risks

| Risk | Mitigation |
|---|---|
| `getExpoPushTokenAsync` cold call이 sign-out 누름 후 느리게 응답 → UX hiccup | timeout 안 걸어둠 (best-effort). 이미 register됐던 device라 Expo SDK가 cache hit → 즉시 반환 (보통 ms 단위). |
| Better-auth session 만료된 상태에서 DELETE 시도 → 401 | catch에서 swallow → signOut() 계속. 무해. |
| Stale row가 누적되는 케이스 (offline sign-out 등) | 다음 push 시 DeviceNotRegistered로 정리. 또는 future cron이 N일 이상 lastSeenAt 안 갱신된 row 일괄 정리 (v1.5+). |

## 8. Success criteria

- DELETE /devices route 통과 + 6개 신규 테스트 모두 green (devices.routes.test.ts 기존 6개 → 12개로 증가).
- Mobile sign-out → DB에서 해당 row 즉시 사라짐 (smoke 검증).
- POST /devices와 동일한 ApiError contract (`invalid_body`, 401).
- @fina/shared의 `UnregisterDeviceBody` schema가 mobile + api 양쪽에서 import됨 (single source).
- 전체 API suite 회귀 없음.

## 9. Follow-ups

- v1.5: 위 risk 표의 "stale row 일괄 정리" cron.
- 2E (push settings UI): user가 수동으로 "이 device에서 push 끄기" 가능. 본 route 재사용.
- Receipt polling (별도 plan): Expo Receipt API 폴링해서 ticket-level 결과 → 추가 cleanup signal.
