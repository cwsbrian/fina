# Plan 2C-push-receipts Design

**Status:** Draft → User review pending
**Predecessor:** Plan 2C-push (shipped `5c2da1b`) + Plan 2C-push-cleanup (shipped `8bb189d`)

## 1. Goal & scope

`sendBriefPush`가 발급받은 Expo push ticket id를 DB에 보관 → 1시간 후 cron이 `getPushNotificationReceiptsAsync`로 polling → 비동기 실패 케이스 정리:

- `DeviceNotRegistered` → UserDevice row 삭제 (lazy ticket-time cleanup의 server-side complement; 사용자가 push 받은 후 즉시 앱 삭제하면 ticket=ok지만 receipt=DNR로 도착).
- `InvalidCredentials` → critical structured log + LogContext `receiptInvalidCreds: true` (APNs/FCM cert 만료 등 systemic 시그널, 운영자가 stdout에서 즉시 인지).
- 기타 error codes → log + errorCode 보존.
- `ok` → polledAt 마킹.

`polledAt > 7d` row는 `cleanup-events` cron이 정리.

**Out of scope:**
- Slack/email alert 채널 (structured logError로 충분).
- Retry pending — receipt polling은 후처리 cleanup, retry logic 아님.
- Admin UI / observability dashboard.
- Mobile 변경 0건.
- Push tap deep-link routing (Plan 2D 영역).

## 2. Shared library touchpoints

`libs/shared/src/logging.ts`에 5개 필드 추가 (push 클러스터에 그룹):

```ts
  /** Receipt polling cron (Plan 2C-push-receipts). */
  receiptsPolled?: number;       // Expo가 receipt 반환한 ticket 수 (해당 tick에서)
  receiptsFailed?: number;       // status === "error" 받은 수
  receiptInvalidCreds?: boolean; // APNs/FCM cert 만료 시그널 (critical)
  receiptErrorCode?: string;     // "DeviceNotRegistered" | "MessageTooBig" | etc.
  deletedPushTickets?: number;   // cleanup-events에서 정리한 row 수
```

`libs/shared/src/index.ts` 변경 없음 (logging은 이미 re-export).

**CLAUDE.md 규칙대로 T1에서 shared first commit.**

## 3. Prisma 변경

새 모델 `PushTicket`:

```prisma
model PushTicket {
  id              String       @id @default(cuid())
  /// Expo가 반환하는 ticket id (e.g., "019e5181-c4e6-7488..."). UNIQUE
  /// — 같은 ticket을 2번 저장 시도하면 conflict (방어용).
  expoTicketId    String       @unique
  userDeviceId    String
  sentAt          DateTime     @default(now())
  /// null = 아직 poll 안 함. Polling 성공 시 now(). 7일 후 cleanup-events 정리.
  polledAt        DateTime?
  /// null | "ok" | "error". status="error"일 때 errorCode 동반.
  status          String?
  /// "DeviceNotRegistered" | "InvalidCredentials" | "MessageTooBig" 등.
  errorCode       String?

  userDevice      UserDevice   @relation(fields: [userDeviceId], references: [id], onDelete: Cascade)

  @@index([polledAt, sentAt])  // cron 쿼리 최적화
  @@map("push_tickets")
}
```

`UserDevice`에 back-reference 추가:

```prisma
model UserDevice {
  // ... 기존 필드들
  tickets         PushTicket[]
}
```

**Migration timing**: T2가 한 마이그레이션 commit으로 양쪽 (User 모델 + 새 PushTicket) 함께 적용.

## 4. `sendBriefPush` 변경

`apps/api/src/push/send.ts`에서 ticket 처리 loop:

기존:
```ts
if (t.status === "ok") {
  sent++;
  continue;
}
```

변경: 기존 `send.ts:74-94` ticket loop에서 `deviceId`는 error 분기 안에서만 추출. ok 분기에서도 필요해지므로 loop 시작에 hoist:

