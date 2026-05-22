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

### Surface 모델 (mobile-first, web entry-only)

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
              ┌────────────┴───────────────────┐
              ▼                                ▼
   ┌─────────────────────┐          ┌──────────────────────┐
   │  React Native       │          │   Next.js Web        │
   │  Mobile (MAIN)      │          │   Entry surface      │
   │  Daily UX:          │          │   Landing / sign-up  │
   │  chat, ritual,      │          │   Stripe billing     │
   │  push, browse,      │          │   Invite accept      │
   │  Plaid Link         │          │   Workspace/account  │
   │                     │          │   settings           │
   └─────────────────────┘          └──────────────────────┘
```

### Surface 역할 (mobile = main, web = entry-only)

| Surface | 역할 | v1 에 들어가는 것 | v1 에 안 들어가는 것 |
|---|---|---|---|
| **Mobile (React Native)** | Main daily UX. 사용자가 매일 여는 곳. | Chat, daily ritual, push, transactions browse/categorize, Plaid Link, settings | — |
| **Web (Next.js)** | Entry surface. 자주 안 여는 셀프서비스. | Landing/marketing, sign-up + sign-in, Stripe billing (Reader app), invite accept page, workspace/account settings | **Chat / transactions / ritual UI 없음** (v2+ 검토) |

Web 이 살아있는 이유 (셋 다 mobile-only 로는 구조적으로 곤란):

1. **Stripe 결제 채널 유지** — Reader app 패턴으로 Apple IAP 15% 우회 가능 (§13.7-8). Web sign-up funnel 이 죽으면 IAP 100% 가 강제됨.
2. **Marketing / SEO funnel** — App Store 만으로는 organic discovery 부족.
3. **Invite accept landing** — 받는 사람이 앱 설치 없이 가입+수락 가능. Mobile-only 면 invitee 도 앱 설치 강제 → conversion 손실.

이 외엔 web 에 기능 추가 안 함 — 새 daily UX 가 생기면 mobile 에 만들고 끝.

### 핵심 원칙

1. **DB 가 single source of truth.** UI 든 Chat 이든 결국 DB 를 read/write. 두 surface 사이 동기화 따로 안 함.
2. **Mobile-first build order.** Daily UX 는 mobile 에서 만든다. 두 surface 다 필요한 기능 (sharing, switcher 등) 은 web 에서 먼저 굳히고 mobile 이 mirror — web 의 빠른 iterate 사이클로 UX 결정 빨리 검증, 그 다음 mobile 이 결정된 UX 를 native 로 구현.
3. **Chat agent = LLM + tools.** Chat 에서 명령하면 LLM 이 tool 호출 → 백엔드가 실행 → DB 업데이트 → UI 에도 즉시 반영.
4. **Cron 은 단 하나 — daily morning ritual.** 다른 알림은 transaction sync 시점이나 daily ritual 안에서 처리.
5. **Plaid sync 는 backend 가 주관.** Webhook + 초기 backfill. Categorization 은 merchant 매핑 → AI suggest → uncategorized 순.
6. **Python AI service 분리는 v2+.** 처음엔 Node 모놀리스로 속도 우선. 인터페이스를 깔끔히 두면 나중 분리 쉬움.

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

### 2026-05-21 — Implementation note (Plan 2B)

The implementation in [Plan 2B-daily-brief](2026-05-21-plan-2b-daily-brief-design.md) deviates from §6 in two ways:

1. **Always emit a message** (no "별 거 없으면 skip" rule). LLM cost is ~$0.0006 per user per day; ritual value of a consistent daily message outweighs the noise risk.
2. **Three brief types** (daily / weekly / monthly), highest cadence wins on collision days. The single "daily ritual" expanded into a cadence-aware system that adjusts context window and tone per type.

See the 2B spec §11 for the full rationale.

---

## 7. Conversation Context 관리

### LLM 은 stateless

매 호출마다 messages 배열 전체를 다시 보내야 함. 백엔드가 책임.

### 패턴

1. **DB 에 모든 메시지 누적 저장** (`chat_messages` 테이블)
2. **호출 시 sliding window** — 최근 20~30 메시지만 LLM 한테
3. **Gemini context caching — 정적인 부분만**:
   - **Cacheable**: system prompt, tool definitions, 사용자의 stable 프로필 (locale, timezone, 카테고리 list 같은 거)
   - **NOT cacheable**: financial context (budget 진행도, 최근 트랜잭션, plan) — 매 호출마다 변하니 cache hit 0%, 차라리 별도 message block 으로 분리해서 cache breakpoint 뒤에 둠
   - Gemini 의 implicit + explicit caching 활용. system + tools 가 input 토큰의 큰 비중이라 의미 있음.
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

- **Google Gemini API (paid tier)**: training-에-안-쓰임 default. 데이터 유럽/미국 region 선택 가능. 베타 진입 시 DPA + Vertex AI Enterprise 옵션 검토 (data residency + ZDR-equivalent).
- API key 는 server-side only. 클라이언트에 절대 노출 X.

### 12.5 사용자 동의 / privacy policy

- Onboarding 에 명시 동의: "Fina 는 너의 financial data 일부 (금액, 카테고리, 머천트, 채팅 내용) 를 AI 분석을 위해 Google Gemini API 에 보냅니다. 이 데이터는 모델 훈련에 사용되지 않으며 Google 에 retention 되지 않습니다 (paid tier 정책)."
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

비즈니스 모델: **Freemium + per-user paid subscription** (IAP + Web). 핵심 gating axes:

1. **Bank 자동 import (Plaid)** — Free 는 manual/CSV 만, Lite 1개, Pro 무제한
2. **AI 기능** — Free 없음, Lite "AI 가 말 거는 구조" (read-only), Pro 풀 양방향 chat
3. **Workspace sharing** — **Free 부터 무료** (multi-workspace + invite + role)

### 13.1 Tier 구조

| Tier | 가격 (CAD) | Plaid | AI | Workspace Sharing |
|---|---|---|---|---|
| **Free** | $0 | ❌ (manual + CSV only) | ❌ | ✅ owner / editor / viewer + invite |
| **Lite** | **$7/월** | 1개 | "AI 가 말 거는" daily ritual + categorize_card 응답만 (free-form input X) | ✅ |
| **Pro** | **$15/월** | 무제한 | 풀 양방향 chat (plan generation, deep audit, anomaly alert 등 포함) | ✅ |
| Family | — (v1.5+) | — | — | (현재 Free 의 sharing 으로 가족이 한 워크스페이스 공유 가능) |

**가격 세부**: $7 / $15 는 web 헤드라인 (CAD). IAP 는 Apple/Google 의 가장 가까운 price tier (대략 $6.99 / $14.99 CAD) 적용. Annual 은 v1.5+.

### 13.2 Free tier 스코프

**의도**: 시장 진입 hook. Sharing 이 핵심 — 가족/친구 그룹 분담 정산 같은 use case 를 cover 해서 입소문/뱀파이어 효과.

- Manual transaction 입력 (UI form + 미래 chat 입력 — Pro 만 가능)
- CSV import / export
- 카테고리 + 예산 + 스케줄 + recurring expenses
- **Workspace sharing**: 무제한 invite, role (owner / editor / viewer)
- Daily summary push (앱 자체 생성, LLM 호출 0 — 단순 stats: "어제 X달러 썼어, 이번 주 예산 Y% 사용")
- Category 자동 매핑 (heuristic only, LLM 호출 X)

**Free 에 없음**: Plaid 자동 import, AI 채팅, AI 카테고리 제안, AI ritual, OCR, plan generation, deep audit.

### 13.3 Lite tier ($7/월 CAD)

Free + **자동 import + AI ritual (read-only mode)**:

- Plaid Link 1개 — 1개 은행/카드 자동 sync
- **Daily AI ritual**: 매일 아침 morning brief push (Section 6)
  - AI 가 categorize_card 들 + text 로 메시지 emit
  - 사용자는 카드 탭으로 카테고리 confirm / 변경 가능
  - **Free-form chat input 비활성화** (UI 레벨 gating)
- AI categorize suggestion (uncategorized 트랜잭션 자동 제안)
- Anomaly alert 푸시 (간단한 룰 + Flash 분석)

**Lite UX 핵심**: 사용자는 chat 화면을 가지고 있지만 input bar 는 잠겨있음. AI 가 일방향으로 정보 + 카드 보내고 사용자는 카드 탭으로만 응답. "내가 일 안 하고도 가계부가 굴러가는" 자동화 가치.

### 13.4 Pro tier ($15/월 CAD)

Lite + **풀 양방향 advisor**:

- Plaid 무제한 (모든 은행/카드)
- **Free-form chat input 활성화** — 사용자가 자유롭게 질문/명령 가능
  - "이번 달 외식 줄이려는데 plan 짜줘"
  - "지난 6개월 어디서 새고 있어?"
  - "Walmart 트랜잭션 다 시장 카테고리로 옮겨줘"
- **Plan generation**: 다년/다목표 시나리오 ("3년 안에 집", "빚 갚기 plan")
- **Deep audit mode**: 다량 트랜잭션 reasoning (chunked analysis + structured prompt 으로 Flash-Lite 에서 처리)
- **Proactive monitoring**: 비정상 패턴 자동 감지 + push (background agent daily)
- **Goal tracking**: 목표 등록 + 주간 진척도
- **Receipt OCR** (vision)
- Historical comparison 깊은 버전 (작년 같은 달 + 트렌드)

**판매 메시지**: "Pro 는 더 똑똑한 모델" 이 아니라 **"Pro 는 이런 일들을 chat 으로 가능"**.

### 13.5 30일 Pro Trial

가입 시 자동 적용:
- 30일간 Pro 모든 기능 unlock
- **Card upfront 불필요** (가입 → 즉시 사용)
- 만료 시 **Free 로 자동 다운그레이드** (Plaid 연결은 read-only 잠김, AI 잠김, 데이터 + workspace sharing 그대로 보존)
- **계정당 1회** (clerkId/email 기준 dedupe)
- DB: `users.trial_started_at`, `users.trial_ended_at`, `users.trial_consumed: bool`

만료 5일 전 push + 만료 당일 in-app 배너로 upgrade prompt. 압박 안 하지만 가시성 확보.

### 13.6 Mixed-tier workspaces

Subscription 이 per-user 라서 한 workspace 에 다른 tier 멤버 동시 가능. 룰:

- **Plaid items 는 linker 의 tier 가 결정.** Lite 사용자는 자신이 그 workspace 에서 1개까지 link 가능. Pro 는 무제한. Free 는 0 (link 자체 못 함).
- **AI 기능은 actor 의 tier 가 결정.** Pro 가 owner 인 workspace 에 Free 사용자가 있으면, Free 사용자에게는 AI input bar 비활성. Pro 는 그대로 활성.
- **데이터 view + 편집권**: 모든 멤버가 자기 role 에 따라 동일 (편집/보기). Tier 와 무관.
- **Daily ritual**: 각 사용자가 자기 timezone + 자기 tier 의 ritual 받음. Pro 는 풀 ritual, Lite 는 read-only ritual, Free 는 단순 stats summary.

이 모델의 의미: 한 명만 Pro 결제해도 workspace 의 Plaid+AI 자동화 효과를 누리고, 같이 보는 가족은 무료로 view+edit. **자연스러운 viral loop**: 가족 한 명이 Pro 결제 → 다른 멤버 free 가입 + sharing → 그 중 일부가 자기도 Pro 로 업글 (자기 chat 쓰려고).

### 13.7 Distribution — IAP + Web

| 경로 | 가격 | Net | 비중 |
|---|---|---|---|
| **IAP** (Apple/Google) | ~$6.99 / $14.99 CAD | Apple SBP 15% 제외 (~$5.94 / $12.74) | Primary (App Store funnel) |
| **Web** (Stripe) | $7 / $15 CAD | Stripe 2.9% + $0.30 (~$6.50 / $14.27) | Marketing anchor + Reader app 셀프서비스 채널 |

Web 의 추가 가치: **Stripe sign-up funnel 을 살려야 IAP 15% 우회 가능 (Reader app 패턴)**. Web 자체는 entry surface 로 좁게 — daily UX (chat 등) 는 mobile 전용 (§3 surface 모델 참조).

### 13.8 Apple App Store 컴플라이언스 (Reader app 패턴)

**앱 안에서 허용**:
- IAP 결제 ($6.99 / $14.99)
- "이미 계정 있으세요? 로그인" — Web 가입자 sign-in
- Apple subscription manage 링크

**앱 안에서 금지** (default — 캐나다 + 미국):
- 웹 가격 표시
- 웹 결제 페이지 링크
- "웹에서 더 싸요" 류 hint

**미국 only** (2025 Epic v. Apple 판결 후) — External Link Account entitlement 신청 시 외부 결제 링크 1개 허용 + Apple 수수료 0%. **v1.5+ 검토** — 즉시 도입 시 정책 risk.

**v1 운영**: 앱 = IAP UI only, Web 가입자는 sign-in 만. Spotify / Netflix / Notion 패턴.

### 13.9 Subscription state — multi-source 룰

`subscriptions` 테이블은 user 에 attach (workspace 아님 — Section 8). 한 user 에게 동시 여러 source active 가능.

**Effective tier 결정 룰**:
1. Trial active (`users.trial_ended_at` > now) → effective = `pro`
2. 그 외 active subscriptions 중 **higher tier 가 effective tier** (Pro > Lite > Free)
3. 같은 tier 동시 결제 → 사용자에게 안내 + lower-cost (web) 유지 권장
4. 한 source 의 cancel/expire 후 다른 source 만 남으면 자동 전환

**Receipt 검증 endpoints (3종)**:
- `POST /billing/apple/verify` — Apple `original_transaction_id`, App Store Server API
- `POST /billing/google/verify` — Google Play Developer API
- `POST /webhooks/stripe` — Stripe webhook (signature 검증 필수)

각 endpoint idempotent + audit_events 기록. Server-side 검증 only (클라이언트 self-report 신뢰 X).

### 13.10 Per-user economics (월 가정, Gemini 2.5 Flash-Lite only)

**Gemini 2.5 Flash-Lite 가격** (May 2026): $0.10/M input + $0.40/M output. Thinking mode 미지원 (also not needed for Fina). Per-turn cost:

| 호출 타입 | 토큰 (in + out) | Per-turn |
|---|---|---|
| Categorize confirm (단순) | 1.5K + 100 | ~$0.00019 |
| Daily brief 생성 | 2K + 300 | ~$0.00032 |
| Free-form chat (평균) | 3K + 400 | ~$0.00046 |
| Deep audit / plan gen | 5K + 1.5K | ~$0.00110 |
| Background 분석 (Pro proactive) | 10K + 500 | ~$0.00120 |

**월 economics**:

| Tier | Net 결제 | LLM | Plaid | 인프라 | **마진** |
|---|---|---|---|---|---|
| Free | $0 | $0 | $0 | $0.30 | **-$0.30** (funnel) |
| Lite IAP ~$5.94 | $5.94 | ~$0.04 (ritual 30 + categorize ~50, all Flash-Lite) | $0.30 | $0.40 | **~$5.20** |
| Lite Web ~$6.50 | $6.50 | ~$0.04 | $0.30 | $0.40 | **~$5.76** |
| **Pro 평균 사용자** | $12.74 | ~$0.50 | $1.50 | $0.80 | **~$9.94** |
| **Pro 헤비 사용자** (1,000 chat + 200 deep/월) | $12.74 | ~$0.70 | $1.50 | $0.80 | **~$9.74** |
| **Pro hard cap 도달** (worst case 이론치) | $12.74 | $5 | $1.50 | $0.80 | **~$5.44** |
| Pro Web 평균 | $14.27 | ~$0.50 | $1.50 | $0.80 | **~$11.47** |
| **Trial 사용자** (월 평균) | $0 | ~$0.50 | $1.50 | $0.80 | **-$2.80** (CAC) |

Flash-Lite 의 단가가 낮아서 **평균 Pro 사용자는 월 $1 미만 LLM cost**. $5 hard cap 은 사실상 안전망 — 도달하려면 월 ~10,000 chat turn (=일 333 turn) 필요한데 인간 사용자 비현실적.

**Pro $5 LLM hard cap (안전망)**:
- 누적 cost 추적 + $5 도달 시 advisor 일시 중지 → 다음 청구일 자동 해제
- soft quota UX 따로 안 만듦 (사실상 unlimited 처럼 동작)
- Background "proactive monitoring" 은 daily 1회 + 트랜잭션 100건 이상 시 sampling

**Lite**: cron driven (ritual + categorize) 만, 사용자 quota 노출 unnecessary.

**가정**:
- Plaid pay-as-you-go (~$0.30/Item/월). Pro 평균 3 items.
- 인프라 = Postgres + hosting + push + Sentry amortized
- Trial CAC: 평균 $2.80/사용자, 10% conversion 시 paying 사용자 1명당 trial 비용 $28. Lite 5달 / Pro 3달 payback.

**Quality 노트**: Flash-Lite 가 plan generation / deep audit 품질에서 부족하면 (dogfooding 검증) — 옵션:
1. 같은 작업을 chunked + structured prompt 로 나누기
2. Pro 의 deep 작업만 2.5 Flash 로 escalate (provider 동일, $0.30/$2.50)
3. v1.5+ 에 frontier model (Sonnet/Opus) 도입

지금은 단일 Flash-Lite 로 운영 단순화 우선.

### 13.11 단계화

| 항목 | V1 dogfood | V1 public beta | V1.5+ |
|---|---|---|---|
| 결제 구현 | ❌ (Brian + 가족 자동 Pro) | ✅ Stripe + IAP | Apple/Google receipt 검증 자동화 |
| 30일 Trial | seed 로 모두 trial 처럼 | ✅ | (refinement) |
| Tier UI gating | DB 컬럼만 | feature-level (input bar gating 등) | per-feature 세밀 |
| Annual 결제 | ❌ | ❌ | ✅ |
| Family tier | ❌ | (current Free sharing 으로 cover) | (가격 차별화 검토) |
| US External Link entitlement | ❌ | TBD | Optional |

V1 dogfood 동안: 모두 자동 Pro. 결제 구현은 v1 public beta 직전 phase 에서. Schema 는 처음부터 박아둠 (Section 8).

### 13.12 Open issues

- **Trial → Free 전환 UX**: 어떤 메시지/타이밍이 conversion 가장 잘 됨?
- Pro chat free-form 의 LLM cost 폭주 시 throttling 임계값
- Mixed-tier workspace 에서 "Free 사용자가 Plaid 데이터 어디까지 보고/편집 가능한지" UAT 필요
- Annual 가격 ($70/년 Lite, $150/년 Pro 가정) elasticity
- Web 가입 funnel 에서 IAP 로의 cannibalization 측정
- Family tier 가 별도로 필요한지 vs 현재 sharing 모델로 충분한지

---

## 14. Tech Stack

| Layer | 선택 | 이유 |
|---|---|---|
| **Monorepo** | **Nx** | Affected/incremental build, generators, 풍부한 plugin (`@nx/expo`, `@nx/next`, `@nx/node`, `@nx/react`) |
| **Mobile** | **Expo (React Native)** + TypeScript | 푸시/카메라/Plaid SDK native 통합, EAS Build |
| **Web** | **Next.js (App Router)** + React + TypeScript | **Entry surface only** — landing/SEO + sign-up/sign-in + Stripe 결제 (Reader app) + invite accept + workspace/account settings. Daily UX (chat/transactions/ritual) 는 mobile-only, web 에 없음. SSR/SEO. |
| **백엔드** | **Fastify + TypeScript** | TS 친화, 빠름, 작음 |
| ORM | **Prisma** | TS-first, schema 한 파일, migration |
| DB | **Postgres (managed)** | Render / Neon / Supabase / Railway 중 택 1 |
| Auth | **Better Auth** (self-hosted OSS) | TS-first, Expo + Next.js + Node 모두 1급 지원 (`@better-auth/expo`, Better Auth Next.js 통합). Email/password + OAuth (Google/Apple) + Magic Link + MFA 빌트인. 우리 Postgres+Prisma 에 schema 통합 → 데이터 100% 소유. **Free forever**, vendor lock-in 없음. |
| Email 발송 | **Resend** (또는 AWS SES) | Magic link, 비밀번호 재설정, OTP 등. Resend free 3K/월, 이후 $10/월. |
| **LLM** | **Gemini 2.5 Flash-Lite** (단일 모델) | $0.10/M in + $0.40/M out — Fina 의 단순 use case (categorize, daily brief, basic query, plan generation) 에 충분. Thinking budget 미지원이지만 not needed. Frontier (Flash 또는 Sonnet) escalation 은 v1.5+ 검토. |
| LLM client | **Vercel AI SDK** | Provider-agnostic 추상화 (나중에 multi-provider/model 가도 인터페이스 유지) |
| Plaid | `plaid-node` + `react-native-plaid-link-sdk` + `react-plaid-link` (web) | 표준 |
| **Billing** | **Stripe** (web) + **react-native-iap** + **Apple/Google receipt 검증 SDK** | Hybrid IAP+Web (Section 13.7) |
| Push | **Expo Push Notifications** | iOS/Android abstract |
| Jobs | **pg-boss** (v1) → BullMQ + Redis (스케일 시) | Postgres 만으로 시작 |
| Storage | **S3 / R2** | CSV upload, 영수증 |
| Hosting (API) | **Render** 또는 **Fly.io** | 가격 + 단순함 |
| Hosting (Web) | **Vercel** | Next.js native, preview deploy, edge |
| Distribution | **EAS** (모바일) + Vercel (web) | TestFlight + Play internal + web preview |
| Observability | **Sentry + Logtail/Axiom** | 무료티어 |
| Secrets | **Doppler 또는 .env + 1Password** | Plaid token, LLM keys, Stripe keys, Apple/Google service account |
| Encryption | **app-level AES-GCM** (v1) → KMS (v2) | Plaid access_token at-rest |
| CI | **GitHub Actions** | Nx affected 활용 — lint + typecheck + test 변경된 project 만 |

### Repo 구조 (Nx)

```
fina/
├── nx.json
├── package.json (workspace root)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── apps/
│   ├── api/                 # @nx/node — Fastify backend
│   ├── mobile/              # @nx/expo — Expo RN
│   ├── web/                 # @nx/next — Next.js App Router
│   └── *-e2e/               # (필요 시) Playwright / Detox
└── libs/
    ├── shared/              # 공통 타입, ID brand, role enum
    ├── api-auth/            # Clerk JWT verify, assertMembership (api 만 import)
    ├── api-db/              # Prisma client + schema
    ├── api-billing/         # Stripe + Apple/Google receipt verifier (api 만)
    ├── ui-tokens/           # 색상, spacing, typography (web + mobile 공유)
    ├── chat-blocks/         # Block 스키마 (mobile + web + api 공유)
    └── tool-defs/           # LLM tool definitions (api 가 LLM 한테 노출, mobile/web 가 UI 매핑)
