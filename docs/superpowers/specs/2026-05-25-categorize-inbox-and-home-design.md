# Categorize Inbox + Home Redesign Design

**Status:** Draft v2 (post-subagent review)
**Date:** 2026-05-25
**Owner:** Brian + Claude
**Related:** `docs/superpowers/specs/2026-05-25-categorization-overhaul-design.md` (categorize pipeline + needsConfirmation foundation)

## Goal

분류 확인이 필요한 transaction을 별도 screen으로 모아 한 번에 빠르게 처리할 수 있게 만든다. Home은 단순 onboarding checklist에서 "지금 사용자가 처리해야 하는 모든 작업"을 보여주는 hub로 진화시킨다 (categorize inbox + unread Fina messages + bank reconnect + trial expiring + invites + onboarding 잔존).

## Why now

- Categorization overhaul로 `needsConfirmation=true` allocation들이 생기는데, 현재는 Activity tab의 `Review` chip만 표시되고 사용자가 한 건씩 transaction detail로 진입해서 처리해야 함 — 비효율.
- Home은 onboarding checklist (Set budget / Connect bank / Try morning brief / Set goal)만 보여줘서 onboarding 끝난 사용자에게 hub로서 가치가 떨어짐.
- 사용자가 명시: "Home을 딱 열었을 때 필요한 작업들 목록이 나오는게 마음에 들어. 그래서 그런 요소들과 실제 main에 나오는 요소들이 잘 조합되어서 나와야해."

## Non-goals

- Full design-file Home의 모든 요소 (brief card, top categories, recent activity) v1에 구현 — v2 후보.
- Home의 spend hero 위에 hero 일러스트 / 큰 그래프 — v2.
- Action items 정렬을 사용자가 customize — fixed priority order로 시작.
- Cancel-action endpoint를 snooze와 통합 — 의미 분리가 명확하므로 endpoint 분리 유지.
- ChatThread.unreadCount denormalize column — v1은 단일 GROUP BY query로 계산.

## Shared library touchpoints (`@fina/shared`)

- `ChatThreadDTO`에 두 필드 추가:
  - `lastReadAt: string | null` (ISO 또는 null)
  - `unreadCount: number` — 서버가 단일 GROUP BY query로 계산. 정의: 같은 thread에서 `role='assistant' AND createdAt > thread.lastReadAt` 개수 (lastReadAt이 null이면 전체 assistant message 개수). `role='tool'/'user'`는 제외 — Fina가 사용자에게 보낸 응답만 카운트.
- transactions list query schema 확장: `needsReview?: boolean` (zod schema는 기존 `BoolFlag` enum 패턴 활용 — `apps/api/src/routes/transactions.ts:25-32` 주석 참조; `z.coerce.boolean()`은 query string에서 잘못 동작하는 알려진 문제라 사용 금지).
- 새 schema는 없음 — POST /chat/threads/:id/read와 POST .../dismiss-category는 둘 다 empty body.
- v1은 Mobile Home이 분산 query로 카운트 모음. `MeDTO.actionSummary`는 v2로 미룸.

## Architecture

### Categorize Inbox screen

**Route:** `/categorize/inbox` (mobile, `apps/mobile/app/categorize/inbox.tsx`). 새 경로, 충돌 없음.

**Entry points:**
- More 탭의 AI 그룹: 기존 "Categorization style" row 아래 새 row "Review queue" with detail = `{N}` (0이면 detail은 빈 문자열이지만 row 자체는 항상 보임 — 빠른 진입점).
- Home의 Action Items 카드 (categorize inbox 알림, N > 0일 때만).

**Data source:** `GET /workspaces/:id/transactions?needsReview=true` — workspace-scoped, query param 추가. 서버는 `allocations.some({ needsConfirmation: true, dismissedUntil: { is: null OR < now } })` 필터링. `categoryId IS NOT NULL` 도 필요 (uncategorized 제외 — categorize confirm은 카테고리가 있는 케이스만).