```ts
for (let i = 0; i < tickets.length; i++) {
  const t = tickets[i]!;
  const deviceId = (chunk[i] as CarrierMessage).__deviceId;  // hoisted to top of loop

  if (t.status === "ok") {
    // Save ticket for receipt polling (Plan 2C-push-receipts).
    // Best-effort: persist failure shouldn't fail the whole send pipeline.
    try {
      await prisma.pushTicket.create({
        data: { expoTicketId: t.id, userDeviceId: deviceId },
      });
    } catch (err) {
      logWarn({ userId, removedDeviceId: deviceId, err }, "ticket persist failed");
    }
    sent++;
    continue;
  }

  // error 분기는 그대로 — deviceId는 위에서 hoisted, error 분기 안의 기존
  // `const deviceId = ...` 라인은 제거.
  failed++;
  const errorCode = t.details?.error;
  if (errorCode === "DeviceNotRegistered") {
    await prisma.userDevice.delete({ where: { id: deviceId } });
    // ... 기존 로깅 그대로
  } else {
    // ... 기존 그대로
  }
}
```

**구현 메모**: T-implementer는 기존 error 분기 내부의 `const deviceId = ...` 라인을 삭제하고 loop 시작에 hoisted 버전으로 통합해야 함. Spec §4의 변경은 단순 추가가 아니라 small refactor.

Error path들은 그대로 (DeviceNotRegistered → row 삭제, others → log warn). Ticket row 없어도 무해 (cleanup은 polling 의존이 아닌 lazy ticket-time 이미 처리).

## 5. 새 cron `push-receipts`

**File:** `apps/api/src/cron/jobs/push-receipts.ts` 신규.

**Pattern:** `0 * * * *` (매시 정각, 하루 24회).

**Logic:**

```ts
export async function runPushReceipts(env: Env): Promise<void> {
  // 1. Query pollable tickets.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const pending = await prisma.pushTicket.findMany({
    where: { polledAt: null, sentAt: { lt: oneHourAgo } },
    orderBy: { sentAt: "asc" },  // FIFO — oldest first; prevents starvation under flood.
    take: 200,  // batch limit; next tick picks up rest.
    select: { id: true, expoTicketId: true, userDeviceId: true },
  });
  if (pending.length === 0) return;

  // 2. Fetch receipts from Expo. expo-server-sdk does NOT auto-chunk
  // getPushNotificationReceiptsAsync — limit is 300 ids per call. Our
  // `take: 200` keeps us under the limit. If the batch ever grows above
  // 300, call `expo.chunkPushNotificationReceiptIds(ids)` first.
  const expo = new Expo(
    env.EXPO_ACCESS_TOKEN === undefined
      ? {}
      : { accessToken: env.EXPO_ACCESS_TOKEN },
  );
  const expoTicketIds = pending.map((t) => t.expoTicketId);
  let receipts: Record<string, ExpoPushReceipt>;
  try {
    receipts = await expo.getPushNotificationReceiptsAsync(expoTicketIds);
  } catch (err) {
    logError({ cron: CRON_NAME, err }, "expo getReceipts threw");
    return;  // next tick retries.
  }

  // 3. Process each receipt.
  let polled = 0;
  let failed = 0;
  let invalidCreds = false;
  // Same-batch cascade guard: if ticket A's DNR receipt deletes UserDevice X,
  // any later ticket in this batch with userDeviceId === X has ALREADY been
  // cascade-deleted from push_tickets — touching it would throw P2025.
  // Track deletions in-memory and skip subsequent tickets pointing to them.
  const deletedDeviceIds = new Set<string>();

  for (const ticket of pending) {
    if (deletedDeviceIds.has(ticket.userDeviceId)) continue;  // cascade already removed this ticket row

    const r = receipts[ticket.expoTicketId];
    if (!r) {
      // Expo doesn't have the receipt yet — leave polledAt null, next tick retries.
      continue;
    }

    polled++;  // counts tickets with a receipt this tick (Expo returned data)
    if (r.status === "ok") {
      await prisma.pushTicket.update({
        where: { id: ticket.id },
        data: { polledAt: new Date(), status: "ok" },
      });
      continue;
    }

    failed++;
    const errorCode = r.details?.error ?? "Unknown";

    if (errorCode === "DeviceNotRegistered") {
      // Server-side complement to ticket-time DNR cleanup.
      await prisma.userDevice.delete({ where: { id: ticket.userDeviceId } });
      deletedDeviceIds.add(ticket.userDeviceId);
      // PushTicket row cascades automatically via FK; no explicit ticket update.
      logInfo(
        { cron: CRON_NAME, removedDeviceId: ticket.userDeviceId, receiptErrorCode: errorCode },
        "device removed via receipt",
      );
      continue;
    }

    await prisma.pushTicket.update({
      where: { id: ticket.id },
      data: { polledAt: new Date(), status: "error", errorCode },
    });

    if (errorCode === "InvalidCredentials") {
      invalidCreds = true;
      logError(
        { cron: CRON_NAME, receiptInvalidCreds: true, receiptErrorCode: errorCode, err: r.message },
        "APNs/FCM credentials invalid — operator action required",
      );
    } else {
      logWarn(
        { cron: CRON_NAME, receiptErrorCode: errorCode, err: r.message },
        "receipt error",
      );
    }
  }

  logInfo(
    { cron: CRON_NAME, receiptsPolled: polled, receiptsFailed: failed, ...(invalidCreds ? { receiptInvalidCreds: true } : {}) },
    "receipts cron done",
  );
}
```

