# Fina — Design Spec

**Date:** 2026-05-07
**Status:** Brainstorm complete, ready for implementation planning
**Owner:** Brian (cwsbrian@gmail.com)

---

## 1. Vision

**Fina = "채팅으로 상담하는 개인 CFO"** — 가계부 앱이 아니라 **AI Financial Advisor**.

가계부(트랜잭션, 카테고리, 예산, 스케줄)는 advisor 가 사용자에 대해 알기 위한 substrate 일 뿐, product 의 정체는 advisor 자체. 사용자 입장에서 "내 돈 사정을 다 아는 친구한테 매일 카톡으로 상담받는 느낌."

### 3가지 핵심 약속 (other apps 대비 차별화)

1. **Persistence** — 사용자의 financial history 가 DB 에 살아있어서 매번 컨텍스트 재구성 안 해도 됨 (vs ChatGPT)
2. **Tool-calling agent** — 채팅 안에서 실제 앱 state 변경 가능 (예산 늘리기, 스케줄 잡기, 카테고리 정정). 대화 → 행동
3. **Forward-looking** — Tracking 이 아니라 advising. "이번주 살아남기 plan", "어제 산 거 반영해서 남은 달 다시 계산"

이 3가지가 다른 가계부 앱 + ChatGPT 둘 다 못 하는 영역. **이게 Fina 의 hill**.

---

## 2. Target & Market

- **타깃 사용자**: 처음엔 본인 + 가족 (dogfooding), 검증되면 consumer product 로 확장
- **시장**: 캐나다 시작. Bank 연동은 **Plaid** 사용 (Trial 10 Items 무료 → 이후 pay-as-you-go, monthly minimum 없음). Flinks 는 enterprise 가격이라 v2+ 검토.
- **Architecture**: 처음부터 multi-tenant + auth + billing 가능하게 설계, MVP 스코프는 단일 사용자

---

## 3. Architecture

### 3-surface 모델

```
                  Backend (Node + TS)
   ┌─────────────┐   ┌────────────┐   ┌──────────┐
   │  REST/RPC   │   │ Chat Agent │   │   Cron   │
   │     API     │   │ (LLM+tools)│   │ (daily)  │
   └──────┬──────┘   └─────┬──────┘   └────┬─────┘
          └────────────────┼───────────────┘
                           ▼
                    ┌──────────────┐
                    │   Postgres   │ ← Source of Truth
                    └──────────────┘
                           ▲
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌──────────────┐          ┌──────────────┐
     │ Plaid sync   │          │ CSV import   │
     └──────────────┘          └──────────────┘
                           ▲
                           │ HTTPS
                  ┌────────┴────────┐
                  │  React Native   │
                  │  (Chat + UI)    │
                  └─────────────────┘
```

### 핵심 원칙

1. **DB 가 single source of truth.** UI 든 Chat 이든 결국 DB 를 read/write. 두 surface 사이 동기화 따로 안 함.
2. **Chat agent = LLM + tools.** Chat 에서 명령하면 LLM 이 tool 호출 → 백엔드가 실행 → DB 업데이트 → UI 에도 즉시 반영.
3. **Cron 은 단 하나 — daily morning ritual.** 다른 알림은 transaction sync 시점이나 daily ritual 안에서 처리.
4. **Plaid sync 는 backend 가 주관.** Webhook + 초기 backfill. Categorization 은 merchant 매핑 → AI suggest → uncategorized 순.
5. **Python AI service 분리는 v2+.** 처음엔 Node 모놀리스로 속도 우선. 인터페이스를 깔끔히 두면 나중 분리 쉬움.

---

## 4. Multi-Tenancy 모델

**Workspace 기반** (Notion / Slack workspace 패턴):

- **User** = 한 사람 (auth identity)
- **Workspace** = 독립적인 ledger (transactions, budgets, schedules, Plaid items 모두 속함)
- **Membership** = User ↔ Workspace 관계 (M:N), `role` 포함 (owner / editor / viewer)

User 1명이 여러 Workspace 에 속할 수 있고 (개인 / 가족 / 친구 모임 등), 초대는 Workspace 단위.

### v1 단순화

