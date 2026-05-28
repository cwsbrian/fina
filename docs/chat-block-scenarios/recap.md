# Recap block — chat scenarios

Manual smoke-test scenarios for the read-only `recap` presentation block.
Run these in the mobile app against a workspace with real (or seeded)
transactions. For each scenario, send the chat message and assert:

1. **Expected tool**: the named tool was called (visible as a tool row in
   the chat history).
2. **Block presence**: the assistant message includes a `recap` block —
   i.e. the chat shows the card UI, not just text.
3. **Block content shape**: title / headline / rows match the column.

Some scenarios have multiple valid tools — the LLM may pick either, both
are acceptable as long as the response carries a recap card.

---

> Date arguments: spending/breakdown/cashflow/compare tools now take
> `since` (YYYY-MM-DD, inclusive) and `until` (YYYY-MM-DD, exclusive).
> The LLM reads the "Today: YYYY-MM-DD" line in the context and
> translates phrasings ("this month", "올해", "지난 90일", "Q1", "지난주") to
> specific ISO dates. compareSpendingPeriods takes two date ranges:
> `current_since`/`current_until` + `comparison_since`/`comparison_until`.
> compareSpendingVsBudget keeps `period: this_month | last_month |
> next_month` because budgets are stored monthly.

## EN — getSpendingSummary

| User message | Expected tool call |
|---|---|
| `How much did I spend this month?` | `getSpendingSummary(since: first-of-month, until: first-of-next-month)` |
| `Spending this week` | `getSpendingSummary(since: Monday-of-week, until: next-Monday)` |
| `Total spend last month` | `getSpendingSummary(since: first-of-last-month, until: first-of-this-month)` |
| `Year to date spending` | `getSpendingSummary(since: YYYY-01-01, until: today)` |
| `Q1 spending` | `getSpendingSummary(since: YYYY-01-01, until: YYYY-04-01)` |
| `Last 90 days spending` | `getSpendingSummary(since: today-90, until: today)` |
| `Spending in March` | `getSpendingSummary(since: YYYY-03-01, until: YYYY-04-01)` |
| `What did I spend on by merchant this month?` | `... group_by: "merchant"` |
| `Show me daily spending this week` | `... group_by: "day"` |

## EN — getCategoryBreakdown

| User message | Expected tool call |
|---|---|
| `Break down spending by category this month` | `getCategoryBreakdown(this-month range)` |
| `Category breakdown` | default to this month |
| `Category breakdown this year` | `getCategoryBreakdown(YYYY-01-01 → YYYY+1-01-01)` |

## EN — compareSpendingPeriods

| User message | Expected tool call |
|---|---|
| `How does this month compare to last month?` | `compareSpendingPeriods(current=this-month, comparison=last-month, group_by: "category")` |
| `Am I spending more this week vs last week?` | `(current=this-week, comparison=previous-week)` |
| `This year vs last year` | `(current=YYYY, comparison=YYYY-1)` |
| `Q1 this year vs Q1 last year` | `(current=YYYY Q1, comparison=YYYY-1 Q1)` |
| `Biggest changes vs last month` | category compare with non-zero deltas |

## EN — getCashflowSummary

| User message | Expected tool call |
|---|---|
| `Show cashflow this month` | `getCashflowSummary(this-month range)` |
| `Cashflow this year` | `getCashflowSummary(YYYY-01-01 → YYYY+1-01-01)` |
| `Cashflow by account` | `... group_by: "account"` |
| `Income vs expenses this month` | `getCashflowSummary` |

## EN — compareSpendingVsBudget

(Budgets are stored monthly — kept on the `period` enum.)

| User message | Expected tool call |
|---|---|
| `Am I over budget?` | `compareSpendingVsBudget(period: "this_month")` |
| `Budget status` | same |
| `Did I stay under my food budget?` | same — LLM may comment on the food row |

---

## KR — getSpendingSummary

| User message | Expected tool call |
|---|---|
| `이번달 얼마 썼어?` | `getSpendingSummary(this-month range)` |
| `이번주 지출` | `getSpendingSummary(this-week range)` |
| `지난달 총 지출` | `getSpendingSummary(last-month range)` |
| `올해 얼마 썼어` | `getSpendingSummary(YYYY-01-01 → YYYY+1-01-01)` |
| `작년에 얼마 썼어` | `getSpendingSummary(YYYY-1-01-01 → YYYY-01-01)` |
| `지난 90일` | `getSpendingSummary(today-90 → today)` |
| `이번달 가게별 지출` | `... group_by: "merchant"` |
| `이번주 일별 지출 보여줘` | `... group_by: "day"` |

## KR — getCategoryBreakdown

| User message | Expected tool call |
|---|---|
| `이번달 카테고리별 지출` | `getCategoryBreakdown(this-month range)` |
| `카테고리 분석` | default to this month |
| `올해 카테고리별` | `getCategoryBreakdown(YYYY range)` |

## KR — compareSpendingPeriods

