# Categorization Overhaul Design

**Status:** Draft (brainstorm → spec, post subagent review pass 2)
**Date:** 2026-05-25
**Owner:** Brian + Claude

## Goal

자동 카테고리 분류의 정확도를 올리고, 사용자가 자기 성향에 맞춰 "Fina의 분류 결과를 얼마나 확인할지" 선택할 수 있게 만든다. 분류 알고리즘 자체는 사용자에게 노출하지 않고 내부 결정으로 유지한다.

## Why now

- LLM(Gemini Flash Lite)에 100% 의존하고 있어 정확도가 일관되지 못함.
- Plaid가 transaction마다 `personal_finance_category` (primary + detailed + confidence_level)을 주고 있는데 활용 안 함 — rawData JSON에만 저장.
- 사용자가 같은 merchant를 수정해도 다음 transaction에서 같은 실수 반복 (학습 안 됨, `merchant_mapping`은 explicit chat tool로만 생성).
- More 탭에 "Categorization style"이 placeholder로 자리만 잡혀 있음 — 의미 있는 기능으로 채울 필요.

## Non-goals

- 카테고리 set 변경 (default 11개 유지).
- Plaid taxonomy → 우리 카테고리 정적 매핑 테이블 작성 (LLM이 PFC를 hint로 받아 매핑하게 함).
- Categorization 알고리즘의 세부 조정(prompt, threshold, model) 사용자 노출. confirm 빈도(mode)만 노출.
- 다중 workspace에서 mode를 workspace별로 다르게 (User-level 하나로 통일 — v2 후보).
- Embedding/similarity merchant matching (exact normalized string match만 v1 — v2 후보).
- Auto-promoted `merchant_mappings` 삭제 전용 UI 신설 (v1은 기존 chat tool로 manual edit 가능 — 아래 §Auto-mapping delete path 참조).

## Shared library touchpoints (`@fina/shared`)

설계 시작 시점에 명시 — 새 type/schema는 shared lib에 먼저 추가:

- `CategorizationMode` literal union: `'flexible' | 'strict' | 'auto'` + zod schema
- `AllocationDTO.source` union 확장: `'manual' | 'ai' | 'mapping' | 'history' | null` (`'history'` 추가)
- `AllocationDTO.needsConfirmation: boolean` 필드 추가
- `AllocationDTO.dismissedUntil: string | null` 필드 추가 (ISO 날짜, snooze 만료 시점)
- `MeDTO.user.categorizationMode: CategorizationMode` 필드 추가 (DTO 이름은 `MeDTO`, user는 그 안의 nested object — `libs/shared/src/dto/me.ts:MeDTO` 참조)
- `PATCH /me` zod schema에 optional `categorizationMode?: CategorizationMode` 필드 추가 (partial update)
- `PresentationBlock` discriminated-union에 새 variant `categorize_confirm_card` 추가 (snake_case로 기존 `confirm_card` 컨벤션 맞춤, `libs/shared/src/dto/chat.ts`):

  ```ts
  | {
      type: 'categorize_confirm_card';
      count: number;
      items: { txId: string; merchant: string; categoryName: string }[];
      moreCount: number;
    }
  ```

## Architecture

### Pipeline (backend: `apps/api/src/categorize/service.ts`)

새 transaction이 categorize 대상이 되면 다음 순서로 카테고리 결정. **기존 단일 alloc 제약(`allocations.length === 1` filter)을 그대로 유지** — split transaction은 전체 pipeline에서 skip (history step 포함).

1. **Explicit merchant mapping**: `merchant_mappings` 테이블 lookup. workspaceId + merchantNormalized batch IN 쿼리로 N개 한 번에. (기존 동작 유지)
   - hit → 카테고리 결정. `source='mapping'`. `needsConfirmation=false`. `dismissedUntil=NULL`.