**UI:**
- Header: "Review queue" + 뒤로가기.
- 빈 상태: "All caught up — nothing to review." 짧은 메시지 + 큰 체크 아이콘 (Ionicons `checkmark-circle-outline`, mint 색).
- Row (카드형, 다른 group 카드와 동일 `surfaceSoft` 배경, marginHorizontal `space.base`, borderRadius 16):
  - Line 1: merchant (왼쪽) + amount (오른쪽)
  - Line 2: current category name + 작은 빨간 `Other` chip (해당 시)
  - Action row (가로 버튼 3개, 동일 flex):
    - **Confirm** (primary mint, 항상 같음) — `POST /workspaces/:id/transactions/:txId/confirm-category` (기존)
    - **Edit** (ghost, border + bg transparent) — `CategoryPickerSheet` 열림 → 선택 시 기존 `POST /categorize` flow (`applyManualCategorize`)
    - **Skip** / **Dismiss** (mode-dependent label, ghost muted text) — Strict/Flexible 시 라벨 "Skip", Auto 시 라벨 "Dismiss". 작은 helper text 한 줄 (라벨 아래):
      - Strict/Flexible: "Will show again next time"
      - Auto: "Won't show again"
    - 동작:
      - Strict/Flexible: 클라이언트 state에서만 제거 (DB 변경 없음). 다음 fetch에 다시 보임.
      - Auto: `POST /workspaces/:id/transactions/:txId/dismiss-category` (신규) → `needsConfirmation=false` set. 다음 fetch에 안 보임.

**Button width on small screens:** iPhone SE (~320pt) 폭에서 3 버튼이 텍스트로 채워지면 narrow함. v1 결정: 각 버튼은 텍스트만 (icon 없음), 폰트 12-13pt + minWidth 0 + ellipsis. Helper text는 두 번째 줄로 wrap. 부족하면 v2에서 swipe 모델 고려.

**Optimistic update:** Confirm/Edit/Skip/Dismiss 처리 직후 row를 list state에서 제거. 백엔드 호출 실패 시 row 복원 + Alert. List가 비면 즉시 empty state 표시.

**Concurrent rows:** 한 row 처리 중 다른 row 인터랙션 가능 — 각 row의 액션은 독립. saving state는 row-level (해당 row 버튼 disabled).

**Refresh:** `useFocusEffect`로 화면 진입 시 refetch.

### Home redesign

**Route:** `/(tabs)/index.tsx` (기존 위치).

**Top-down layout:**

1. **Greeting header** (기존) — "Hi, {name}" / "Welcome to Fina."
2. **Trial banner** (기존) — `trial.active`일 때만, "Pro trial · {N} days left". Trial expired (trial.active=false)면 banner 없음.
3. **Action Items section** — Fixed-priority order. Section label "Your queue" (locked). 모든 카드 트리거가 false면 section 자체 hide.

   카드 6종 (모두 동일 row 스타일: mint glyph + title + sub + chevron). Priority order (1번이 위, 6번이 아래):

   | # | Card | Trigger | Tap → | Ionicon |
   |---|---|---|---|---|
   | 1 | "Reconnect {bankName}" / "Reconnect {N} banks" | PlaidItem `status='error'` 또는 `errorCode IN ('ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION')` 1개 이상; 여러 개면 카운트 표시 | `/banks` | `alert-circle-outline` |
   | 2 | "Fina sent you {N} message{s}" | `sum(thread.unreadCount) > 0` | `/(tabs)/chat` | `chatbubble-outline` |
   | 3 | "Confirm {N} categorization{s}" | needsReview count > 0 | `/categorize/inbox` | `construct-outline` |
   | 4 | "Trial ends in {N} day{s}" | `trial.active && trialDaysLeft ≤ 5` (0 포함). Trial expired (`trial.active=false`)는 카드 없음 — billing 화면에서 별도 처리 | `/subscriptions` (`apps/mobile/app/subscriptions/index.tsx` 확인됨) | `sparkles-outline` |
   | 5 | "{N} workspace invite{s}" | `pendingInvites > 0` (from `GET /me/incoming-invites`) | 새 mobile screen `/workspace/incoming` (신규, 아래 §추가 deliverable 참조) | `mail-outline` |
   | 6 | Onboarding 미완 — flat list of K cards | set-budget / connect-bank / set-goal 각각 미완이면 별도 카드로. 완료된 항목 hide. 모두 완료면 0 카드 | 각 항목 href (`/budget`, `/banks`, `/(tabs)/goals`) | `checkmark-circle-outline` (or 각자 다른 아이콘) |

   **Bank priority 우선 이유:** Bank 연결 끊기면 새 transactions sync 안 됨 → categorize/budget/Fina의 데이터가 모두 stale. Block 해결이 먼저.

   **Grouping rules:**
   - 같은 type에 여러 건이면 한 카드로 묶고 "{N}" 표시 (예: bank 2개 → "Reconnect 2 banks").
   - Onboarding은 예외로 flat 유지 — 각 미완 step이 별도 카드. 완료된 항목은 안 보임.
   - 모든 카드가 0건이면 section title도 안 보임.