- 가입 시 personal workspace + owner membership 자동 생성
- 사용자는 그 1개 workspace 만 가짐
- **Schema 는 multi-workspace 가정으로 시작** — 모든 row 에 `workspace_id` 박아둠. v2 의 invite 기능 추가 시 schema 변경 불필요.

---

## 5. Chat Agent — Tool Calling 모델

### 핵심 mental model

> **LLM 이 DB 에 직접 write 하는 게 아니다.**
> **LLM 은 "이 함수 이런 인자로 호출해주세요" 라고 제안만 하고, 실제 실행은 백엔드.**

### Tool 호출 시퀀스

```
사용자 메시지 → 백엔드가 LLM API 호출 (system + history + financial_context + tools)
              → LLM 응답: tool_call (e.g. setBudget)
              → 백엔드가 권한 체크 + 실행 + 결과 캡처
              → 결과를 LLM 한테 다시 보냄
              → LLM 이 텍스트/추가 tool 호출 응답
              → (반복)
              → 최종 응답을 chat_messages 에 저장 + 클라이언트 전송
```

### Context 주입 패턴 (Fina 의 차별화)

매 LLM 호출 직전, 백엔드가 DB 에서 최신 financial state 를 빌드해서 system message 로 주입:

```typescript
const messages = [
  { role: "system", content: SYSTEM_PROMPT },
  { role: "system", content: buildFinancialContext(workspaceId) },  // ← 매번 fresh
  ...recentChatMessages,
  { role: "user", content: newUserMessage },
];
```

`buildFinancialContext` 가 budget 진행상황, 최근 트랜잭션, 예정 plan, 구독 등을 짧은 markdown 으로 요약. **LLM 이 tool 안 불러도 즉답 가능 + tool 호출 시에도 더 정확.**

### Tool inventory (v1 starter ≈ 21개)

**Transactions**
- `listTransactions({ period?, category?, merchant?, limit? })`
- `getUncategorizedTransactions({ limit? })`
- `addTransaction({ amount, merchant, date?, category?, note? })`
- `categorizeTransaction({ tx_id, category })`
- `updateTransaction({ tx_id, fields })`

**Categories**
- `listCategories()`
- `createCategory({ name, parent? })`
- `mapMerchantToCategory({ merchant, category })`

**Budget**
- `getBudget({ category?, period? })`
- `setBudget({ category, amount, period })`

**Schedule (예정 지출)**
- `listScheduledSpend({ from?, to? })`
- `addScheduledSpend({ date, amount, category, note })`
- `removeScheduledSpend({ id })`

**Recurring (구독/고정)**
- `listRecurring()`
- `addRecurring({ name, amount, cadence, next_date })`

**Analytics**
- `getSpendingSummary({ period, group_by })`
- `getHistoricalComparison({ this_period, compare_to })`

**Plaid**
- `linkBankAccount()` — 클라이언트에 Plaid Link 띄우기 신호

**Settings**
- `updateMorningTime({ time, timezone? })`
- `pauseDailyBrief({ until })`
- `resumeDailyBrief()`

**Presentation tools** (UI block 출력 — DB write 안 함, chat_messages 에 block 추가)
- `presentText({ markdown })`
- `presentCategorizationCards({ tx_ids: string[] })`
- `presentConfirmCard({ question, on_accept, on_reject })`
- `presentScheduleForm({ defaults? })`
- `presentBudgetEdit({ category })`
- `presentQuickReplies({ options })`

### 안전장치

- LLM 은 미리 정의된 함수만 호출. SQL injection 등 불가능
- 인자 schema 강제 (JSON Schema)
- 권한 체크는 백엔드 (LLM 한테 권한 모델 가르치지 않음)
- Destructive op (트랜잭션 삭제 등) 은 confirm 거치게 디자인

---

## 6. Daily Morning Ritual

### 시퀀스