2. **History lookup** (NEW): 같은 workspace에서 같은 `merchantNormalized`를 가진 가장 최신 (`removedAt=null`) categorized transaction의 single allocation을 가져옴. **Batch query** — `merchantNormalized IN (...)` 하나로 N개 한꺼번에, 그룹별로 `ORDER BY occurredAt DESC, id ASC LIMIT 1` (id는 동일 occurredAt tiebreaker, 결정적).
   - prior allocation의 `categoryId IS NULL`이면 skip (Uncategorized prior는 hint 안 됨, step 3로 fall-through).
   - prior category가 archived (`Category.archivedAt IS NOT NULL`)이면 step 3로 fall-through.
   - hit → categoryId 그대로 적용. `source='history'`. `needsConfirmation`은 §needsConfirmation 규칙. **`dismissedUntil` inherit**: prior allocation의 `dismissedUntil`이 지금 시점 기준 미래면 (`prior.dismissedUntil > now`) 그 값 그대로 복사. 만료/NULL이면 NULL.
3. **LLM with Plaid PFC hint** (modified):
   - `rawData.personal_finance_category.{primary, detailed, confidence_level}`을 추출.
   - **PFC null 처리**: `rawData.personal_finance_category`가 없거나 (manual/csv tx, 일부 Plaid 계정 타입에서 빠짐) primary가 undefined면 hint 없이 그대로 prompt 진행. 누락된 PFC는 hint 줄에서 omit.
   - Gemini prompt에 hint로 포함: "Plaid suggests: {primary} / {detailed} (confidence: {confidence_level}). Map this into one of the workspace categories below."
   - 결과 카테고리 적용. `source='ai'`. `needsConfirmation`은 §needsConfirmation 규칙. `dismissedUntil=NULL`.

Pipeline 흐름은 hit-first short-circuit. step 1에서 hit하면 step 2/3 skip. step 2에서 hit하면 step 3 skip.

**Split tx / Manual tx 처리:**
- Split tx (allocation N≥2): 기존과 동일하게 전체 pipeline skip. `needsConfirmation=false` default.
- Manual tx (`TransactionSource.manual`, 사용자가 직접 추가): 기존과 동일하게 pipeline skip (사용자가 입력 시 카테고리도 선택). `needsConfirmation=false` (사용자가 본인 의도로 분류).

**Race condition guard:**
- 모든 update에 기존 atomic guard 유지: `WHERE allocation.id=? AND categoryId IS NULL AND source IS NULL`.
- `needsConfirmation`, `dismissedUntil` write도 같은 guard 안에서 한 번에 (단일 `updateMany` payload).
- Concurrent PATCH category가 race로 들어오면 우리 update는 0 affected rows → 그냥 skip (manual write 이김).

### Mode setting

- DB: `User.categorizationMode CategorizationMode @default(flexible)` (NOT NULL)
- 새 Prisma enum `CategorizationMode { flexible strict auto }`
- 새 screen: `/categorization` (mobile, `apps/mobile/app/categorization/index.tsx`). Radio 3개 + 한 줄 설명:
  - **Flexible** (default) — "New merchants만 한 번 확인. 답 안 해도 다음번엔 그냥 분류."
  - **Strict** — "모든 merchant는 확인이 끝나야 자동분류. 정확도 우선."
  - **Auto** — "확인 안 물어봄. 잘못된 분류는 직접 찾아서 고치기."
- More 탭 AI 그룹에 "Categorization style" row 복귀, `detail`은 현재 모드 라벨 ("Flexible" 등).
- API: `PATCH /me` partial update에 `categorizationMode` 필드. body의 다른 필드와 함께 보낼 수 있음.

**Scope:** User-level. 다중 workspace 멤버는 같은 모드를 모든 워크스페이스에 적용 (v1 단순화 의도). 추후 painpoint 생기면 v2에서 membership-level로 이동.

### needsConfirmation 결정 규칙

`TransactionAllocation.needsConfirmation Boolean @default(false)` column 추가.

분류 결정 시점에 mode + source + (resolved category가 'Other'인지) 보고 세팅:

| Mode | mapping | history (prior confirmed) | history (prior unconfirmed) | ai (new merchant) | category = 'Other' (any source) |
|---|---|---|---|---|---|
| Strict | false | false | **true** | **true** | **true** |
| Flexible | false | false | false | **true** | **true** |
| Auto | false | false | false | false | **true** |