4. **This month spend card** — Action Items 아래. 항상 보임 (sparse 방지). 1 카드:
   - Large: "$X spent this month" (현재 캘린더 월 기준, 사용자 tz)
   - Budget이 있으면: progress bar + "of $Y" + "{Z}%". Over budget이면 amount + bar `colors.down` 처리.
   - Budget 없으면: 단순히 "$X spent this month" + small CTA "Set a budget →".
   - 탭 → `/budget`

5. (이후 main content 없음 — v2)

**Data fetching (Mobile):**
- 단일 useEffect + Promise.all로 다음 endpoint 병렬 호출:
  - `GET /me` — trial, name 등
  - `GET /workspaces/:id/plaid-items` — bank reconnect status
  - `GET /workspaces/:id/transactions?needsReview=true&limit=1` — count만 알면 됨 (response의 `total` 또는 길이)
  - `GET /me/incoming-invites` — pending invite count
  - `GET /chat/threads` — `unreadCount` 합산
  - `GET /workspaces/:id/budget-plans/current` — `totalSpent` (string) + `plan` (null이면 budget 없음)
  - 기존 onboarding 정보 (budget plan은 위에서 검사, banks도 위에서 검사, goal은 별도 endpoint)
- 각 endpoint 실패 시 해당 카드만 hide. `/me` 실패 시 빈 페이지 대신 spinner + retry 버튼 (전체 페이지 collapse 방지).
- `useFocusEffect`로 화면 진입 시 전체 refetch.

**Skeleton/loading:** /me + plaid-items 응답 도착 전까지는 spinner. 일부만 응답 와도 렌더하기 위해 응답 도착한 카드부터 채움 (incremental render).

### Mobile Action Item 카드 컴포넌트

`apps/mobile/src/home/ActionItemCard.tsx` (신규):

```tsx
type ActionItemCardProps = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onPress: () => void;
};
```

스타일: 다른 그룹 카드와 동일 (`canvas` bg + `hairline` border + borderRadius 16, mint glyph 36×36, title + sub + chevron). 색상 emphasis 안 함 — 우선순위 시각화는 정렬 순서로만.

### Additional deliverable: `/workspace/incoming` mobile screen

기존에 라우트 없음. Web에서는 Home banner에 invite 처리가 있지만 mobile은 없음. v1에서 단순 screen:
- Header "Invitations" + 뒤로가기
- `GET /me/incoming-invites`로 pending invite list 표시
- 각 row: workspace name + role + invited at + `[Accept] [Decline]` 버튼
- Accept → 기존 `POST /me/incoming-invites/:id/accept` 호출 → workspace 자동 switch + 뒤로
- Decline → 기존 decline endpoint (있다면) 호출

만약 decline endpoint가 없으면 v1에서는 Accept만 제공. Decline은 v2.

### Backend changes

**Migration (single file):**

```sql
ALTER TABLE "chat_threads" ADD COLUMN "lastReadAt" TIMESTAMP(3);
```

`lastReadAt` nullable. 기존 thread는 NULL로 시작 — 모든 assistant message가 unread로 계산됨.

**Endpoints:**