```
사용자 timezone 기준 아침 (default 8:00 AM, 사용자 설정 가능)
  ↓
백엔드 cron worker 가 활성 사용자 순회 (timezone 별 batch)
  ↓
사용자 한 명 당 백엔드가 "Morning Brief Context" 빌드:
  - 어제 (24h) 새 트랜잭션 + uncategorized 항목
  - 오늘 예정 schedule
  - 이번주 / 이번달 budget progress
  - 다음 7일 안 예정된 recurring expense
  - Deviation: 예상 vs 실제 페이스
  - 작년 같은 달 trend
  ↓
LLM 한테 "morning brief 한 메시지 생성, 모든 의미 있는 항목 한 메시지에 묶어"
  - Presentation tools 로 categorize_card / text / quick_replies 혼합
  - 별 거 없으면 빈 응답 OK (메시지 안 보냄)
  ↓
백엔드:
  - chat_messages 에 assistant 메시지 INSERT
  - Push notification 발송:
      - 짧고 카드 없으면: 메시지 그대로 push body
      - 길거나 인터랙티브 카드 있으면: "Fina 가 어제 내역 확인 받고 싶대"
  ↓
사용자가 푸시 탭 → 채팅 화면 → 메시지 확인 → 카드별 1탭 응답 또는 자유 채팅
```

### Rich chat blocks 모델

Chat message 는 plain text 가 아니라 **blocks 의 list**:

```typescript
type Block =
  | { type: "text"; markdown: string }
  | { type: "categorize_card"; tx_id: string; merchant: string; amount: number;
      time: Date; suggested_category?: string }
  | { type: "confirm_card"; question: string; accept_label: string;
      reject_label: string; on_accept: ToolCall; on_reject: ToolCall }
  | { type: "schedule_form"; defaults?: object }
  | { type: "budget_edit"; category: string; current: number }
  | { type: "quick_replies"; options: { label: string; payload: string }[] };
```

RN 클라이언트는 각 block type 에 대응하는 컴포넌트 렌더러 보유. LLM 은 presentation tool 호출로 block 들 emit (LLM 이 raw JSON UI 만들 필요 없음).

**예시 morning ritual 출력:**
```json
{
  "role": "assistant",
  "blocks": [
    { "type": "text", "markdown": "어제 사용한 내역 중 확인 받고 싶은 거 있어:" },
    { "type": "categorize_card", "tx_id": "tx_1", "merchant": "Costco",
      "amount": 87, "time": "2026-05-06T21:00", "suggested_category": "시장" },
    { "type": "categorize_card", "tx_id": "tx_2", "merchant": "Tim Hortons",
      "amount": 6.50, "time": "2026-05-06T10:30", "suggested_category": "외식/카페" },
    { "type": "text", "markdown": "그리고 오늘 시장 $100 잡아놓은 거 잊지 마 🛒" }
  ]
}
```

각 카드는 카테고리 input + ✓ 버튼 가짐. 1탭으로 categorize 완료, 다른 카드 영향 없이 개별 처리.

### 메시지 안 보내는 조건

- 새 트랜잭션 0개 + 예정 plan 0개 + 페이스 정상 → skip (noise 방지)
- LLM 도 "별 거 없음" 응답 가능

### 사용자 설정

- `morning_time`, `timezone`, `snooze_until`
- Settings UI 또는 chat 으로 변경 (`pauseDailyBrief({ until })` tool)

---

## 7. Conversation Context 관리

### LLM 은 stateless

매 호출마다 messages 배열 전체를 다시 보내야 함. 백엔드가 책임.

### 패턴

1. **DB 에 모든 메시지 누적 저장** (`chat_messages` 테이블)
2. **호출 시 sliding window** — 최근 20~30 메시지만 LLM 한테
3. **Anthropic prompt caching** — system prompt + 사용자 프로필 + financial context 를 cache (~90% input cost 절감)
4. **각 chat session 너무 길게 끌지 않기** — daily ritual 마다 새 thread 시작

### "컨텍스트" 두 종류

- **Conversational context**: 최근 chat 메시지들 (sliding window)
- **Financial context**: 최신 budget, 트랜잭션, plan — 매 호출 직전 DB 에서 빌드해서 system message 로 주입

이 분리가 ChatGPT 와 Fina 의 진짜 차이 — Fina 의 모든 호출은 사용자의 latest 재무 상태를 안 채로 시작.

---

## 8. Data Model

### Entities