```

**왜 libs/ 가 여러 개**: Nx 의 affected 효과 극대화 — schema 만 바뀌면 그 lib 만 rebuild + lib 의존자만 retest. 또한 `api-*` lib 은 클라이언트 import 차단 (분류로 권한 leak 방지). `chat-blocks` / `tool-defs` 같은 cross-platform lib 는 RN 호환 (no Node-specific imports).

**v1 시작 시 최소**: `apps/api`, `apps/mobile`, `apps/web`, `libs/shared`. 나머지 lib 는 자연스럽게 분리되며 추가.

---

## 15. MVP Roadmap

> **Note**: 원래 Phase 1 (4~6주) 로 묶었으나 codex review 가 over-scope 지적 + 이후 v1 에 workspace sharing + web 추가로 더 분할 필요. **Phase 1 을 1A → 1.5 → 1B → 1C 로 분할**.

### Phase 1A — Foundations (2~3주)

**목표**: Auth, single workspace, mobile + web 양쪽 sign-in 동작.

- Nx monorepo scaffold (`apps/api`, `apps/mobile`, `apps/web`, `libs/shared`)
- Postgres + Prisma 셋업
- Fastify backend with Clerk JWT 미들웨어
- Clerk 로그인 — email magic-link + Google
  - Mobile (Expo + `@clerk/clerk-expo`)
  - Web (Next.js + `@clerk/nextjs`)
- User + Workspace + Membership 스키마 (multi-workspace ready, single per user 시작)
- Workspace 자동 생성 on `user.created` webhook
- `assertMembership` middleware (Section 10)
- `/me` endpoint — mobile + web 둘 다 호출, owner workspace 표시
- GitHub Actions CI (Nx affected lint + typecheck + test)

**Exit criteria**: 사용자 가입 → 모바일 + 웹 양쪽 로그인 → 둘 다 자기 personal workspace 정보 보임.

### Phase 1.5 — Workspace Sharing — Web (Plan 2, 2~3주)

**목표**: Web 에서 sharing 전체 동작 (invite/accept/role/switcher). Mobile sharing UX 는 후속 (Phase 1.5-mobile). 본인이 가족 한 명 web 으로 초대해서 같은 workspace 의 멤버로 보이는 게 끝점.

- `invites` 테이블 + `InviteStatus` enum (pending / accepted / revoked / expired)
- API 엔드포인트 9 개:
  - `GET /workspaces`, `GET /workspaces/:id/members`
  - `POST /workspaces/:id/invites`, `GET /workspaces/:id/invites`, `DELETE /workspaces/:id/invites/:inviteId`
  - `GET /invites/by-token/:token`, `POST /invites/by-token/:token/accept`
  - `PATCH /workspaces/:id/members/:userId`, `DELETE /workspaces/:id/members/:userId`
- `assertMembership` 가 `X-Workspace-Id` header 강제 (없으면 400, 비멤버 404 — info leak 방지)
- Email-bound invite — owner 가 email + role(editor/viewer) 지정, server-issued token, Resend 로 발송, 7 일 만료
- Role transitions + owner transfer (atomic, last-owner-cannot-leave/demote invariant 강제)
- Owner cardinality: workspace 당 owner 정확히 1 명 (transfer 가능)
- **Web UI only**:
  - `/invites/[token]` accept 페이지 (session.email == invite.email 검증, 다른 이메일이면 sign out 안내)
  - `/settings/workspace` — members + role 변경 + remove + pending invites + invite form
  - 헤더 mini workspace switcher (≥ 2 ws 일 때만 노출)
  - `X-Workspace-Id` cookie + 매 fetch 첨부 (Next.js middleware 에서 주입)
- **Mobile 변경 최소** (UI 추가 없음): 로그인 후 `/workspaces` 호출 → 첫 ws ID AsyncStorage 저장 → 이후 모든 요청 header 첨부. Switcher / members / invite UI 없음.
- Free tier sharing limit: **무제한** 유지 (abuse 발견 시 quota 검토)
- Per-row authorization 강화 (트랜잭션/예산 등 row 가 workspace_id 로 scope + role gate) 는 데이터 entity 추가될 때 그 PR 에 포함 — 지금은 막을 row 자체가 없음

**Exit criteria**: Owner 가 가족 한 명을 web 에서 초대 → 받는 사람이 web 에서 가입+accept → 양쪽 모두 같은 workspace 의 멤버로 보임. Mobile 은 ws 1 개인 사용자에 대해 회귀 없음.

### Phase 1.5-mobile — Workspace Sharing — Mobile (later, 1~2주)

**목표**: Web 에서 굳은 sharing UX 를 mobile 에 mirror. Plaid (Phase 1B) 전후 시점은 시점이 되면 결정.

- Mobile workspace switcher (settings 또는 header)
- Mobile members view (read + owner 면 role 변경/remove)
- Mobile invite form (보내기 — accept 자체는 그대로 web)
- Universal link / `fina://` deep link 로 invite 받기 (선택, 없어도 web 에서 accept 가능)