- **New:** `POST /chat/threads/:id/read` — body empty. 권한: thread.userId == session.userId. 동작: `UPDATE chat_threads SET lastReadAt = NOW() WHERE id = ? AND userId = ?`. 200 ok 또는 404.
- **New:** `POST /workspaces/:id/transactions/:txId/dismiss-category` — body empty. 권한: editor. 동작: `UPDATE transaction_allocations SET needsConfirmation = false WHERE transactionId = ?`. `dismissedUntil`은 건드리지 않음. (snooze와 명시적으로 다른 의미: snooze = "7일 후 다시", dismiss = "영구 dismiss".) 200 ok.
- **Modified:** `GET /workspaces/:id/transactions` query schema에 `needsReview?: BoolFlag` 추가. true면 `allocations: { some: { needsConfirmation: true, categoryId: { not: null }, OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }] } }` 추가. `BoolFlag` enum 정의는 기존 routes/transactions.ts 패턴 따름.
- **Modified:** `GET /chat/threads` 응답에 `unreadCount` 포함.

**unreadCount 계산 (단일 query, no N+1):**

```ts
const threads = await prisma.chatThread.findMany({
  where: { userId, archivedAt: null },
  orderBy: [{ archivedAt: "asc" }, { lastMessageAt: { sort: "desc", nulls: "last" } }],
});
const threadIds = threads.map(t => t.id);
// Single grouped count query.
const unreadRows = await prisma.$queryRaw<Array<{ threadId: string; cnt: bigint }>>`
  SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS cnt
  FROM "chat_messages" m
  JOIN "chat_threads" t ON t.id = m."threadId"
  WHERE m."threadId" = ANY(${threadIds}::text[])
    AND m.role = 'assistant'
    AND (t."lastReadAt" IS NULL OR m."createdAt" > t."lastReadAt")
  GROUP BY m."threadId"
`;
const unreadByThread = new Map(unreadRows.map(r => [r.threadId, Number(r.cnt)]));
// Map onto threads response.
```

Threads 목록 + 1 GROUP BY query = 2 round-trip 총. N+1 회피.

**DTO updates (shared lib):**
- `ChatThreadDTO.lastReadAt: string | null`
- `ChatThreadDTO.unreadCount: number`

### Read-mark UX policy

- 사용자가 chat thread를 **열어서 메시지를 보면** mobile 클라이언트가 `POST /chat/threads/:id/read` 호출. (thread detail screen mount 시 또는 첫 message view 시.) GET messages 시 자동 mark는 안 함 — race condition + 다중 device 동기화 단순화를 위해 explicit endpoint 유지.
- Thread list만 보는 건 read 처리 안 함 (Home에서 unread 카운트만 보고 안 열면 그대로).
- 새 assistant message가 thread에 도착하면 (예: morning brief cron) thread.lastMessageAt이 갱신되고 unread count는 자동으로 다시 계산됨.

## Testing

**Categorize Inbox:**
- 빈 inbox → empty state 렌더.
- 1개 row에 Confirm tap → POST 성공 → row optimistic 제거 + list refetch 시 0개.
- 1개 row에 Skip × Strict mode → list state에서만 제거, refetch 시 다시 보임 (DB 그대로 needsConfirmation=true).
- 1개 row에 Skip × Flexible mode → list state에서만 제거, refetch 시 다시 보임.
- 1개 row에 Dismiss × Auto mode → POST /dismiss-category 호출, refetch 시 안 보임 (`needsConfirmation=false` 확인).
- 1개 row에 Edit tap → CategoryPickerSheet 열림 → 카테고리 선택 시 POST /categorize → row 제거 + refetch.
- Concurrent: 2개 row를 빠르게 Confirm tap → 둘 다 백엔드 호출 + 둘 다 list에서 제거.
- Skip/Dismiss 버튼 라벨이 mode에 따라 정확히 바뀌는지 (3 모드 × 라벨 매핑).