| User message | Expected tool call |
|---|---|
| `지난달 대비 이번달은 어때?` | `(current=this-month, comparison=last-month, group_by: "category")` |
| `지난주랑 비교해서 이번주 더 썼어?` | `(current=this-week, comparison=previous-week)` |
| `작년 vs 올해` | `(current=YYYY, comparison=YYYY-1)` |
| `이번달 비싸진 가게` | `... group_by: "merchant"` |

## KR — getCashflowSummary

| User message | Expected tool call |
|---|---|
| `이번달 현금흐름 보여줘` | `getCashflowSummary(this-month range)` |
| `이번주 순현금 어때?` | `getCashflowSummary(this-week range)` |
| `올해 현금흐름` | `getCashflowSummary(YYYY range)` |
| `계좌별 현금흐름` | `... group_by: "account"` |

## KR — compareSpendingVsBudget

| User message | Expected tool call |
|---|---|
| `예산 다 썼어?` | `compareSpendingVsBudget(period: "this_month")` |
| `이번달 예산 어때?` | same |
| `식비 예산 얼마나 남았어?` | same — LLM comments on food row |
| `버젯 상태` | same |

---

## Konglish / 변형 표현

LLM이 영어 단어를 한국식으로 발음한 표현, 또는 사용자 고유의 표현도 인식해야:

| User message | Expected tool |
|---|---|
| `캐쉬플로우 보여줘` | `getCashflowSummary` |
| `캐시플로우` | `getCashflowSummary` |
| `버젯 어때` | `compareSpendingVsBudget` |
| `버겟 얼마남앗어` | `compareSpendingVsBudget` |
| `스펜딩 요약` | `getSpendingSummary` |
| `이번달 어떻게 지나가고있어` (= 진행 상황) | `compareSpendingVsBudget` 또는 `getCashflowSummary` 둘 다 OK |

---

## Edge cases

| 시나리오 | 기대 동작 |
|---|---|
| `지출` 만 입력 (period 미지정) | LLM이 `this_month` 기본으로 호출, OR 사용자에게 짧게 follow-up |
| 빈 데이터 (해당 period에 거래 0건) | recap block.rows = [], renderer가 "No data for this period yet." empty state 보임 |
| 50개 카테고리 (limit 초과) | top 8 / top 10 까지만 rows. footer "Top N of TOTAL" 표시 |
| 카테고리 이름이 한글 ("식비") | rows[].label = "식비" 그대로, 화면에 정상 표시 |
| `예산` 만 (compareSpendingVsBudget 시 budget 0건) | block.rows = [], footer "No budgets set for this period yet." |
| Wrong tool 호출 ("예산 설정" → setBudget) | recap이 아니라 setBudget 라우트. **이 시나리오는 recap 테스트 아님** — system prompt가 잘 구분해야 |
| 매우 큰 액수 (overflow) | 정상 표시, 천단위 콤마 |

---

## 부정 시나리오 (recap이 호출되면 안 되는 케이스)

| User message | NOT 호출 |
|---|---|
| `오늘 날씨 어때?` | recap 안 호출. 시스템 프롬프트 scope에 의해 "I only help with your Fina money" 거절 |
| `이번달 예산을 500으로 설정` | recap 아님 — `setBudget` 호출되어야 |
| `Netflix 정기지출 추가` | recap 아님 — `addRecurring` 호출되어야 |
| `Starbucks 거래 보여줘` | recap 아님 — `findTransactions` 호출 |

---

## 자동 발화 시나리오 (out of scope for recap)

다음은 별도 블록(`anomaly`, `income`, `payday`)이 필요한 시나리오. recap이 직접 처리하지 않음:

- 큰 거래 감지 → `anomaly` block (별도 블록 작업)
- 입금 거래 도착 → `income` / `payday` / `split` block (별도)
- 정기지출 청구 예정 → `recurring` block (별도)

---

## 수동 테스트 흐름

1. **Expo Go에서 앱 실행** (mobile)
2. Pro 트라이얼/유료 계정으로 로그인
3. 거래가 있는 워크스페이스 선택 (없으면 seed)
4. Chat 탭 → 새 thread 시작
5. 위 표 순서대로 메시지 입력
6. 각 메시지마다 확인:
   - assistant 메시지에 recap card UI가 보이는가
   - title / period label / 헤드라인 금액이 자연스러운가
   - rows의 bar / delta가 의도대로 표시되는가
   - footer (있을 때) 정확한가
7. 발견된 LLM 오인식은 이 doc에 추가 → tool description / system prompt 튜닝

## CI 자동화 (future)

각 EN/KR 시나리오마다:
1. Test DB에 seed (사용자 + 워크스페이스 + 거래 fixture)
2. Mock Gemini로 시나리오 메시지 처리
3. assistant 메시지의 blocks 배열에 `{type:"recap"}` 포함 확인
4. (선택) block.headline.amount가 seed total과 일치하는지 검증

지금은 수동 테스트로 충분. tool description 안정화 후 자동화 고려.