**Scheduler 등록:** `apps/api/src/cron/scheduler.ts`에 한 줄 추가:

```ts
makeCron("0 * * * *", "push-receipts", () => runPushReceipts(env)),
```

## 6. `cleanup-events` cron 확장

`apps/api/src/cron/jobs/cleanup-events.ts`에 PushTicket 정리 step 추가:

`apps/api`에는 `date-fns` 없음 — 기존 `cleanup-events.ts:14`의 inline Date 패턴을 그대로 따름:

```ts
// 기존 cleanup events 끝에 추가
const cutoff = new Date(Date.now() - 7 * 86_400_000);
const pushTicketResult = await prisma.pushTicket.deleteMany({
  where: { polledAt: { lt: cutoff } },
});
logInfo(
  { cron: CRON_NAME, deletedPushTickets: pushTicketResult.count },
  "push_tickets cleanup",
);
```

## 7. Testing

### 새 test file: `apps/api/tests/push.receipts.test.ts` (~6 tests)

```
- 1h 안 지난 ticket → polledAt 그대로
- 1h 지난 ok ticket → polledAt 마킹 + status="ok"
- DeviceNotRegistered receipt → UserDevice 삭제 + PushTicket cascade 삭제
- InvalidCredentials receipt → logError 호출 + receiptInvalidCreds + ticket 마킹
- 기타 error → logWarn + errorCode 저장 + ticket 마킹
- Receipt 아직 없음 (Expo가 아직 처리 못 함) → polledAt 그대로 (다음 tick 재시도)
```

Mock pattern: 기존 `vi.mock("expo-server-sdk", ...)` 확장 — `getPushNotificationReceiptsAsync`를 프로토타입 메서드로 추가 (`vi.spyOn`으로 테스트별 stub).

`logError` / `logWarn` assertions은 기존 codebase 패턴 따름: `vi.spyOn(loggerMod, "logError").mockImplementation(() => {})` (예시: `cron.scheduler.test.ts`, `plaid.webhook.routes.test.ts`). `vi.mock("../src/logger.js", ...)` 모듈 단위 mock 대신 spy + restoreAllMocks로 격리.

### `push.send.test.ts` 추가 테스트 1개

- "ok ticket → PushTicket row created with matching expoTicketId" — 기존 send 테스트의 ok case 검증을 extend.

### `cron.cleanup-events.test.ts` 확장

- "polledAt > 7d push_tickets are deleted; recent polledAt preserved" 1개 추가.

### Mock 패턴 주의사항

- `vi.spyOn(prisma, ...)` 및 Prisma delegate properties FORBIDDEN (commit `3ecc538`). Manual save/restore 또는 real DB + truncate 사용.
- Gemini mock은 plain class (2B/2C pattern) — 본 plan은 Gemini 안 건드림.
- Expo SDK mock은 prototype method 패턴.

## 8. Edge cases