**'Other' 룰 발동 조건:** 결과 카테고리의 이름이 `'Other'` (case-insensitive, trim 적용)이고 그 카테고리가 archived가 아닐 때. 워크스페이스가 'Other' 카테고리를 archive하거나 이름을 다른 걸로 바꾸면 룰이 자연스럽게 disable됨 (의도된 동작).

규칙 요약:
- `source='mapping'`: explicit user intent라 항상 confirmed.
- `source='history'`: prior allocation의 `needsConfirmation`을 보고, 그게 false였으면 자동 false. true였으면(즉 confirm 안 된 상태) mode 따라 결정.
- `source='ai'`: 첫 등장 merchant라 mode 따름 (strict/flexible에선 true, auto는 false).
- **category가 'Other'인 경우 mode 무관 항상 `needsConfirmation=true`**: LLM이 'Other'로 던졌다는 건 자신 없다는 신호고, 사용자가 한 번 봐야 한다.

User가 confirm 또는 카테고리 edit하면 `needsConfirmation=false`로 set. 다음번 같은 merchant transaction은 step 2 history hit으로 자연스럽게 confirmed 상태 전파.

**Confirm vs Edit source 전환 정책:**
- **Confirm** (사용자가 "이거 맞아" 누름): source 그대로 유지 (`ai`/`history`/`mapping` 모두 그대로). needsConfirmation=false + dismissedUntil=NULL만 변경. — 이유: telemetry 의미 (분류가 LLM에서 나왔다 vs history에서 나왔다 vs explicit mapping에서 나왔다)를 confirm 이후에도 보존.
- **Edit** (사용자가 다른 카테고리 선택): `source='manual'` 로 변경. needsConfirmation=false + dismissedUntil=NULL. — 이유: 분류 출처가 사용자 의도로 완전히 갈아엎어짐.
- **No-op PATCH** (같은 categoryId로 PATCH): Edit과 동일 취급 — `source='manual'` 로 변경, needsConfirmation=false. 명시적으로 "이 카테고리가 맞다"는 사용자 의도 표현. Auto-promote 카운트에도 들어감.

### Snooze (sheet dismissal)

Bottom sheet swipe-down, backdrop tap, hardware back 모두 "skip"이 아니라 "snooze". allocation에 `dismissedUntil DateTime?` 추가.

- 클라이언트가 사용자가 sheet를 명시적 confirm/edit 없이 닫으면 `POST /workspaces/:id/transactions/:txId/snooze-category` 호출. 서버가 `dismissedUntil = now + 7d` set. `needsConfirmation` 그대로 (true).
- Activity pill 표시 조건: `needsConfirmation=true AND (dismissedUntil IS NULL OR dismissedUntil < now)`
- Daily brief confirm card 카운트 조건도 동일 (snoozed transaction은 카드에서 빠짐)
- 7일 후 자동으로 pill 다시 등장 (사용자가 명시적 action 없이 잊지 않게)
- 사용자가 confirm 또는 카테고리 edit 하면 `dismissedUntil=NULL` + `needsConfirmation=false`로 cleanup.

**Auto mode + 'Other' + snooze 의도:** Auto mode에서 needsConfirmation=true가 발동하는 유일한 케이스는 'Other'. 사용자가 snooze 하면 7일간 pill 사라지고 brief도 (Auto 모드는 brief 카드 자체 표시 안 함) 알림이 없음. 만료 후 다시 pill 등장. 이건 의도된 동작 — "Auto 사용자가 'Other'를 한 번 dismiss 했으니 한동안 안 보고 싶다"는 신호로 해석.

### Auto-promote to merchant_mapping (자동 학습)

같은 merchant + same category로 3번 "사용자 의도 표현됨" (confirmed 또는 manual edit 또는 history 자동 전파 후 confirmed)되면 `merchant_mappings`에 자동 INSERT. 이후 같은 merchant 새 transaction은 step 1에서 즉시 hit하므로 history lookup이나 LLM 호출 안 함.