```
users (id, email, tz, locale, push_token, created_at)
workspaces (id, name, created_at)
memberships (user_id, workspace_id, role, created_at)
plaid_items (id, workspace_id, access_token_encrypted, institution, status, last_sync_at)
transactions (id, workspace_id, plaid_item_id?, amount, currency, merchant_raw,
              merchant_normalized, category_id?, occurred_at, source, raw_data, note)
categories (id, workspace_id, name, parent_id?, icon, color)
merchant_mappings (id, workspace_id, merchant_normalized, category_id, confidence)
budgets (id, workspace_id, category_id, period, amount, start_date)
schedules (id, workspace_id, category_id?, scheduled_date, amount, note, status)
recurring_expenses (id, workspace_id, name, amount, category_id, cadence,
                    next_occurrence, active)
chat_threads (id, workspace_id, user_id, started_at, type)
chat_messages (id, thread_id, role, blocks_jsonb, tool_calls_jsonb, tool_call_id?, created_at)
```

### 주요 디자인 결정

- **`transactions.category_id` nullable** = uncategorized 가 first-class 상태
- **`merchant_normalized`** = "WALMART #1234 BC" → "Walmart" (백엔드 rule-based 정규화)
- **`raw_data` JSONB** = Plaid 원본 보존, 마이그레이션 없이 새 필드 활용 가능
- **`schedules` vs `recurring_expenses`** 별도 — 1회성 vs 반복. Forecasting 은 둘 다 봄
- **`chat_messages.blocks` JSONB** = rich UI 모델
- **Plaid 안 쓰는 사용자**: `plaid_items` 0개여도 OK. Manual + CSV 만으로 작동

### 주요 indexes

- `transactions(workspace_id, occurred_at DESC)`
- `transactions(workspace_id, category_id)`
- `transactions(workspace_id) WHERE category_id IS NULL`
- `chat_messages(thread_id, created_at)`

---

## 9. Tech Stack

| Layer | 선택 | 이유 |
|---|---|---|
| 모바일 | **Expo (React Native)** | 푸시/카메라/Plaid SDK native 통합, EAS Build |
| 백엔드 | **Fastify + TypeScript** | TS 친화, 빠름, 작음 |
| ORM | **Prisma** | TS-first, schema 한 파일, migration |
| DB | **Postgres (managed)** | Render / Neon / Supabase / Railway 중 택 1 |
| Auth | **Clerk** | RN SDK, social login, 무료 티어 10k MAU |
| LLM | **Anthropic Claude default + OpenAI fallback** | Prompt caching, tool use strict |
| LLM client | **Vercel AI SDK** | provider-agnostic + tool-use 통합 |
| Plaid | `plaid-node` + `react-native-plaid-link-sdk` | 표준 |
| Push | **Expo Push Notifications** | iOS/Android abstract |
| Jobs | **pg-boss** (v1) → BullMQ + Redis (스케일 시) | Postgres 만으로 시작 |
| Storage | **S3 / R2** | CSV upload, 영수증 |
| Hosting | **Render** 또는 **Fly.io** | 가격 + 단순함 |
| Distribution | **EAS** | TestFlight + Play internal |
| Observability | **Sentry + Logtail/Axiom** | 무료티어 |
| Secrets | **Doppler 또는 .env + 1Password** | Plaid token, Anthropic key |
| Encryption | **app-level AES-GCM** (v1) → KMS (v2) | Plaid access_token at-rest |
| CI | **GitHub Actions** | Lint + typecheck + test |

### Repo 구조

**Monorepo** (pnpm + Turborepo):
- `apps/mobile` — Expo RN
- `apps/api` — Fastify + Prisma
- `packages/shared` — types, validators, tool definitions, block schemas

**이유**: Tool 인자 schema 하나 정의 → 백엔드/모바일 양쪽 공유. v1 속도 ↑.

---

## 10. MVP Roadmap

### Phase 1 — Walking Skeleton (4~6주)

**목표**: 본인 dogfooding. End-to-end 작동.

- Expo 앱 + Node API + Postgres
- Clerk 로그인 (이메일 + Google)
- Workspace 자동 생성
- Plaid Link (캐나다 1~2개 은행) + transaction sync (webhook + backfill)
- 카테고리 CRUD + seed
- Manual transaction (UI form + chat)
- Merchant → 카테고리 매핑 학습 (manual confirm 시 매핑 자동 생성)
- Chat thread + messages (text only, blocks schema 만 박아둠)
- Chat agent 기본 tool 5~7개: `addTransaction`, `categorizeTransaction`, `listTransactions`, `setBudget`, `getBudget`, `addScheduledSpend`
- 단순 budget UI

