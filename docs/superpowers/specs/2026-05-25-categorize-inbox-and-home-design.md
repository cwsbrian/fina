# Categorize Inbox + Home Redesign Design

**Status:** Draft (brainstorm)
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
- Cancel 액션이 항상 DB 변경 — Strict/Flexible에서는 client-side dismiss only.

## Shared library touchpoints (`@fina/shared`)

- `ChatThreadDTO`에 두 필드 추가:
  - `lastReadAt: string | null` (ISO 또는 null)
  - `unreadCount: number` (서버 계산: assistant role의 메시지 중 `createdAt > (lastReadAt ?? createdAt-of-thread)` 개수)
- transactions list query schema 확장: `needsReview?: boolean` (zod `z.coerce.boolean().optional()`)
- 새 schema는 없음 — POST /chat/threads/:id/read와 POST .../dismiss-category는 둘 다 empty body.
- v1은 Mobile Home이 분산 query로 카운트 모음. `MeDTO.actionSummary`는 v2로 미룸.

## Architecture

### Categorize Inbox screen

**Route:** `/categorize/inbox` (mobile, `apps/mobile/app/categorize/inbox.tsx`).

**Entry points:**
- More 탭의 AI 그룹: 기존 "Categorization style" row 아래 새 row "Review queue" with detail = `{N}` (또는 "0" → row hide).
- Home의 Action Items 카드 (categorize inbox 알림).

**Data source:** `GET /workspaces/:id/transactions?needsReview=true` — workspace-scoped, query param 추가. 서버는 `allocations.some({ needsConfirmation: true, dismissedUntil: { is: null OR < now } })` 필터링.

**UI:**
- Header: "Review queue" + 뒤로가기.
- 빈 상태: "All caught up — no transactions to review." 메시지 + 체크 일러스트.
- Row (카드형, 다른 group 카드와 동일 `surfaceSoft` 배경):
  - Line 1: merchant (왼쪽) + amount (오른쪽)
  - Line 2: current category name + 작은 `Other` chip (해당 시 빨간 tint)
  - Action row (가로 버튼 3개, flex 균등):
    - **Confirm** (primary mint) — `POST /workspaces/:id/transactions/:txId/confirm-category` (기존)
    - **Edit** (ghost) — `CategoryPickerSheet` 열림 → 선택 시 기존 `POST /categorize` flow (`applyManualCategorize`)
    - **Cancel** (ghost, muted text) — mode 분기:
      - Strict / Flexible: 클라이언트 state에서만 제거 (DB 변경 없음). 다음 fetch에 다시 보임.
      - Auto: `POST /workspaces/:id/transactions/:txId/dismiss-category` (신규) → `needsConfirmation=false` set, `dismissedUntil` 그대로. 다음 fetch에 안 보임.

**Optimistic update:** Confirm/Edit/Cancel 처리 직후 row를 list state에서 제거. 백엔드 호출 실패 시 row 복원 + Alert. List가 비면 즉시 empty state 표시.

**Concurrent rows:** 한 row 처리 중 다른 row 인터랙션 가능 — 각 row의 액션은 독립. saving state는 row-level (해당 row 버튼 disabled).

**Refresh:** `useFocusEffect`로 화면 진입 시 refetch. Home에서 진입했다가 돌아오면 Home도 refresh (별도 useFocusEffect).

### Home redesign

**Route:** `/(tabs)/index.tsx` (기존 위치).

**Top-down layout:**

1. **Greeting header** (기존) — "Hi, {name}" / "Welcome to Fina."
2. **Trial banner** (기존) — `trial.active`일 때만, "Pro trial · {N} days left"
3. **Action Items section** — Fixed-priority order. Section title "What needs you" (or similar). 모두 0이면 section 자체 hide.

   카드 6종 (모두 동일 row 스타일: mint glyph + title + sub + chevron):

   | # | Card | Trigger | Tap → |
   |---|---|---|---|
   | 1 | "Fina sent you {N} message{s}" | `ChatThread.unreadCount > 0` (집계: 사용자의 모든 thread의 unreadCount 합산) | `/(tabs)/chat` |
   | 2 | "Confirm {N} categorization{s}" | needsReview count > 0 | `/categorize/inbox` |
   | 3 | "Reconnect {bankName}" | PlaidItem 중 ITEM_LOGIN_REQUIRED 또는 PENDING_EXPIRATION 1개 이상; 여러 개면 "Reconnect {N} banks" | `/banks` |
   | 4 | "Trial ends in {N} day{s}" | `trial.active && trialDaysLeft ≤ 5` | `/subscriptions` (기존 mobile route) |
   | 5 | "{N} workspace invite{s}" | `pendingInvites > 0` | `/workspace/incoming` (기존) |
   | 6 | "Finish setup ({K} left)" | onboarding 미완 항목 (set-budget / connect-bank / set-goal) 카운트 > 0; 카드 1개로 묶고 expand 시 미완 항목 list 보임. v1: 별도 화면 없이 카드만, tap → 가장 첫 미완 step의 href로 deep-link | 첫 미완 step |

   **Type grouping rules:**
   - 같은 type에 여러 건이면 한 카드로 묶고 "{N}" 표시 (예: bank 2개 → "Reconnect 2 banks").
   - 모두 0건이면 카드 자체 안 그려짐.
   - Section title도 모든 카드가 0이면 안 보임.

