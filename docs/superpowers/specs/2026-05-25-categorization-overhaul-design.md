# Categorization Overhaul Design

**Status:** Draft (brainstorm → spec)
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
- Categorization 동작의 세부 조정(prompt, threshold, model) 사용자 노출. 한 번에 정한다.

## Shared library touchpoints (`@fina/shared`)

설계 시작 시점에 명시 — 새 type/schema는 shared lib에 먼저 추가:

- `CategorizationMode` literal union: `'flexible' | 'strict' | 'auto'` + zod schema
- `CategorizationSource` literal union 확장: `'mapping' | 'history' | 'ai' | 'manual'` ('history' 새로)
- `UserDTO.categorizationMode: CategorizationMode` 필드 추가
- `TransactionAllocationDTO.needsConfirmation: boolean` 필드 추가
- `PATCH /me` zod schema에 optional `categorizationMode` 필드 추가
- 새 presentation block type `categorize-confirm-card`: `{ type: 'categorize-confirm-card', count: number, items: { txId, merchant, categoryName }[], moreCount: number }`

## Architecture

### Pipeline (backend: `apps/api/src/categorize/service.ts`)

새 transaction이 categorize 대상이 되면 다음 순서로 카테고리 결정:

1. **Explicit merchant mapping**: `merchant_mappings` 테이블 lookup (기존 동작 유지).
   - hit → 카테고리 결정. `source='mapping'`. `needsConfirmation=false`.
2. **History lookup** (NEW): 같은 workspace에서 같은 `merchantNormalized`를 가진 가장 최신 (`removedAt=null`) transaction의 allocation을 가져옴. 그 allocation의 categoryId를 그대로 사용.
   - hit → `source='history'`. `needsConfirmation`은 §needsConfirmation 규칙 참조.
3. **LLM with Plaid PFC hint** (modified):
   - `rawData.personal_finance_category.{primary, detailed, confidence_level}`을 추출.
   - Gemini prompt에 hint로 포함: "Plaid suggests: {primary} / {detailed} (confidence: {confidence_level}). Map this into one of the workspace categories below."
   - 결과 카테고리 적용. `source='ai'`. `needsConfirmation`은 §needsConfirmation 규칙 참조.

Pipeline 흐름은 hit-first short-circuit. step 1에서 hit하면 step 2/3 skip. 마찬가지로 step 2에서 hit하면 step 3 skip.

### Mode setting

- DB: `User.categorizationMode CategorizationMode @default(flexible)` (NOT NULL)
- 새 Prisma enum `CategorizationMode { flexible strict auto }`
- 새 screen: `/categorization` (mobile). Radio 3개 + 한 줄 설명:
  - **Flexible** (default) — "New merchants만 한 번 확인. 답 안 해도 다음번엔 그냥 분류."
  - **Strict** — "모든 merchant는 확인이 끝나야 자동분류. 정확도 우선."
  - **Auto** — "확인 안 물어봄. 잘못된 분류는 직접 찾아서 고치기."
- More 탭의 AI 그룹에 "Categorization style" row 복귀, `detail`은 현재 모드 라벨 ("Flexible" 등).
- API: `PATCH /me`로 변경. Body: `{ categorizationMode: 'flexible' | 'strict' | 'auto' }`.

### needsConfirmation 결정 규칙

`TransactionAllocation.needsConfirmation Boolean @default(false)` column 추가.

분류 결정 시점에 mode + source + (resolved category가 'Other'인지) 보고 세팅:

| Mode | mapping | history (prior confirmed) | history (prior unconfirmed) | ai (new merchant) | category = 'Other' |
|---|---|---|---|---|---|
| Strict | false | false | **true** | **true** | **true** |
| Flexible | false | false | false | **true** | **true** |
| Auto | false | false | false | false | **true** |

규칙 요약:
- `source='mapping'`: explicit user intent라 항상 confirmed.
- `source='history'`: prior allocation의 `needsConfirmation`을 보고, 그게 false였으면 자동 false. true였으면(즉 confirm 안 된 상태) mode 따라 결정.
- `source='ai'`: 첫 등장 merchant라 mode 따름 (strict/flexible에선 true, auto는 false).
- **category가 'Other'인 경우 mode 무관 항상 `needsConfirmation=true`**: 사용자 명시 규칙. LLM이 'Other'로 던졌다는 건 자신 없다는 신호고, 사용자가 한 번 봐야 한다.

기존 'Other' 카테고리 이름은 default seed에 정의된 것 (`'Other'`)로 식별. 워크스페이스가 이름을 바꿔도 동작이 자연스럽도록 — 단순화: 카테고리 이름이 'Other' (case-insensitive) 인지로 판정. 'Other' 카테고리 자체를 archive 하면 룰이 발동 안 됨 (그 워크스페이스는 Other 미사용으로 간주).

User가 confirm 또는 카테고리 edit하면 `needsConfirmation=false`로 set. 다음번 같은 merchant transaction은 step 2 history hit으로 자연스럽게 confirmed 상태 전파.

### Confirm UX