**Exit criteria**: 매일 앱 열어서 트랜잭션 보고, chat 으로 카테고리 정정/예산 변경 가능.

### Phase 2 — The Magic Ritual (3~4주)

**목표**: 핵심 차별점 (daily AI ritual + rich chat UI) 작동.

- Chat blocks 모델 본격 활용 (`categorize_card`, `confirm_card`, `quick_replies` 등)
- RN block renderer 라이브러리
- LLM presentation tools
- Schedule 본격화
- Recurring expenses 등록 + forecasting 반영
- Daily morning ritual: cron + LLM brief + push
- Push notifications + 탭 시 chat thread 열기
- Settings: morning_time, timezone, snooze
- 추가 tool: `getSpendingSummary`, `listScheduledSpend`, `getRecurring`
- Anthropic prompt caching 적용

**Exit criteria**: 매일 아침 푸시 → 미분류 카드 1탭 정리. **이때 family/베타 1~2명 dogfooding 시작.**

### Phase 3 — Advisor 깊어짐 (3~4주)

**목표**: 단순 tracking 에서 advisor 로.

- Historical comparison (`getHistoricalComparison`, 작년 같은 달)
- Plan 생성 / 시나리오 ("이번달 어떻게 살아남지" → LLM 이 schedule 다수 제안 → confirm → 일괄 저장)
- Deviation detection (백엔드가 매일 페이스 계산 → ritual context 주입)
- Anomaly alert (평소 대비 큰 지출 / 처음 보는 머천트)
- 다중 트랜잭션 처리 ("어제 외식 두 건 시장으로 옮겨줘")
- CSV import (백필)
- 영수증 사진 → OCR (LLM vision) → 트랜잭션 후보

**Exit criteria**: Public beta 가능 수준.

### v1 총 기간 추정

10~14주 (한 사람 풀타임 기준)

---

## 11. Out of Scope (v1.5 / v2+)

- Multi-workspace + 초대 + role 권한 (4~6주 작업)
- Email 거래 알림 파싱 (가치 보고 결정)
- Goals (저축 목표, 디버트 페이오프)
- Investments tracking (Plaid Investments)
- Python AI service 분리 (호출량 + 복잡도 임계 넘으면)
- Stripe 결제 / 구독
- Flinks 추가 (Plaid Canada 커버리지 부족할 시)

---

## 12. Open Questions / Risks

1. **Plaid Canada 커버리지**: 사용자 메인 은행이 미지원이면 manual + CSV 로 시작. 사전에 커버 은행 list 확인 필요.
2. **LLM 비용**: Daily ritual + adhoc chat 사용량 monitoring 필요. Prompt caching + sliding window 로 관리하지만, 사용자당 월 cost 가 수익 모델보다 높으면 제한 필요.
3. **Plaid 비용**: Trial 10 Items 무료. 베타 후 pay-as-you-go 전환 시점 결정 필요.
4. **Encryption key 관리**: v1 은 env var 의 master key 로 AES-GCM. 사용자 늘면 rotate / KMS 검토.
5. **Chat agent hallucination**: Tool 호출 잘못된 인자 / 없는 ID 호출 가능. 백엔드가 검증 + LLM 에 friendly error 반환.
6. **Multi-workspace 스키마 가정 검증**: v1 에 single-workspace 만 사용해도 모든 row 에 `workspace_id` 박는 게 정말 미래에 매끄러운지 확인.
7. **"Schedule" 의미 명확화**: 사용자 멘탈 모델 — 이건 budget envelope 가 아니라 calendar event 같은 1회성 예정 지출. UI 카피로 명확히 할 것.

---

## 13. 다음 단계

이 spec 검토 완료 후:
1. Implementation plan 작성 (`writing-plans` skill)
2. Phase 1 부터 task 단위 분해
3. Repo 구조 셋업 + scaffold

---

*Brainstorm 세션: 2026-05-07. User: cwsbrian@gmail.com.*