4. **This month spend card** — Action Items 아래. 1 카드:
   - Large: "$X spent this month" (현재 캘린더 월 기준, 사용자 tz)
   - Budget이 있으면: progress bar + "of $Y" + "{Z}%"
   - Over budget이면 amount + bar red 처리
   - 탭 → `/budget`
   - Budget 없으면 단순히 "$X spent this month" + small "Set a budget →" CTA

5. (이후 main content 없음 — v2)

**Data fetching (Mobile):**
- `Promise.all([GET /me, GET /workspaces/:id/plaid-items, GET /workspaces/:id/transactions?needsReview=true&limit=1, GET /me/incoming-invites, GET /chat/threads, GET /workspaces/:id/budget-plans/default, GET /workspaces/:id/spend-this-month (...신규? 또는 기존 활용)])` 병렬.
- 각 endpoint 실패는 해당 카드만 hide (전체 페이지는 살아남음).
- `useFocusEffect`로 화면 진입 시 refetch.

**Spend this month 데이터:** 기존 `GET /workspaces/:id/budget-plans/default` 응답에 `spent`/`cap`/`spentPct` 등 합산이 이미 포함됨 (`apps/api/src/budgets/service.ts:114+`). v1은 이 endpoint 활용 — budget이 없는 사용자는 spent 합산만 별도 fetch 필요할 수 있으므로 server-side 응답 구조 확인 후 대응. 새 endpoint는 추가하지 않는다 (YAGNI).

### Mobile Action Item 카드 컴포넌트

`apps/mobile/src/home/ActionItemCard.tsx` (신규):

```tsx
type ActionItemCardProps = {
  icon: IoniconName;
  title: string;
  subtitle?: string;
  onPress: () => void;
};
```

스타일: 다른 그룹 카드와 동일 (mint glyph + title + sub + chevron). 별도 색상 emphasis 안 함 (모든 카드 동일 톤). 우선순위 시각화는 정렬 순서로만.

### Backend changes

**Migration (single file):**

```sql
ALTER TABLE "chat_threads" ADD COLUMN "lastReadAt" TIMESTAMP(3);
```

`lastReadAt` nullable. 기존 thread는 NULL로 시작 — 첫 GET /chat/threads에서 모든 assistant message가 unread로 계산됨.

**Endpoints:**
- **New:** `POST /chat/threads/:id/read` — body empty. 권한: thread.userId == session.userId. 동작: `UPDATE chat_threads SET lastReadAt = NOW() WHERE id = ? AND userId = ?`. 200 ok 또는 404.
- **New:** `POST /workspaces/:id/transactions/:txId/dismiss-category` — body empty. 권한: editor. 동작: `UPDATE transaction_allocations SET needsConfirmation = false WHERE transactionId = ?`. (Note: snooze와 다름. snooze는 dismissedUntil 7d set, dismiss-category는 needsConfirmation=false 자체.) 200 ok.
- **Modified:** `GET /workspaces/:id/transactions` query schema에 `needsReview?: boolean` 추가. true면 `allocations: { some: { needsConfirmation: true, OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }] } }` 추가.
- **Modified:** `GET /chat/threads` 응답에 `unreadCount` 포함. 계산: 같은 thread에서 `role='assistant' AND createdAt > thread.lastReadAt (또는 lastReadAt이 null이면 모든 assistant 메시지)` count.

**DTO updates (shared lib):**
- `ChatThreadDTO.lastReadAt: string | null`
- `ChatThreadDTO.unreadCount: number`

### Read-mark UX policy