**Exit criteria**: Mobile 에서 ws 전환 + members 보기 + invite 보내기 가능.

### Phase 1B — Plaid + Account Model (2~3주)

**목표**: 자동 트랜잭션 + 카테고라이저. **Lite tier (Plaid 1개) gating 도 포함**.

- Plaid Link (캐나다) — 모바일 + 웹 양쪽 통합
- `accounts` entity 본격화 (Plaid item → accounts → transactions)
- `/transactions/sync` cursor 기반 sync (Section 9)
- Webhook handler + idempotency + signature 검증
- Pending → posted transition, removed transactions 처리
- Item error / re-auth 플로우
- Merchant 정규화 + Gemini Flash 카테고리 제안 (LLM 한 번 호출로 여러 미분류 트랜잭션 카테고리 제안)
- Merchant → 카테고리 매핑 학습 (manual confirm 시 자동 생성)
- Daily cron 보강 sync (last_sync_at > 24h)
- **Tier gate**: `linkBankAccount` 시 user 의 effective tier 체크 — Free 는 막음, Lite 는 1개까지, Pro 무제한

**Exit criteria**: 본인 (자동 Pro trial) Plaid 연결 → 트랜잭션 자동 import → 대부분 자동 카테고리. Free 사용자는 Plaid 시도 시 upgrade prompt.

