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
  receiptsPolled?: number;       // polling 시도한 ticket 수
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

변경:
```ts
if (t.status === "ok") {
  // Save ticket for v1.5 receipt polling. Best-effort: persist failure
  // shouldn't fail the whole send pipeline.
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
```

`deviceId`는 이미 같은 loop에서 `__deviceId` carrier에서 추출되므로 별도 작업 불요.

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
    take: 200,  // batch limit; next tick picks up rest.
    select: { id: true, expoTicketId: true, userDeviceId: true },
  });
  if (pending.length === 0) return;

  // 2. Fetch receipts from Expo (SDK handles chunking).
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

  for (const ticket of pending) {
    const r = receipts[ticket.expoTicketId];
    if (!r) {
      // Expo doesn't have the receipt yet — leave polledAt null, next tick retries.
      continue;
    }

    polled++;
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

```ts
// 기존 cleanup events 끝에 추가
const cutoff = subDays(new Date(), 7);
const pushTicketResult = await prisma.pushTicket.deleteMany({
  where: { polledAt: { lt: cutoff } },
});
logInfo(
  { cron: CRON_NAME, deletedPushTickets: pushTicketResult.count },
  "push_tickets cleanup",
);
```

`subDays`는 `date-fns` (이미 의존성). 또는 inline `new Date(now - 7 * 86400 * 1000)`.

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