- 사용자가 chat thread를 **열어서 메시지를 보면** mobile 클라이언트가 `POST /chat/threads/:id/read` 호출. (thread detail screen mount 시 또는 첫 message view 시.)
- Thread list만 보는 건 read 처리 안 함 (Home에서 unread 카운트만 보고 안 열면 그대로).
- 새 assistant message가 thread에 도착하면 (예: morning brief cron) thread.lastMessageAt이 갱신되고 unread count는 자동으로 다시 계산됨.

## Testing

**Categorize Inbox:**
- 빈 inbox → empty state 렌더.
- 1개 row에 Confirm tap → POST 성공 → row optimistic 제거 + list refetch 시 0개.
- 1개 row에 Cancel × Strict mode → list state에서만 제거, refetch 시 다시 보임 (DB 그대로).
- 1개 row에 Cancel × Auto mode → POST /dismiss-category 호출, refetch 시 안 보임 (`needsConfirmation=false` 확인).
- 1개 row에 Edit tap → CategoryPickerSheet 열림 → 카테고리 선택 시 POST /categorize → row 제거 + refetch.
- Concurrent: 2개 row를 빠르게 Confirm tap → 둘 다 백엔드 호출 + 둘 다 list에서 제거.

**Home action items:**
- 모든 type 1개씩 trigger 상태 → 6개 카드 모두 보임 + spend card 보임.
- 모든 type 0개 → action items section 없음, spend card만 보임 + onboarding checklist도 모두 done이면 정말 spend card 하나만.
- 부분 trigger (예: bank reconnect만 1개) → 그 카드 1개 + spend card.
- Categorize inbox에서 1개 confirm 후 Home으로 돌아옴 → 카운트 1 줄어들거나 0이면 카드 hide.
- Trial 6일 남음 → 카드 안 보임. 5일 남음 → 카드 보임.

**Unread Fina messages:**
- 새 morning brief 들어옴, 사용자가 /chat 안 열음 → Home에 카드 보임, unreadCount > 0.
- 사용자가 /chat 열고 thread 진입 → POST /read 호출 → 다음 Home refetch에 카드 hide.

**Backend:**
- `GET /chat/threads?` → 응답에 `unreadCount` 포함, lastReadAt=null인 thread는 모든 assistant message가 unread.
- `POST /chat/threads/:id/read` → 404 권한 없는 사용자, 200 본인 thread, idempotent.
- `GET /workspaces/:id/transactions?needsReview=true` → needsConfirmation 필터 + dismissedUntil 필터.
- `POST /dismiss-category` → 권한 editor 필요, needsConfirmation=false set, dismissedUntil 그대로 (snooze 안 건드림).

## Telemetry

- `categorize.confirmed{action='cancel-strict'|'cancel-auto'}` 신규 액션 추가.
- Home action items render count는 logging 안 함 (PII 부담).

## Risks / open questions

- **Spend this month 계산 endpoint:** 기존 endpoint가 spent 합산을 제공하지 않으면 새 endpoint 추가 비용 있음. v1에서 budget-plan endpoint의 spent 필드 확인 후, 없으면 별도 endpoint.
- **lastReadAt 정확성:** Mobile이 thread를 열었지만 사용자가 새 message가 도착하기 전에 닫고 나간 경우, 그 직후 도착한 message는 unread로 카운트. 의도된 동작 (사용자가 chat 화면 다시 열 때까지 unread).
- **N+1 위험:** GET /chat/threads의 unreadCount 계산은 N개 thread × COUNT 쿼리. v1은 단순 join + GROUP BY로 single query. 성능 모니터링 필요.
- **Cancel × Strict mode UX 혼란:** 사용자가 Strict mode에서 Cancel을 누르면 list에서 빠지지만 다음 refresh에 다시 보임 — 혼란 가능. v2에서 mode 별 Cancel 버튼 label을 다르게 (e.g. Strict에서 "Skip", Auto에서 "Dismiss") 고려.
- **Onboarding 카드 grouping:** 미완 항목 K개를 "Finish setup (K left)" 한 카드로 묶고 tap 시 첫 미완 step로 deep-link하는 단순화. K개를 펼쳐서 list로 보여주는 패턴은 v2.
- **Home main content 부족:** v1은 action items + spend card 둘만 — 사용자가 onboarding 다 끝나고 inbox/banks/trial/invite도 다 처리한 상태면 Home이 거의 빈 상태처럼 보임. spend card 1개와 함께. v2에서 hero / top categories / recent activity 추가 검토.
