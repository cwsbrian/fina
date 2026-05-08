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
      time: Date; suggested_category?: string;
      confirm_intent: string }                              // ← server-issued intent ID
  | { type: "confirm_card"; question: string; accept_label: string;
      reject_label: string;
      accept_intent: string; reject_intent?: string }        // ← intents only, no ToolCall
  | { type: "schedule_form"; defaults?: object;
      submit_intent: string }
  | { type: "budget_edit"; category: string; current: number;
      submit_intent: string }
  | { type: "quick_replies"; options: { label: string; payload: string;
      intent?: string }[] };
```

RN 클라이언트는 각 block type 에 대응하는 컴포넌트 렌더러 보유. LLM 은 presentation tool 호출로 block 들 emit (LLM 이 raw JSON UI 만들 필요 없음).

**예시 morning ritual 출력:**
```json
{
  "role": "assistant",
  "blocks": [
    { "type": "text", "markdown": "어제 사용한 내역 중 확인 받고 싶은 거 있어:" },
    { "type": "categorize_card", "tx_id": "tx_1", "merchant": "Costco",
      "amount": 87, "time": "2026-05-06T21:00", "suggested_category": "시장",
      "confirm_intent": "int_a1b2c3" },
    { "type": "categorize_card", "tx_id": "tx_2", "merchant": "Tim Hortons",
      "amount": 6.50, "time": "2026-05-06T10:30", "suggested_category": "외식/카페",
      "confirm_intent": "int_d4e5f6" },
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
3. **Anthropic prompt caching — 정적인 부분만**:
   - **Cacheable**: system prompt, tool definitions, 사용자의 stable 프로필 (locale, timezone, 카테고리 list 같은 거)
   - **NOT cacheable**: financial context (budget 진행도, 최근 트랜잭션, plan) — 매 호출마다 변하니 cache hit 0%, 차라리 별도 message block 으로 분리해서 cache breakpoint 뒤에 둠
   - 결과: input cost 의 정적 부분만 ~90% 절감, dynamic 부분은 정상 과금. 그래도 system + tools 가 input 토큰의 큰 비중이라 의미 있음.
4. **각 chat session 너무 길게 끌지 않기** — daily ritual 마다 새 thread 시작

### "컨텍스트" 두 종류

- **Conversational context**: 최근 chat 메시지들 (sliding window)
- **Financial context**: 최신 budget, 트랜잭션, plan — 매 호출 직전 DB 에서 빌드해서 system message 로 주입

이 분리가 ChatGPT 와 Fina 의 진짜 차이 — Fina 의 모든 호출은 사용자의 latest 재무 상태를 안 채로 시작.

---

## 8. Data Model

### Entities

```
users (id, email, tz, locale, created_at)
user_devices (id, user_id, push_token, platform: ios/android, last_seen_at)
                                                     ↑ 한 user 가 여러 device 가능
workspaces (id, name, created_at)
memberships (user_id, workspace_id, role, created_at)

plaid_items (id, workspace_id, access_token_encrypted, institution_id,
             institution_name, status: active/error/relink_required,
             error_code?, last_sync_at, last_cursor, created_at)
                                          ↑ /transactions/sync cursor 저장

accounts (id, workspace_id, plaid_item_id?, plaid_account_id?,           ← NEW
          name, official_name?, mask, type: depository/credit/loan/...,
          subtype: checking/savings/credit_card/...,
          currency, status: active/closed/hidden,
          balance_current?, balance_available?, balance_limit?,
          last_balance_sync_at, archived_at?)

transactions (id, workspace_id, account_id, plaid_transaction_id?,
              plaid_pending_transaction_id?, amount, currency,
              merchant_raw, merchant_normalized,
              category_id?, occurred_at, posted_at?,
              pending: bool, source: plaid/manual/csv,
              raw_data jsonb, note,
              UNIQUE(workspace_id, plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL)
                ↑ 사인 컨벤션: amount > 0 = 지출, amount < 0 = 수입/환급 (Plaid 컨벤션 유지)

categories (id, workspace_id, name, parent_id?, icon, color, archived_at?)
merchant_mappings (id, workspace_id, merchant_normalized, category_id,
                   confidence: 0.0~1.0, source: manual/ai/auto, created_at)
budgets (id, workspace_id, category_id, period: monthly/weekly,
         amount, currency, start_date, rollover: bool,
         UNIQUE(workspace_id, category_id, period, start_date))
schedules (id, workspace_id, category_id?, scheduled_date, amount, note,
           status: pending/done/skipped/expired,
           matched_transaction_id?  ← 트랜잭션 발생 시 연결)
recurring_expenses (id, workspace_id, name, amount, category_id, cadence: monthly/weekly/yearly,
                    next_occurrence, last_occurrence?, active)

chat_threads (id, workspace_id, user_id, started_at, type: daily/adhoc, archived_at?)
chat_messages (id, thread_id, role: user/assistant/tool,
               blocks jsonb,           ← schema_version 포함 (UI evolve 시 호환)
               tool_calls jsonb,
               tool_call_id?,
               llm_request_id?, llm_token_usage?,
               created_at)

action_intents (id, workspace_id, user_id, message_id, kind: tool_call,
                payload jsonb,         ← 서버가 만든 서명된 intent.
                expires_at,            ← 클라이언트가 confirm_card accept 시
                consumed_at?,            여기서 lookup 후 실행 (LLM 의 raw
                created_at)              ToolCall 직접 실행 안 함)

audit_events (id, workspace_id, actor_type: user/agent/system, actor_user_id?,
              action, target_type, target_id,
              before jsonb?, after jsonb?,
              chat_message_id?, tool_call_id?, action_intent_id?,
              ip?, user_agent?, created_at)

subscriptions (id, user_id, tier: free/lite/pro,
               source: iap_apple/iap_google/stripe,
               source_subscription_id,        ← Apple original_transaction_id, Stripe sub_xxx
               status: active/grace/canceled/expired,
               current_period_start, current_period_end,
               billing_period: monthly,        ← annual = v1.5+
               cancel_at_period_end: bool,
               created_at, updated_at,
               UNIQUE(source, source_subscription_id))
                 ↑ user 에 attach (workspace 아님). 한 user 가 여러 workspace
                   owner 인 v2 대비. 같은 user 가 IAP+Web 동시 결제 가능 →
                   higher tier 가 effective tier (Section 13 참조).
```

### 주요 디자인 결정

- **`accounts` first-class entity** — Plaid item 1개에 account 여러 개 (예: 같은 은행의 checking + savings + credit). 트랜잭션은 항상 account 에 속함. Manual transaction 도 "Cash" 같은 자동생성 manual account 에 attach.
- **`transactions.category_id` nullable** = uncategorized 가 first-class 상태
- **`merchant_normalized`** = "WALMART #1234 BC" → "Walmart" (백엔드 rule-based 정규화)
- **`amount` sign**: Plaid 컨벤션 따름 — **지출 = 양수, 수입/환급 = 음수**. UI 표기는 절대값 + 색깔로.
- **Currency**: v1 은 **CAD only**. `currency` 컬럼은 박아두지만 mixed-currency aggregation 은 v2.
- **Pending vs posted**: `pending` 부울 + `plaid_pending_transaction_id` 별도 보관. 같은 트랜잭션의 pending 버전이 posted 로 transition 시 새 row 생성하지 않고 update.
- **`raw_data` JSONB** = Plaid 원본 보존, 마이그레이션 없이 새 필드 활용 가능
- **`schedules` vs `recurring_expenses`** 별도 — 1회성 vs 반복. Forecasting 은 둘 다 봄
- **`chat_messages.blocks` JSONB** + 내부 `schema_version` — UI 컴포넌트 evolve 시 옛 메시지 깨지지 않게
- **`action_intents`** = `confirm_card` accept 시 클라이언트가 보낸 raw ToolCall 을 그대로 실행하지 않음. 서버가 발급한 intent ID 만 받아 lookup → 만료/소비 체크 → 실행. (Section "Tool Execution Safety" 참조)
- **`audit_events`** = AI 가 mutate 한 모든 변경의 durable record. before/after, originating tool_call, actor 다 추적. (디버깅 + 감사 + 사용자 신뢰 + privacy review 용)
- **`subscriptions`** = 결제 source-agnostic. 같은 user 가 IAP + Web 양쪽 다 결제 가능 (drift / 마이그레이션). 효과적 tier 는 active subscriptions 중 최상위. 자세한 룰은 Section 13.
- **Plaid 안 쓰는 사용자**: `plaid_items` 0개 + manual account 1개로 작동.

### 주요 indexes

- `transactions(workspace_id, occurred_at DESC)`
- `transactions(workspace_id, category_id)`
- `transactions(workspace_id) WHERE category_id IS NULL`
- `transactions(workspace_id, account_id, occurred_at DESC)`
- `transactions(workspace_id, plaid_transaction_id) UNIQUE WHERE plaid_transaction_id IS NOT NULL`
- `accounts(workspace_id, plaid_item_id)`
- `chat_messages(thread_id, created_at)`
- `action_intents(workspace_id, user_id) WHERE consumed_at IS NULL AND expires_at > now()`
- `audit_events(workspace_id, created_at DESC)`

---

## 9. Plaid Sync Model

Plaid `/transactions/sync` cursor-based 모델 사용. 표준 패턴이지만 잘못 구현하면 financial history 가 망가지니 명세 박아둠.

### 9.1 Item lifecycle

```
사용자가 Plaid Link 시작 (RN 앱)
  ↓
LINK 완료 → public_token 발급 → 백엔드로 전송
  ↓
백엔드: /item/public_token/exchange → access_token 획득
  ↓
백엔드: /item/get + /accounts/get → plaid_items + accounts row 생성
  ↓
초기 backfill: /transactions/sync (커서 없이 시작) → DB 적재
  ↓
백엔드: webhook URL 등록 + plaid_items.last_cursor 저장
```

### 9.2 트랜잭션 sync 로직

매 sync 호출 (webhook 트리거 또는 manual refresh):

```typescript
async function syncTransactions(plaidItemId) {
  let cursor = await db.plaid_items.cursor(plaidItemId);
  while (true) {
    const res = await plaid.transactionsSync({ access_token, cursor });
    await db.transaction(async (tx) => {
      for (const t of res.added)    await upsertTransaction(tx, t, plaidItemId);
      for (const t of res.modified) await updateTransaction(tx, t);
      for (const t of res.removed)  await markRemoved(tx, t.transaction_id);
      await tx.plaid_items.update(plaidItemId, { last_cursor: res.next_cursor });
    });
    cursor = res.next_cursor;
    if (!res.has_more) break;
  }
}
```

### 9.3 핵심 규칙

| 케이스 | 처리 |
|---|---|
| **Pending → posted transition** | Plaid 가 같은 거래에 새 `transaction_id` 부여 + `pending_transaction_id` 로 옛 ID 가리킴. 우리 DB 는 같은 row 를 update (새 row 안 만듦). `plaid_pending_transaction_id` 로 lookup. |
| **중복 방지** | `UNIQUE(workspace_id, plaid_transaction_id)`. 같은 webhook retry 들어와도 race 없음 (upsert). |
| **Webhook idempotency** | Webhook payload 의 `webhook_code` + `item_id` + 시간 윈도우 기반 dedupe. 처리된 webhook ID 는 별도 테이블 (또는 audit_events) 에 1주일 남김. |
| **Item error / re-auth** | `ITEM_LOGIN_REQUIRED` 등 → `plaid_items.status = relink_required`. UI 에 배너 + chat 으로 통지. |
| **Account 폐쇄** | `/accounts/get` 응답에서 사라진 account → `accounts.status = closed`. 트랜잭션 archive 안 함 (history 보존). |
| **Removed transaction** | Plaid 에서 삭제된 거래 (취소된 결제 등) → 우리 DB row 도 soft delete (`removed_at` 또는 `archived_at`). 하드 delete 금지. |
| **Backfill 범위** | Plaid 무료 default 24개월. v1 은 그 한도 그대로 사용. |
| **Manual transaction 의 account** | 사용자당 자동 생성되는 "Cash" account 1개에 default attach. 사용자가 옮길 수 있음. |

### 9.4 Webhook security

- Plaid webhook signature verification (`plaid-verification` header) 필수
- 백엔드 endpoint 는 idempotent + 빠르게 200 응답 (실제 sync 는 background job 으로 enqueue)
- Webhook 받자마자 audit_events 에 기록

### 9.5 Cron-driven 보강

Webhook 누락 / 지연 대비:
- 하루 1회 (daily ritual 직전 또는 별도 시각) 모든 active plaid_items 에 대해 sync 강제 실행
- `last_sync_at` 이 24h 넘은 item 은 cron 이 우선 처리

---

## 10. Authorization & Service Layer Rules

V1 은 single-workspace 만 사용해도 multi-workspace 를 가정한 인가 (authorization) 패턴을 service layer 에 박는다. 안 박으면 v2 multi-workspace 추가 시 risky.

### 10.1 Hard rules (모든 코드 적용)

1. **모든 API request 는 인증된 user_id + 명시된 workspace_id 컨텍스트로 들어와야 한다.** Header / path param / JWT claim 어디든 OK 지만 절대 query string 에 평문으로 두지 않음.
2. **모든 DB 쿼리는 `workspace_id` 로 scope.** Prisma middleware 또는 repository 패턴으로 강제 — raw query 도 review 필수.
3. **요청 처리 진입 시 membership 체크.** `assertMembership(user_id, workspace_id, required_role)` 가 모든 핸들러의 첫 줄. 빠지면 lint/CI 에서 잡히게.
4. **Plaid item / access_token 은 절대 cross-workspace 노출 금지.** Plaid 호출 함수는 `(workspace_id, plaid_item_id)` 두 인자 모두 받고 내부에서 ownership 검증.
5. **Background job / cron 도 workspace 컨텍스트 명시.** Job payload 에 `workspace_id` + `triggered_by` (user/system) 들어가야 enqueue 가능.
6. **Tool execution 도 workspace scope.** Chat agent 의 tool 핸들러는 `(ctx: { user_id, workspace_id, role }, args)` 시그니처. ctx 없이 실행 불가.
7. **Role 종류 v1**: `owner` 만 (사용자가 자기 workspace 의 owner). v2 에 editor/viewer 추가 시 코드 변경은 role 체크 string 만.

### 10.2 V1 에서의 단순화

- 사용자당 1 workspace, owner 1명
- 초대 / role transition / kick 기능 없음
- 하지만 위 6 규칙은 처음부터 적용 — 미래 자유

### 10.3 Tenant isolation 검증

- 단위 테스트: "user A 가 workspace B 의 트랜잭션 쿼리하면 0건 나오는지"
- E2E 테스트: cross-workspace 접근 시도 → 403
- 모든 새 service 함수 PR review 시 workspace scope 체크가 PR template 에 포함

---

## 11. Tool Execution Safety

Chat agent 가 mutate 가능하기 때문에 LLM 의 hallucination + 클라이언트 변조 + replay 모두 막아야 함.

### 11.1 Confirmation flow (`confirm_card` 의 안전 모델)

문제: `confirm_card` 가 `on_accept: ToolCall` JSON 을 들고 다니면, 클라이언트나 DB 가 변조되었을 때 백엔드가 임의 ToolCall 을 실행해버릴 수 있음 (confused-deputy / replay).

해결: **서버 발급 intent ID 만 사용.** Raw ToolCall 은 클라이언트 → 서버 경로에 절대 등장 안 함.

```
1. LLM 이 `presentConfirmCard({ question, accept_action: ToolCall })` 호출
   ↓
2. 백엔드: action_intents 테이블에 row 생성
   { id: uuid, payload: ToolCall, expires_at: now + 1시간 }
   ↓
3. Block 으로 클라이언트에 보내는 건 intent_id 만:
   { type: "confirm_card", question, accept_intent: "int_abc...",
     reject_intent: "int_xyz..." }
   ↓
4. 사용자가 ✓ 누름 → 클라이언트가 백엔드에 POST /intents/int_abc/consume
   ↓
5. 백엔드: intent lookup → 만료 확인 → workspace 일치 확인 →
   consumed_at 마킹 → payload.ToolCall 실행 → audit_events 기록
```

같은 패턴이 다른 인터랙티브 카드에도 적용:
- `categorize_card.confirm_intent` (suggested_category 그대로 confirm)
- `schedule_form.submit_intent` (form 데이터로 schedule 추가)
- `budget_edit.submit_intent`

### 11.2 LLM-emitted tool 호출의 격리

| 안전 장치 | 설명 |
|---|---|
| **Tool whitelist** | LLM 이 호출 가능한 함수는 정의된 목록만. 함수 이름 매칭 strict. |
| **Args schema 검증** | JSON Schema (provider 의 strict mode) + 백엔드에서 한 번 더 zod/io-ts 검증. |
| **Workspace scope 강제** | Tool 핸들러 시그니처에 `ctx` 필수 (Section 10) |
| **Destructive op = confirm 강제** | 다음 op 는 직접 실행 금지, 무조건 `presentConfirmCard` 거침: 트랜잭션 삭제, 카테고리 삭제, plaid_item 연결 해제, workspace 삭제, bulk recategorize, budget 큰 변경 (>30%) |
| **Bulk 작업 제한** | 한 turn 안에서 한 tool 의 호출 횟수 제한 (예: `categorizeTransaction` 50회 / turn). 초과 시 백엔드 reject + LLM 한테 "bulk 는 confirm 거쳐" 안내. |
| **Idempotency** | Mutate tool 마다 `idempotency_key` 옵션 (같은 chat turn 안에서 재시도 시 중복 실행 안 됨). |
| **Audit log** | 모든 tool 실행 → audit_events row. before/after, tool_call_id, llm_request_id 함께. |

### 11.3 Rate limit / loop 보호

- Chat 한 turn 안에서 LLM 호출 최대 N회 (default 10) 후 강제 종료
- 사용자당 일일 LLM 토큰 / 호출 quota (남용 방지)
- Tool loop infinite 가능성 → max iterations + timeout

---

## 12. Privacy & Data Handling

Financial data + LLM API 흐름의 기본 원칙 + 캐나다 PIPEDA 대응.

### 12.1 어떤 데이터가 외부 (LLM provider) 로 가는가

| 데이터 | LLM 으로 보냄? | 비고 |
|---|---|---|
| 사용자 email / 본명 | ❌ | 내부 user_id (UUID) 로 referent |
| Account 번호 / mask 의 비표시 부분 | ❌ | 절대 |
| Plaid access_token | ❌ | 백엔드 only |
| Merchant 정규화 이름 | ✅ | "Walmart" 같은 정규화 결과 |
| Merchant raw 이름 | ✅ (redact 후) | 전화번호/주소 strip |
| 금액, 날짜, 카테고리 | ✅ | core context |
| 예산 / 스케줄 / 구독 | ✅ | core context |
| 사용자가 chat 에 직접 입력한 텍스트 | ✅ | 본인 의지 |
| 다른 user / workspace 데이터 | ❌ | tenant isolation |
| IP / device info | ❌ | 불필요 |

### 12.2 PII redaction 레이어

모든 LLM 호출 직전 거치는 함수:

```typescript
function redactForLLM(s: string): string {
  return s
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "[PHONE]")
    .replace(/\b\d{13,19}\b/g, "[ACCOUNT_NUM]")          // PAN-ish
    .replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g, "[POSTAL]") // CA postal
    .replace(/\b\d{9}\b/g, "[SIN_LIKE]");                  // SIN-shaped
}
```

Merchant raw, note, chat user input 모두 통과. Sentry/log 도 동일 redaction 적용.

### 12.3 Aggregation-first

가능한 한 raw 트랜잭션 list 보다 집계 (카테고리별 합계, 페이스, plan 진행도) 를 system context 로 보냄. Raw 가 필요한 경우만 tool 호출로 가져오게 LLM 에 가이드.

### 12.4 Provider 설정

- **Anthropic Claude API**: training-에-안-쓰임 default. 30일 abuse retention. 베타 진입 시 ZDR (Zero Data Retention) + DPA 신청.
- **OpenAI**: 동일 정책 (2023.03 이후 default no-training). 베타 시 ZDR.
- API key 는 server-side only. 클라이언트에 절대 노출 X.

### 12.5 사용자 동의 / privacy policy

- Onboarding 에 명시 동의: "Fina 는 너의 financial data 일부 (금액, 카테고리, 머천트, 채팅 내용) 를 AI 분석을 위해 Anthropic / OpenAI 에 보냅니다. 이 데이터는 모델 훈련에 사용되지 않으며 30일 후 삭제됩니다."
- Settings → "AI 처리 일시 중지" 토글 (chat / daily ritual 만 비활성, 나머지 가계부 기능 유지)
- Privacy Policy 문서 별도 (legal 검토 권장)

### 12.6 PIPEDA 대응 (캐나다)

- **Right to access**: `/me/export` API — 사용자의 전체 데이터 JSON 다운로드 (자기 workspace 의 모든 row)
- **Right to deletion**: `/me/delete` API — workspace 전체 + memberships + audit + chat threads 삭제. 30일 grace period 후 hard delete.
- **Right to correction**: 평소 UI/chat 으로 가능
- **Breach notification**: 사고 발생 시 Privacy Commissioner 신고 의무 — incident response runbook 마련 필수
- **Privacy Officer**: v1 은 Brian 본인. 이메일 공개 (`privacy@fina.app` 같은 거)

### 12.7 Audit log + 사용자 가시성

- `audit_events` 가 모든 mutation 기록 (Section 8)
- v1.5+ : 사용자가 "내 데이터 어떻게 쓰였는지" 화면 — audit_events 의 사용자 friendly view
- Tool 실행, LLM 호출, Plaid sync 모두 audit

### 12.8 V1 단순화 / V2+ 강화

| 항목 | V1 | V2+ |
|---|---|---|
| LLM 데이터 흐름 | Default API (no training) | ZDR + Enterprise + DPA |
| Encryption at-rest | App-level AES-GCM, key in env | KMS (AWS/GCP) |
| Audit user visibility | DB 만, admin 직접 쿼리 | UI dashboard |
| Privacy export/delete | API only | Settings UI buttons |
| 보안 감사 | Self review | 외부 pentest |

---

## 13. Pricing & Billing

비즈니스 모델: **Freemium + Hybrid IAP/Web subscription**. 가계부는 무료, advisor (chat + ritual + 깊은 분석) 가 paid.

### 13.1 Tier 구조

| Tier | Web / IAP | 대상 | 핵심 가치 |
|---|---|---|---|
| **Free** | $0 | 가계부 사용자 | Mint 후계자 — 자동 분류 + 예산 + 요약 |
| **Lite** | **$8 / $9.99** | Advisor 입문 | 제한된 advisor + Daily ritual |
| **Pro** | **$14 / $17.99** | Power 사용자 | 무제한 advisor + 깊은 분석 |
| Family | TBD | 가족 공유 | 4 멤버 워크스페이스 (v1.5+) |

### 13.2 Free tier 스코프

가계부 핵심 기능 전체 무료:
- Bank account 1개 (Plaid Item 1)
- 무제한 트랜잭션 + 자동 분류 + 머천트 매핑 학습
- 카테고리 + 예산 + 스케줄 + recurring
- Daily summary push (텍스트 only, cheap model 짧은 요약)
- 채팅 10 msg/월 (cheap model, conversion funnel 용 맛보기)
- CSV 내보내기

**의도**: Mint 가 죽고 빈자리 채우는 포지션. Free 가 진짜 쓸 만해야 conversion funnel 작동 + 입소문 양산.

### 13.3 Lite tier ($8 web / $9.99 IAP)

- Bank accounts 2개
- 채팅 200 msg/월 (cheap default + Sonnet escalation pool 월 20회)
- Daily morning ritual 전체 (rich blocks: categorize_card, confirm_card 등)
- 챗으로 트랜잭션 / 카테고리 / 예산 변경

### 13.4 Pro tier ($14 web / $17.99 IAP)

Lite + **Pro-only 기능들** (이 기능들이 frontier model 을 정당화):

- 채팅 1000 msg/월 + Sonnet 무제한 escalation
- **Plan generation**: 다년 / 다목표 시나리오 ("3년 안에 집", "빚 갚기 plan")
- **Deep audit mode**: "지난 N개월 어디서 새고 있어?" 다량 트랜잭션 reasoning
- **Proactive monitoring**: 비정상 패턴 자동 감지 + push (백엔드 agent daily 백그라운드 분석)
- **Goal tracking**: 목표 등록 + 주간 진척도 자동 분석
- **Receipt OCR** (vision)
- Bank accounts 무제한
- CSV 대량 import
- Historical comparison 깊은 버전 (작년 같은 달 + 트렌드)

**원칙**: "Pro 는 더 똑똑한 모델" 으로 팔지 말고, **"Pro 는 이런 일들을 가능하게 해줘"** 로 팔기. Frontier model 은 그 수단.

### 13.5 Distribution — Hybrid IAP + Web

| 경로 | 가격 | Net | 비중 |
|---|---|---|---|
| **IAP** (Apple/Google) | $9.99 / $17.99 | $8.49 / $15.29 (Apple SBP 15%) | Primary (App Store funnel) |
| **Web** (Stripe) | $8 / $14 | $7.47 / $13.30 (Stripe 2.9%+$0.30) | Anchor pricing + power user 채널 |

**Note**: Web 이 IAP 보다 절대 마진은 살짝 낮음 (Stripe $0.30 fixed fee 가 small transaction 에서 큰 비율). Web 의 진짜 가치는 **marketing anchor** (ChatGPT Plus $20 비교용, YNAB $15 대비 매력) + **power user retention** (sticky 채널).

### 13.6 Apple App Store 컴플라이언스 (Reader app 패턴)

**앱 안에서 허용**:
- IAP 결제 ($9.99 / $17.99)
- "이미 계정 있으세요? 로그인" — Web 가입자 sign-in
- Apple subscription manage 링크

**앱 안에서 금지** (default — 캐나다 + 미국):
- 웹 가격 표시 ($8, $14)
- 웹 결제 페이지 링크
- "웹에서 더 싸요" 류 hint

**미국 only** (2025 Epic v. Apple 판결 후) — External Link Account entitlement 신청 시 외부 결제 링크 1개 허용 + Apple 수수료 0% (현재, 항소 변동 가능). **v1.5+ 검토** — 즉시 도입 시 정책 risk.

**v1 운영**: 앱 = IAP UI only, Web 가입자는 sign-in 만. 마찰 받아들이고 정책 risk 0. Spotify / Netflix / Notion 패턴.

### 13.7 Subscription state — multi-source 룰

`subscriptions` 테이블은 user 에 attach (workspace 아님 — Section 8). 한 user 에게 동시에 여러 source 의 active subscription 가능 (IAP + Web 동시 결제, 또는 마이그레이션 중).

**Effective tier 결정 룰**:
1. Active subscriptions 중 **higher tier 가 effective tier** (Pro > Lite > Free)
2. 같은 tier 동시 결제 → 사용자에게 안내 + lower-cost (web) 유지 권장
3. 한 source 의 cancel/expire 후 다른 source 만 남으면 자동 전환

**Receipt 검증 endpoints (3종)**:
- `POST /billing/apple/verify` — Apple `original_transaction_id` 기반, App Store Server API
- `POST /billing/google/verify` — Google Play Developer API
- `POST /webhooks/stripe` — Stripe webhook (signature 검증 필수)

각 endpoint 는 idempotent + audit_events 기록. Subscription state 변경은 무조건 server-side 검증 거침 (클라이언트 self-reported 절대 신뢰 안 함).

### 13.8 Per-user economics (월 가정)

| Tier | 결제 net | LLM | Plaid | 인프라 | 마진 |
|---|---|---|---|---|---|
| Free | $0 | $0.05 | $0.30 | $0.20 | -$0.55 (funnel cost) |
| Lite IAP $8.49 | $8.49 | $3 | $0.60 | $0.50 | **~$4.4** |
| Lite Web $7.47 | $7.47 | $3 | $0.60 | $0.50 | **~$3.4** |
| Pro IAP $15.29 | $15.29 | $7 | $1.20 | $0.80 | **~$6.3** |
| Pro Web $13.30 | $13.30 | $7 | $1.20 | $0.80 | **~$4.3** |

**가정**:
- Cheap default LLM (4o-mini 또는 Gemini Flash) — 4o-mini per-turn ~$0.0018, Flash ~$0.0009
- Routing: 70% cheap / 30% Sonnet escalation
- Aggressive prompt caching (system + tools cached, financial context fresh)
- Plaid pay-as-you-go transactions product (~$0.30/Item/월)
- 인프라 = Postgres + hosting + push + Sentry 등 amortized

**Quota guardrails**:
- Lite 200 msg/월 hard cap → 도달 시 cheap-only 다운그레이드 (advisor 못 쓰는 게 아니라 escalation 멈춤)
- Pro Sonnet escalation 무제한이지만 **per-query cost cap** (단일 advisor 호출 최대 N개 round-trip + 토큰 한도)
- Free 10 msg 도달 시 hard stop + Lite 업그레이드 prompt

### 13.9 단계화

| 항목 | V1 dogfood | V1 public | V1.5+ |
|---|---|---|---|
| 결제 구현 | ❌ (Brian + 가족 무료) | ✅ Stripe + IAP 둘 다 | Apple/Google receipt 검증 자동화 |
| Tier UI gating | DB 컬럼만 | feature-level | per-feature 세밀 |
| Annual 결제 | ❌ | ❌ | ✅ ($80/년 web, $99/년 IAP) |
| Family | ❌ | ❌ | ✅ |
| US External Link entitlement | ❌ | TBD | Optional |

**V1 dogfood 기간 동안**: 모든 사용자 = 자동 Pro (DB seed). 결제 구현은 v1 public 직전 phase 에서 한 번에. 단, schema 는 처음부터 박아둠 (Section 8).

### 13.10 Open issues (Pricing 관련)

- Free tier 채팅 10 msg 가 맛보기로 충분한지 / 너무 적은지 dogfooding 검증
- Pro 의 deep audit / plan gen 도구가 Sonnet 다회 round-trip 시 단일 query $0.20+ 가능 — per-query quota 설계 필요
- Family $20 가 매력적인지 vs 개별 Lite × 4 = $32 비교 검증
- Annual 가격 ($80/년 web, $99/년 IAP) elasticity 검증
- Web 가입 funnel 에서 IAP 로의 cannibalization 측정 (IAP 마진 더 높음)

---

## 14. Tech Stack

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

## 15. MVP Roadmap

> **Note**: 원래 Phase 1 (4~6주) 로 묶었으나 codex review 가 over-scope 지적 — Plaid sync 정확성 + auth + chat tool loop 만 해도 그 시간 다 먹음. **Phase 1 을 1A/1B/1C 로 나눔**.

### Phase 1A — Foundations (2~3주)

**목표**: Auth, workspace, manual entry 로 텍스트 채팅까지 동작.

- Monorepo scaffold (pnpm + Turborepo)
- Expo 앱 + Node API (Fastify) + Postgres + Prisma
- Clerk 로그인 (이메일 + Google) + Workspace 자동 생성
- Service layer authorization 패턴 (Section 10) 박기 — middleware + assertMembership
- 카테고리 CRUD + seed (시장, 외식, 교통, 구독, 기타...)
- Manual account 자동 생성 ("Cash") + manual transaction (UI form)
- 단순 budget UI (CRUD)
- Chat thread + messages (text only blocks, intent layer 미구현 OK)
- Chat agent 최소 tool 5개 (read-only first): `listTransactions`, `getBudget`, `getUncategorizedTransactions`, `listCategories`, `getSpendingSummary`
- Audit events 테이블 + 기본 logging
- LLM redaction layer 기본 구현

**Exit criteria**: 본인이 manual 트랜잭션 입력하고, chat 으로 query 가능. Tool 은 read-only 만.

### Phase 1B — Plaid + Account Model (2~3주)

**목표**: 자동 트랜잭션 + 카테고라이저.

- Plaid Link (캐나다 1~2개 은행) + access_token 암호화 저장
- `accounts` entity 본격화 (Plaid item → accounts → transactions)
- `/transactions/sync` cursor 기반 sync (Section 9)
- Webhook handler + idempotency + signature 검증
- Pending → posted transition, removed transactions 처리
- Item error / re-auth 플로우
- Merchant 정규화 + AI suggestion (LLM 한 번 호출로 여러 미분류 트랜잭션 카테고리 제안)
- Merchant → 카테고리 매핑 학습 (manual confirm 시 자동 생성)
- Daily cron 보강 sync (last_sync_at > 24h)

**Exit criteria**: Plaid 연결한 은행 트랜잭션이 자동 import 되고 대부분 자동 카테고리 분류.

### Phase 1C — Agent Writes + Confirmation (2~3주)

**목표**: Chat 이 mutate 가능 + 안전한 confirmation flow.

- Chat tool write 권한 추가: `addTransaction`, `categorizeTransaction`, `setBudget`, `addScheduledSpend`, `mapMerchantToCategory`
- `action_intents` 테이블 + intent issue/consume API
- Block 모델 v1: `text`, `categorize_card`, `confirm_card` (intent 기반)
- RN block renderer (3개 컴포넌트)
- Bulk 작업 제한 + destructive op confirm 강제
- Tool execution audit (모든 mutate → audit_events row)

**Exit criteria**: Chat 으로 트랜잭션 카테고리/예산 변경 가능 (confirm 거치는 destructive 포함). 본인 dogfooding 안정.

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

| Phase | 기간 |
|---|---|
| 1A — Foundations | 2~3주 |
| 1B — Plaid + Account Model | 2~3주 |
| 1C — Agent Writes + Confirmation | 2~3주 |
| 2 — Magic Ritual | 3~4주 |
| 3 — Advisor 깊어짐 | 3~4주 |
| **총 v1** | **12~17주** (3~4개월) |

한 사람 풀타임 기준. 파트타임이면 비례.

---

## 16. Out of Scope (v1.5 / v2+)

- Multi-workspace + 초대 + role 권한 (4~6주 작업)
- Email 거래 알림 파싱 (가치 보고 결정)
- Goals (저축 목표, 디버트 페이오프) — Pro tier 의 일부로 v1 후반 도입 검토
- Investments tracking (Plaid Investments)
- Python AI service 분리 (호출량 + 복잡도 임계 넘으면)
- Annual 결제 + Family tier (Section 13 참조)
- US External Link Account entitlement (Section 13.6)
- Flinks 추가 (Plaid Canada 커버리지 부족할 시)

---

## 17. Open Questions / Risks

1. **Plaid Canada 커버리지**: 사용자 메인 은행이 미지원이면 manual + CSV 로 시작. 사전에 커버 은행 list 확인 필요.
2. **LLM 비용**: Daily ritual + adhoc chat 사용량 monitoring 필요. Prompt caching + sliding window + aggregation-first 로 관리하지만, 사용자당 월 cost 가 수익 모델보다 높으면 quota 강제.
3. **Plaid 비용**: Trial 10 Items 무료. 베타 후 pay-as-you-go 전환 시점 결정 필요.
4. **Encryption key rotation**: v1 은 env var master key. 사용자 늘면 KMS 마이그레이션 필요 — 마이그레이션 절차 미리 설계 (re-encrypt 전략).
5. **Chat agent hallucination**: Tool 호출 잘못된 인자 / 없는 ID 호출 가능. 백엔드가 검증 + LLM 에 friendly error 반환. Section 11 의 confirm/intent 모델로 destructive 영향 차단.
6. **Categorization quality**: AI 카테고리 제안 정확도 측정 + drift 모니터링. Merchant mapping 학습률 추적.
7. **"Schedule" 의미 명확화**: 사용자 멘탈 모델 — 이건 budget envelope 가 아니라 calendar event 같은 1회성 예정 지출. UI 카피로 명확히 할 것.
8. **Push 미수신 fallback**: 푸시 실패 / 사용자가 비활성 시 in-app 배지 + email digest 옵션 (v1.5).
9. **Daily ritual idempotency**: 같은 날짜에 두 번 트리거되어도 중복 메시지 안 나가게 — `daily_briefs(workspace_id, date) UNIQUE` 또는 audit 기반 dedupe.
10. **Multi-currency 트랜잭션**: 캐나다 사용자가 USD 카드도 가짐 (해외 결제). v1 은 "환산해서 CAD 로 보고" or "그대로 표기 + 환산 안 함" 둘 중 결정 필요.
11. **PIPEDA 컨플라이언스 검토**: 베타 직전 변호사 검토. Privacy policy / ToS 초안 마련.

---

## 18. 다음 단계

이 spec 검토 완료 후:
1. Implementation plan 작성 (`writing-plans` skill)
2. Phase 1 부터 task 단위 분해
3. Repo 구조 셋업 + scaffold

---

*Brainstorm 세션: 2026-05-07. User: cwsbrian@gmail.com.*