**트리거 시점:**
- `POST /workspaces/:id/transactions/:txId/confirm-category` 처리 직후 (같은 트랜잭션 안에서 카운트 + INSERT)
- `PATCH /workspaces/:id/transactions/:txId`에서 category 변경 또는 no-op 직후

**카운트 쿼리 (current confirm 포함):**
- 같은 workspace + 같은 `merchantNormalized` + 같은 final `categoryId` 에서, `needsConfirmation=false`이고 `source IN ('ai', 'history', 'manual')` 인 allocation 개수 ≥ 3
- **`mapping` source는 제외** (이미 mapping에서 온 거라 무의미 — mapping이 이미 있으므로 INSERT 시도해도 ON CONFLICT)
- 카운트는 current confirm의 write가 commit된 후 같은 트랜잭션 안에서 수행 → 즉 current row가 카운트에 포함됨.

**INSERT semantics:**
- 카운트가 ≥ 3이면 `merchant_mappings (workspaceId, merchantNormalized, categoryId, source='auto')` INSERT, `ON CONFLICT (workspaceId, merchantNormalized) DO NOTHING`.
- `MappingSource.auto` 값은 기존 enum에 이미 존재 (`manual`, `ai`, `auto`) — schema 변경 없음.
- Race: 두 confirm이 동시에 count=2에서 시작 → 둘 다 count=3 보고 INSERT → 첫 번째 성공, 두 번째 ON CONFLICT 무시. 결과 idempotent.

**Edge case:** 같은 merchant가 이미 explicit `manual` mapping 보유 → step 1에서 hit, count 쿼리는 그 mapping 거치는 allocation들이 `source='mapping'` 이므로 제외 → count 절대 3 도달 못 함 → 추가 INSERT 시도 안 됨. 의도된 동작 (manual mapping이 우선).

**Test 케이스 추가:**
- confirm 1번 → mapping 안 만들어짐
- confirm 3번 (same merchant, same category, source=ai) → mapping INSERT
- confirm 3번 (same merchant, mixed category) → mapping 안 만들어짐
- 이미 manual mapping 있는 merchant confirm 3번 → 추가 INSERT 시도 없음 (count 0)
- Race: 동시 confirm 2개 → 1 INSERT + 1 conflict, 둘 다 200 반환

### Auto-mapping delete path

Auto-promoted mapping이 잘못된 경우 (예: LLM이 한 merchant를 잘못 분류해 3번 confirm된 채로 자동 mapping된 경우) 사용자가 어떻게 되돌릴지:

- 기존 `mapMerchantToCategory` chat tool로 사용자가 새 mapping 지정하면 `source` 가 `manual` 로 덮어쓰임 (workspaceId + merchantNormalized unique key). v1에서는 이 경로만 사용.
- 향후 mapping 관리 전용 UI는 v2.

### Confirm UX

**Activity tab (`apps/mobile/app/(tabs)/activity.tsx`):**
- `needsConfirmation=true AND (dismissedUntil IS NULL OR dismissedUntil < now)` 조건의 transaction row 우측에 "Needs review" pill 표시.
  - 일반 pill: text `colors.accentYellow`, background `colors.surfaceSoft`, border `colors.accentYellow`
  - 카테고리가 'Other'인 경우 (강조): text `colors.down`, background `colors.surfaceSoft`, border `colors.down`. (`down`은 token에 text-only로 표기 — 우리 케이스도 text + border만 사용, background는 surfaceSoft 그대로라 token contract 위배 아님.)
- Pill의 hit area ≥ 44pt × 44pt (iOS touch target).
- row tap → 기존 transaction detail 화면 진입 (변경 없음).
- pill tap → quick confirm bottom sheet (`@gorhom/bottom-sheet`):
  - 큰 글자로 "Starbucks → Dining 이 맞아요?"
  - 버튼 2개:
    - `Confirm` — `POST /workspaces/:id/transactions/:txId/confirm-category` 호출. needsConfirmation=false + dismissedUntil=NULL set. source 그대로 (telemetry 보존).
    - `다른 카테고리` — 기존 `CategoryPickerSheet` 띄움. 카테고리 선택 시 기존 PATCH 호출 (category 또는 allocations[0].categoryId 변경). 서버 PATCH 핸들러가 `needsConfirmation=false` + `dismissedUntil=NULL` + `source='manual'` 같이 set.