### Phase 1C — Agent Writes + Confirmation (2~3주)

**목표**: Pro chat 이 mutate 가능 + 안전한 confirmation flow.

- Chat tool write 권한 추가: `addTransaction`, `categorizeTransaction`, `setBudget`, `addScheduledSpend`, `mapMerchantToCategory`
- `action_intents` 테이블 + intent issue/consume API
- Block 모델 v1: `text`, `categorize_card`, `confirm_card` (intent 기반)
- RN + web block renderer (3개 컴포넌트, libs/chat-blocks 공유)
- Bulk 작업 제한 + destructive op confirm 강제
- Tool execution audit (모든 mutate → audit_events row)
- **Tier gate**: chat input bar 활성/비활성 — Free 비활성 (chat 없음), Lite 비활성 (read-only ritual 만), Pro 활성

**Exit criteria**: Pro 사용자가 chat 으로 트랜잭션 카테고리/예산 변경 가능 (confirm 거치는 destructive 포함). Lite 사용자는 daily ritual 카드만 응답 가능.

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
- Gemini context caching 적용 (system + tools)

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
| 1A — Foundations (Nx + auth + single workspace) | 2~3주 |
| 1.5 — Workspace Sharing | 3~4주 |
| 1B — Plaid + Account Model + Tier gating | 2~3주 |
| 1C — Agent Writes + Confirmation | 2~3주 |
| 2 — Magic Ritual + Billing (Stripe + IAP) | 4~5주 |
| 3 — Advisor 깊어짐 (Pro 기능들) | 3~4주 |
| **총 v1** | **16~22주** (4~5개월) |

한 사람 풀타임 기준. 파트타임이면 비례. 결제 구현은 v1 public beta 직전 Phase 2 후반에 통합.

---

## 16. Out of Scope (v1.5 / v2+)

- Email 거래 알림 파싱 (가치 보고 결정)
- Goals (저축 목표, 디버트 페이오프) — Pro tier 의 일부로 v1 후반 도입 검토
- Investments tracking (Plaid Investments)
- Python AI service 분리 (호출량 + 복잡도 임계 넘으면)
- Annual 결제 + 별도 Family tier (Section 13 참조 — 현재 Free sharing 으로 가족 use case cover)
- US External Link Account entitlement (Section 13.8)
- Flinks 추가 (Plaid Canada 커버리지 부족할 시)
- Workspace sharing 의 advanced 기능 (per-account/per-category 권한, 활동 history 공유 view)

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
