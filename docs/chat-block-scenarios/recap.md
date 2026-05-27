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

## EN — getSpendingSummary

| User message | Expected tool | Notes |
|---|---|---|
| `How much did I spend this month?` | `getSpendingSummary(period: "this_month")` | Headline = total; rows by category |
| `Spending this week` | `getSpendingSummary(period: "this_week")` | |
| `Total spend last month` | `getSpendingSummary(period: "last_month")` | |
| `What did I spend on by merchant this month?` | `getSpendingSummary(period: "this_month", group_by: "merchant")` | |
| `Show me daily spending this week` | `getSpendingSummary(period: "this_week", group_by: "day")` | |
| `Top categories this month` | `getSpendingSummary` or `getCategoryBreakdown` | Either fine |

## EN — getCategoryBreakdown

| User message | Expected tool |
|---|---|
| `Break down spending by category this month` | `getCategoryBreakdown(period: "this_month")` |
| `Category breakdown` | same (defaults to this_month) |
| `Which categories took the most this month?` | `getCategoryBreakdown` |

## EN — compareSpendingPeriods

| User message | Expected tool |
|---|---|
| `How does this month compare to last month?` | `compareSpendingPeriods(current: "this_month", comparison: "last_month", group_by: "category")` |
| `Am I spending more this week vs last week?` | `compareSpendingPeriods(current: "this_week", comparison: "previous_week", ...)` |
| `Biggest changes vs last month` | `compareSpendingPeriods(..., group_by: "category")` — rows should have non-zero `delta` |
| `Which merchants got more expensive this month?` | `compareSpendingPeriods(..., group_by: "merchant")` |

## EN — getCashflowSummary

| User message | Expected tool |
|---|---|
| `Show cashflow this month` | `getCashflowSummary(period: "this_month")` |
| `How's my net cashflow this week?` | `getCashflowSummary(period: "this_week")` |
| `Cashflow by account` | `getCashflowSummary(group_by: "account")` |
| `Income vs expenses this month` | `getCashflowSummary` |

## EN — compareSpendingVsBudget

| User message | Expected tool |
|---|---|
| `Am I over budget?` | `compareSpendingVsBudget(period: "this_month")` |
| `How is my budget going?` | same |
| `Budget status` | same |
| `Did I stay under my food budget?` | `compareSpendingVsBudget` (LLM may also follow with text commenting on the specific row) |

---

## KR — getSpendingSummary

| User message | Expected tool |
|---|---|
| `이번달 얼마 썼어?` | `getSpendingSummary(period: "this_month")` |
| `이번주 지출` | `getSpendingSummary(period: "this_week")` |
| `지난달 총 지출` | `getSpendingSummary(period: "last_month")` |
| `이번달 가게별 지출` | `getSpendingSummary(group_by: "merchant")` |
| `이번주 일별 지출 보여줘` | `getSpendingSummary(group_by: "day")` |
| `상위 카테고리 이번달` | `getSpendingSummary` or `getCategoryBreakdown` |

## KR — getCategoryBreakdown

| User message | Expected tool |
|---|---|
| `이번달 카테고리별 지출` | `getCategoryBreakdown(period: "this_month")` |
| `카테고리 분석` | `getCategoryBreakdown` |
| `이번달 어느 카테고리에 제일 많이 썼어?` | `getCategoryBreakdown` |

## KR — compareSpendingPeriods

| User message | Expected tool |
|---|---|
| `지난달 대비 이번달은 어때?` | `compareSpendingPeriods(current: "this_month", comparison: "last_month", group_by: "category")` |
| `지난주랑 비교해서 이번주 더 썼어?` | `compareSpendingPeriods(current: "this_week", comparison: "previous_week", ...)` |
| `지난달 대비 변동 큰 항목` | `compareSpendingPeriods(group_by: "category")` |
| `이번달 비싸진 가게` | `compareSpendingPeriods(group_by: "merchant")` |

## KR — getCashflowSummary

| User message | Expected tool |
|---|---|
| `이번달 현금흐름 보여줘` | `getCashflowSummary(period: "this_month")` |
| `이번주 순현금 어때?` | `getCashflowSummary(period: "this_week")` |
| `계좌별 현금흐름` | `getCashflowSummary(group_by: "account")` |
| `이번달 수입 vs 지출` | `getCashflowSummary` |

## KR — compareSpendingVsBudget

| User message | Expected tool |
|---|---|
| `예산 다 썼어?` | `compareSpendingVsBudget(period: "this_month")` |
| `이번달 예산 어때?` | same |
| `식비 예산 얼마나 남았어?` | `compareSpendingVsBudget` (text comment may name the specific row) |
| `버젯 상태` | `compareSpendingVsBudget` |

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