- Sheet dismiss (swipe-down, backdrop tap, hardware back 어떤 경로든): 명시적 confirm/edit이 아니라면 **snooze**: `POST /workspaces/:id/transactions/:txId/snooze-category` 호출 → `dismissedUntil = now + 7d`. 7일간 pill 숨김. (Activity 새로고침 시 즉시 사라짐.)

**Daily brief (`apps/api/src/cron/jobs/daily-brief.ts`):**
- 사용자의 가장 최근 brief 생성 시각 계산: `lastBriefAt = MAX(Brief.createdAt WHERE userId = u.id)` (모든 type 통틀어).
- Brief 카드 카운트 window: `tx categorize 시각 > GREATEST(lastBriefAt, now - 7d)` — 즉 직전 brief 이후 또는 최대 7일 전부터 (장기 pause 후 wall of confirmations 방지).
- 그 안에서 조건:
  - allocation `needsConfirmation=true`
  - `dismissedUntil IS NULL OR dismissedUntil < now`
  - allocation의 categorized 시각: `allocation.createdAt` 또는 transaction에 categorize 시각 column이 없으면 transaction 생성 시각 `createdAt` 사용 (구현 시 선택 가능, 의미 동일).
- 0개면 confirm card 생성 안 함.
- Mode가 'auto'면 confirm card 자체를 brief에 추가 안 함 (Activity pill은 'Other'만 유지지만 brief는 빠짐).
- 1개 이상이면 brief blocks에 `categorize_confirm_card` 추가:
  - `count`: 총 needsConfirmation 개수 (snooze 제외, window 내)
  - `items`: 최대 5개 (txId, merchant, categoryName), 가장 최근 categorized 순.
  - `moreCount`: count - items.length (5 초과분)
- Mobile에서 `categorize_confirm_card` 렌더: "오늘 분류한 N개 확인해주세요" + 5개 inline + "Activity에서 보기" 버튼 (`/(tabs)/activity`로 navigate).
- 카드 안에서 직접 confirm 안 함 — Activity가 single source of truth. Brief는 알림 + jump-off.

### Mode별 전체 행동 요약

| Mode | Activity pill | Daily brief confirm card |
|---|---|---|
| Strict | step 2 (prior unconfirmed) + step 3 (new merchant) + Other 어떤 source든 | count > 0이면 표시 |
| Flexible | step 3 (new merchant) + Other 어떤 source든 | count > 0이면 표시 |
| Auto | Other 어떤 source든 | 표시 안 함 (Activity pill만 jamak) |

(이 표는 매트릭스의 결과를 그대로 옮긴 것 — 추상 어휘 안 씀.)

## Data flow / API changes

**New routes:**
- `POST /workspaces/:id/transactions/:txId/confirm-category` — 해당 transaction의 모든 allocation에 `needsConfirmation=false` + `dismissedUntil=NULL` set. category는 그대로, source 변경 없음. Auto-promote trigger. 권한: editor role 이상. Idempotent.
- `POST /workspaces/:id/transactions/:txId/snooze-category` — 해당 transaction의 모든 allocation에 `dismissedUntil = now + 7d` set. needsConfirmation은 그대로 (true). 권한: editor role 이상. Idempotent.
- `PATCH /me` 확장: optional `categorizationMode` 필드.

**Modified routes:**
- `PATCH /workspaces/:id/transactions/:txId` — `categoryId` 또는 `allocations` 변경 시 (no-op PATCH 즉 동일 categoryId 포함) 영향받는 allocation에 `needsConfirmation=false` + `dismissedUntil=NULL` + `source='manual'` 같이 set. Auto-promote trigger.