**Home action items:**
- 모든 type 1개씩 trigger 상태 → 6 type 카드 모두 보임 (onboarding 3개 별도 카드면 총 8개) + spend card 보임.
- 모든 type 0개 → action items section 없음, spend card만 보임.
- 부분 trigger (예: bank reconnect만 1개) → 그 카드 1개 + spend card.
- Categorize inbox에서 1개 confirm 후 Home으로 돌아옴 → 카운트 1 줄어들거나 0이면 카드 hide.
- Trial 6일 남음 → 카드 안 보임. 5일 남음 → 카드 보임. 0일 남음 (trial.active true) → 카드 보임.
- Trial expired (trial.active=false) → 카드 없음.
- Priority order 시각 확인: Bank 1, Fina 2, Categorize 3, Trial 4, Invites 5, Onboarding 6.

**Spend card:**
- Budget 있음 + 50% spent → "$X of $Y", 50%, mint progress bar.
- Budget 있음 + 110% spent → "$X of $Y", 110%, red progress bar.
- Budget 없음 → "$X spent this month" + "Set a budget →" CTA.
- totalSpent=0 + Budget 없음 → "$0.00 spent this month" + CTA.

**Unread Fina messages:**
- 새 morning brief 들어옴, 사용자가 /chat 안 열음 → Home에 카드 보임, unreadCount > 0.
- 사용자가 /chat 열고 thread 진입 → POST /read 호출 → 다음 Home refetch에 카드 hide.
- assistant role만 카운트 — user/tool role은 unread에 안 잡힘 (테스트로 검증).

**Backend:**
- `GET /chat/threads?` → 응답에 `unreadCount` 포함, lastReadAt=null인 thread는 모든 assistant message가 unread.
- 단일 GROUP BY query → instrumentation으로 query count = 2 (findMany threads + raw GROUP BY)임을 확인.
- `POST /chat/threads/:id/read` → 404 권한 없는 사용자, 200 본인 thread, idempotent.
- `GET /workspaces/:id/transactions?needsReview=true` → needsConfirmation + dismissedUntil + categoryId 필터.
- `POST /dismiss-category` → 권한 editor 필요, needsConfirmation=false set, dismissedUntil 그대로 (snooze 안 건드림).

## Telemetry

- `categorize.confirmed{action='skip-client'|'dismiss-auto'}` 신규 액션 추가 (skip-client = Strict + Flexible 둘 다 포함, dismiss-auto = Auto mode).
- Home action items render count는 logging 안 함 (PII 부담).

## Risks / open questions

- **3 button + helper text 폭:** iPhone SE 320pt에서 buttons 텍스트 + helper line이 잘릴 가능성. v1에서는 minWidth 0 + ellipsis로 처리, 잘림이 심하면 v2에 swipe gesture 또는 secondary action menu로 변경.
- **lastReadAt 정확성:** Mobile이 thread를 열었지만 사용자가 새 message가 도착하기 전에 닫고 나간 경우, 그 직후 도착한 message는 unread로 카운트. 의도된 동작 (사용자가 chat 화면 다시 열 때까지 unread).
- **N+1 mitigations 충분성:** Threads 1000+개 가진 사용자에서 raw GROUP BY query 측정 필요. v1 단순 패턴으로 시작, hot path에서 문제 생기면 v2에 denormalize.
- **Cancel × Strict mode UX 혼란 잔존:** 라벨을 "Skip" + helper "Will show again next time"으로 명시했지만 사용자가 helper text 안 읽고 surprise할 가능성. v2에서 Skip 후 toast "Skipped — will reappear" 추가 고려.
- **`/workspace/incoming` decline endpoint:** Backend에 decline endpoint 있는지 확인 필요. 없으면 v1은 Accept만 + Decline은 placeholder ("Coming soon" alert) 또는 v2.
- **Onboarding flat list:** 3개 미완이면 카드 3개 차지 — Action Items가 너무 길어 보일 가능성. Reviewer는 flat 유지 권장 (grouping의 affordance 손실 회피). v2에서 user feedback 보고 grouping 도입 검토.
- **Home main content 부족:** v1은 action items + spend card 둘만 — 사용자가 onboarding 다 끝나고 inbox/banks/trial/invite도 다 처리한 상태면 Home이 거의 빈 상태처럼 보임. spend card 1개와 함께. v2에서 hero / top categories / recent activity 추가 검토.