**Activity tab (`apps/mobile/app/(tabs)/activity.tsx`):**
- `needsConfirmation=true`인 transaction row 우측에 "Needs review" pill 표시. 카테고리가 'Other'인 경우 빨강 살짝 강조 (background `colors.downSoft`), 그 외엔 노랑 (background `colors.warnSoft`).
- row tap → 기존 transaction detail 화면 진입 (변경 없음).
- 별도 tap target: pill 자체를 tap하면 quick confirm bottom sheet 열림.
- Sheet 내용: 큰 글자로 "Starbucks → Dining 이 맞아요?" + 버튼 2개:
  - `Confirm` — `POST /transactions/:id/allocations/:allocId/confirm` 호출. needsConfirmation=false로 변경, category 그대로.
  - `다른 카테고리` — 기존 `CategoryPickerSheet` 띄움. 카테고리 선택 시 기존 PATCH로 category update + needsConfirmation=false. source='manual'.
- Sheet swipe down으로 닫으면 그대로 둠 (사용자가 "skip"한 효과).

**Daily brief (`apps/api/src/cron/jobs/daily-brief.ts`):**
- Brief 생성 시점에 해당 user의 모든 workspace를 통틀어 needsConfirmation=true이고 직전 24h 안에 분류된 transaction을 count.
- 0개면 confirm card 생성 안 함.
- Mode가 'auto'면 'Other' 카테고리도 brief에 표시하지 않음 (Auto의 의도: 방해 최소화. Activity pill은 유지지만 brief는 빠짐).
- 1개 이상이면 brief block에 `categorize-confirm-card` 추가:
  - `count`: 총 needsConfirmation 개수
  - `items`: 최대 5개 (txId, merchant, categoryName)
  - `moreCount`: count - items.length (5 초과분)
- Mobile에서 `categorize-confirm-card` 렌더: "오늘 분류한 N개 확인해주세요" + 5개 inline + "Activity에서 보기" 버튼 (`/activity`로 navigate).
- 카드 안에서 직접 confirm 안 함 — Activity가 single source of truth. Brief는 알림 + jump-off.

### Mode별 전체 행동 요약

| Mode | Activity pill | Daily brief confirm card |
|---|---|---|
| Strict | 거의 모든 새 transaction에 표시 | 0 초과면 항상 표시 |
| Flexible | 새 merchant first transaction + 'Other'만 | 0 초과면 표시 |
| Auto | 'Other'만 | 표시 안 함 |

## Data flow / API changes

**New routes:**
- `POST /workspaces/:id/transactions/:txId/confirm-category` — 해당 transaction의 모든 allocation에 `needsConfirmation=false` set. category는 그대로. 권한: editor role 이상.
- `PATCH /me` 확장: `categorizationMode` 필드 받음.

**Modified routes:**
- `PATCH /workspaces/:id/transactions/:txId` — category 또는 allocations 변경 시 영향받는 allocation에 `needsConfirmation=false` + `source='manual'` 같이 set.

**Migrations:**
- `prisma migrate dev --create-only` 한 번 push:
  - `User.categorizationMode` 추가, default 'flexible'
  - `TransactionAllocation.needsConfirmation` 추가, default false
  - `CategorizationSource` enum에 `history` 추가
  - `CategorizationMode` enum 새로 생성
- 기존 데이터: 모두 needsConfirmation=false. 'Other' 분류된 기존 transaction은 손대지 않음 — 새 transaction부터 룰 적용.

## Testing

- `categorize/service.test.ts`:
  - step 1 hit (mapping) → source='mapping', needsConfirmation=false
  - step 2 hit (history confirmed) → source='history', needsConfirmation=false
  - step 2 hit (history unconfirmed) × Strict mode → needsConfirmation=true
  - step 3 hit (LLM, new merchant) × Flexible mode → needsConfirmation=true
  - step 3 hit × Auto mode → needsConfirmation=false
  - 'Other' 결과 × Auto mode → needsConfirmation=true (mode override)
  - Plaid PFC가 prompt에 포함되는지 (LLM stub 검사)
- `cron/jobs/daily-brief.test.ts`:
  - needsConfirmation 0개 → card 미생성
  - needsConfirmation 3개 → card.count=3, items=3, moreCount=0
  - needsConfirmation 7개 → card.count=7, items=5, moreCount=2
  - Auto mode + 'Other'만 있을 때 → card 미생성
- `routes/transactions.test.ts`:
  - POST confirm endpoint: 권한, idempotent, needsConfirmation toggle
  - PATCH category endpoint: needsConfirmation=false + source='manual' 함께 변경

## Risks / open questions

- **Plaid PFC 정확도:** LLM에게 hint로만 주므로 잘못된 PFC라도 LLM이 reject할 수 있어야 함. Prompt를 "Plaid suggests X (low confidence) — verify"로 톤 조절.
- **Other 카테고리 archive:** 워크스페이스가 'Other' 카테고리를 archive하면 'Other' 룰 발동 안 함 (의도된 동작). LLM이 'Other'로 보낼 카테고리가 없으면 결과를 reject → uncategorized (existing fallback).
- **History lookup 성능:** 같은 merchantNormalized의 "가장 최신" 쿼리. 인덱스 `[workspaceId, merchantNormalized, occurredAt DESC]` 필요.
- **Brief card frequency:** Strict mode + 활발한 사용자는 매일 brief에 card가 나옴 — overwhelming일 수 있음. 사용자가 직접 mode 바꿀 수 있으니 v1에선 그대로 진행, v2에서 "최근 7일에 confirm한 적 없는 merchant만 보여줌" 등으로 조절 고려.