**Migrations:**
- 단계 1: `pnpm prisma migrate dev --create-only --name categorization_overhaul` 으로 빈 migration 생성.
- 단계 2: 생성된 `migration.sql` 파일에 다음 모두 한꺼번에 추가:
  - `ALTER TYPE "CategorizationSource" ADD VALUE 'history';`
  - `CREATE TYPE "CategorizationMode" AS ENUM ('flexible', 'strict', 'auto');`
  - `ALTER TABLE "users" ADD COLUMN "categorizationMode" "CategorizationMode" NOT NULL DEFAULT 'flexible';`
  - `ALTER TABLE "transaction_allocations" ADD COLUMN "needsConfirmation" BOOLEAN NOT NULL DEFAULT false;`
  - `ALTER TABLE "transaction_allocations" ADD COLUMN "dismissedUntil" TIMESTAMP(3);`
  - `CREATE INDEX "transactions_workspace_merchant_occurred_idx" ON "transactions" ("workspaceId", "merchantNormalized", "occurredAt" DESC) WHERE "removedAt" IS NULL;` (partial index — Prisma schema에서는 인덱스만 선언하고 partial 조건은 SQL로 추가)
- 단계 3: prisma schema에 enum + 컬럼 + 인덱스 선언 동기화 (Prisma raw SQL과 schema 일치 유지).
- 단계 4: `pnpm prisma migrate dev` (apply).
- 기존 데이터: 모두 needsConfirmation=false, dismissedUntil=NULL. 'Other' 분류된 기존 transaction은 손대지 않음 — 새 transaction부터 룰 적용 (사용자 결정).

## Testing

- `categorize/service.test.ts`:
  - step 1 hit (mapping) → source='mapping', needsConfirmation=false
  - step 2 hit (history confirmed) → source='history', needsConfirmation=false
  - step 2 hit (history unconfirmed) × Strict mode → needsConfirmation=true
  - step 2 hit (history snoozed, dismissedUntil > now) → new allocation의 dismissedUntil도 prior 값 inherit
  - step 2 hit (history snoozed expired, dismissedUntil < now) → new dismissedUntil NULL
  - step 2 prior category archived → step 3로 fall-through
  - step 2 prior allocation.categoryId IS NULL → step 3로 fall-through
  - step 3 hit (LLM, new merchant) × Flexible mode → needsConfirmation=true
  - step 3 hit × Auto mode → needsConfirmation=false
  - 'Other' 결과 × Auto mode → needsConfirmation=true (mode override)
  - 'Other' 카테고리가 archive된 워크스페이스 → 'Other' 룰 발동 안 함
  - Plaid PFC가 prompt에 포함되는지 (LLM stub 검사)
  - Plaid PFC가 null인 transaction → hint 없이 prompt에 fallback, throw 안 함
  - Split tx (alloc N=2) → pipeline 전체 skip, needsConfirmation=false default
  - History lookup batch query (3 merchant 묶음) → 1 query만 발생 (instrumentation)
- `categorize/auto-promote.test.ts` (신규):
  - 같은 merchant + same category confirm 1, 2번 → mapping INSERT 안 됨
  - 3번째 confirm → mapping INSERT, source='auto'
  - 3번 confirm (source: ai, ai, ai) → mapping INSERT
  - 3번 confirm (source: ai, history, manual) → mapping INSERT (mapping 제외 카운트)
  - 3번 confirm 중 1개가 source='mapping' → 그 row는 카운트 제외 (그래도 mapping 이미 있으니 INSERT 시도 시 ON CONFLICT)
  - merchant 같지만 category 섞임 (Dining 2번 + Coffee 1번) → INSERT 안 됨
  - 이미 manual mapping 존재 → 카운트 0 (mapping source 제외), INSERT 시도 안 됨
  - Race: 동시 confirm 두 개 → 첫 INSERT, 둘째 ON CONFLICT, 둘 다 200 응답