| Case | 동작 |
|---|---|
| Expo가 receipt 아직 안 만듦 (send 직후 cron 돌면) | sentAt < 1h 조건으로 cron이 skip. 다음 tick에서 처리. |
| Expo receipt가 24h 후 expire | sentAt > 24h이고 polledAt null인 ticket은 절대 polling 안 됨. cleanup-events에서 cutoff > 7d로 정리하지만 그 사이엔 잔존. Acceptable — 통계에 약간의 unpolled 잡음. v2에서 `polledAt IS NULL AND sentAt < now() - 24h` 같은 stale ticket sweeper 고려 가능. |
| DeviceNotRegistered receipt → UserDevice 삭제 시 cascade로 다른 PushTicket row도 삭제 | OK. UserDevice.tickets CASCADE FK가 처리. |
| 같은 cert 만료로 receipt 100건 모두 InvalidCredentials | logError 100번 호출. Stdout이 시끄러워지지만 critical signal 명확. 이후 사람이 cert 갱신하면 자동 회복. |
| Expo `getReceipts` API down (HTTP 5xx, timeout) | try/catch에서 logError + return. polledAt 그대로 (재시도). |
| 1 cron batch에 too many tickets (limit 200) | next tick에서 나머지 처리. 하루 24회 × 200 = 4800/일 capacity. dogfood 충분. |
| `sendBriefPush`의 ticket persist 실패 (e.g., FK 위반: device가 같은 트랜잭션 중 삭제) | logWarn + send sequence 계속. ticket row 없어도 sent counter는 정상 증가. polling 못 함은 known minor loss. |

## 9. Risks

| Risk | Mitigation |
|---|---|
| `expo.getPushNotificationReceiptsAsync` API change in v6.x | expo-server-sdk pinned at `^6.1.0`; major bump 시 receipt API 시그너처 재확인. |
| Cron이 `0 * * * *`이라 모든 deploy 시점 1시간 끊김 | Cron `protect` callback이 skipped run 로그 출력. Operations 모니터링 가능. |
| `cleanup-events`에 한 정리 step 추가하면 의존성 ↑ | cleanup-events는 이미 N step iterator 패턴 — 1 step 추가는 well-bounded. |
| Cron 충돌: `push-receipts`(`0 * * * *`)는 `cleanup-events`(`0 3 * * *`)와 03:00, `daily-refresh`(`0 9 * * *`)와 09:00에 동시 시작 | 각 Cron 인스턴스는 독립적이고 `protect`는 self-overlap만 막음. Prisma는 statement 단위로 atomic이고 in-memory shared state 없음 → 동시 실행 safe. 명시적 lock 불요. |
| Unauthed Expo getReceipts API rate limit (free tier) | 본 plan은 `EXPO_ACCESS_TOKEN` optional 유지. dogfood 트래픽 OK. Production scale 진입 시 token 세팅 권장 (rate limit 완화 + 본 cron이 안정적). |
| Expo `getPushNotificationReceiptsAsync` network 무한 hang | `expo-server-sdk`는 default `fetch` 사용 (timeout 없음). 외부 네트워크 hang 시 본 tick의 Promise가 무기한 대기. croner `protect` callback이 다음 tick overlap 방지 → 운영자 stdout에 `protected_skip` 경고 보임. 본 plan v1은 timeout wrapper 없이 OK (dogfood); production scale에서 `Promise.race(getReceipts, timeoutAfter(30s))` 패턴 적용 고려. |

## 10. Success criteria

- 새 PushTicket migration 적용 + 회귀 없음 (전체 API suite 통과 ± 알려진 baseline flake).
- `push.send.test.ts` 6개 + `push.receipts.test.ts` 6개 + `cron.cleanup-events.test.ts` 1개 추가 = 13개 신규 테스트 green.
- Dogfood smoke (선택): 1시간 후 `psql ... "SELECT * FROM push_tickets WHERE polled_at IS NOT NULL"` row 보이면 polling 동작.
- `EXPO_ACCESS_TOKEN`은 optional 그대로 유지 (free tier에서도 receipt API 호출 가능).
- typecheck clean (api / shared / mobile 모두).

## 11. Follow-ups

- v2 stale ticket sweeper: polledAt IS NULL AND sentAt > 24h row 정리 (Expo receipt expired).
- v2 alerting channel (Slack/email): InvalidCredentials를 logError 외에 채널로도 보내기.
- v2 receipt 통계 dashboard: 평균 delivery success rate, 일별 error breakdown.
- Plan 2D (push tap deep-link routing) 별도 영역 — receipt polling과 무관.