- `cron/jobs/daily-brief.test.ts`:
  - needsConfirmation 0개 → card 미생성
  - needsConfirmation 3개 → card.count=3, items=3, moreCount=0
  - needsConfirmation 7개 → card.count=7, items=5, moreCount=2
  - dismissedUntil > now인 transaction은 카운트에서 제외
  - Auto mode → card 미생성
  - lastBriefAt 가 30일 전 (long pause) → window cap=7d 적용, 7일 이내 분류된 것만 카운트
  - lastBriefAt 가 2일 전 (정상) → window=2d, 그 이내 분류된 것만 카운트
- `routes/transactions.test.ts`:
  - POST confirm-category: 권한 (editor 미만 reject), idempotent, needsConfirmation=false + dismissedUntil=NULL + source 그대로 (ai→ai)
  - POST snooze-category: dismissedUntil = now + 7d, needsConfirmation 그대로 (true)
  - PATCH category to different categoryId: needsConfirmation=false + source='manual' + dismissedUntil=NULL
  - PATCH category to same categoryId (no-op): needsConfirmation=false + source='manual' + dismissedUntil=NULL (의도된 동작)

## Telemetry

신규 (개발자가 분류 품질 평가 + tuning 용):

- `categorize.completed` 이벤트: workspaceId, source ('mapping'|'history'|'ai'), category (resolved 카테고리 이름), pfcPrimary, pfcConfidence, pfcMissing (boolean)
- `categorize.confirmed` 이벤트: workspaceId, source (사용자 confirm 시점의 source), action ('confirm'|'edit'|'snooze')
- `mapping.auto_promoted` 이벤트: workspaceId, merchantNormalized, categoryName, confirmCount

Confirm/edit ratio = `categorize.confirmed{action=confirm} / categorize.completed{source=ai}` 가 50% 미만이면 LLM 정확도 개선 트리거.

## Risks / open questions

- **Plaid PFC 정확도:** LLM에게 hint로만 주므로 잘못된 PFC라도 LLM이 reject할 수 있어야 함. Prompt에 "Plaid suggests X (confidence Y) — use only if it fits one of the categories" 톤 조절.
- **PFC 누락:** manual/csv tx 및 일부 Plaid 계정에서는 PFC가 빠짐. spec에 null-handling 명시했으나 LLM이 hint 없을 때도 정확도 유지하는지 모니터링 필요.
- **LLM prompt 비용:** PFC hint 추가로 transaction당 ~30 토큰 증가. 50-tx batch면 ~1.5K 추가. Gemini Flash Lite 가격 기준 negligible (월 transaction 수 < 100K일 때).
- **History lookup 성능:** Batch IN 쿼리 + 부분 인덱스로 처리. webhook 100tx 케이스도 1 round-trip.
- **Brief card frequency:** Strict mode + 활발한 사용자도 7일 snooze + window cap으로 누적 완화. v2에서 "Activity pill이 7일 이상 된 것은 자동 archive" 같은 decay 고려.
- **Mode label 직관성:** "Strict / Flexible / Auto"가 영어 직관과 어긋날 가능성 (Strict가 분류 정확도가 strict한 것처럼 읽힘). 실 출시 전 mobile copy review에서 액션 프레임 labels ("Always confirm / Confirm new / Never ask") 와 A/B 시험 고려.
- **History lookup robustness:** Plaid merchant 이름이 가끔 바뀜 ("SQ *COFFEE" → "Blue Bottle Coffee"). v1은 정확한 normalize string 일치만 — v2에서 embedding 거리 기반 fuzzy match 고려.
- **Multi-workspace mode:** User-level이라 한 사용자가 personal + family workspace에 다른 mode 못 씀. 실 painpoint 생기면 v2에서 membership-level로.
- **Auto-mapping delete UI 부재:** v1은 잘못된 auto-mapping을 chat tool `mapMerchantToCategory`로만 덮어쓰기 가능. 전용 mapping 관리 UI는 v2.
- **Multi-workspace auto-promote:** 같은 사용자가 두 워크스페이스에서 같은 merchant를 다른 카테고리로 confirm하면 각 워크스페이스마다 독립된 mapping 생성 (workspaceId 키). 의도된 동작.
