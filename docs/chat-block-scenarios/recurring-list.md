# recurring_list block — chat scenarios

Manual smoke-test scenarios for the read-only `recurring_list` block.

---

## EN — listRecurring

| User message | Expected tool |
|---|---|
| `Show my recurring expenses` | `listRecurring()` |
| `What's my recurring?` | `listRecurring()` |
| `List my subscriptions` | `listRecurring()` |
| `What am I paying every month?` | `listRecurring()` |

## KR — listRecurring

| User message | Expected tool |
|---|---|
| `내 정기지출 보여줘` | `listRecurring()` |
| `구독 목록` | `listRecurring()` |
| `매월 빠지는 거` | `listRecurring()` |
| `정기 결제` | `listRecurring()` |

## Card rendering checklist

- ✅ Title — "Recurring expenses"
- ✅ Headline — `$134.50 / mo · 5 active` (server-computed monthly equivalent)
- ✅ Per row: name + amount/cadence (`$19.00 / mo`) + next occurrence date
- ✅ Date label — `Next today` / `Next tomorrow` / `Next Mon` / `Next May 5`
- ✅ Category chip — tinted with category color + icon when set
- ✅ Empty state — block omitted entirely when no recurring (text only)
- ✅ Footer — "Showing 10 of 23" when capped

## Add-intent disambiguation (system prompt-driven)

Ambiguous "X 추가" / "Add X" should trigger a clarifying question, NOT a
direct write. The LLM must ask whether it's recurring vs one-time, then
call presentConfirmCard with the right tool.

| User message | Expected behavior |
|---|---|
| `Add Netflix $19/month` | direct presentConfirmCard → addRecurring (cadence clear) |
| `Netflix를 매월 19불로 추가` | same |
| `Add Netflix` | LLM asks: "monthly subscription or one-time?" |
| `Netflix 추가` | LLM asks (KR) |
| `Add $50 dinner next Friday` | direct presentConfirmCard → addScheduledSpend |
| `다음주 화요일 50불 외식 추가` | same |

## Edge cases

| 시나리오 | 기대 |
|---|---|
| 정기지출 0건 (`내 정기지출` + 등록된 거 없음) | block 없음, 텍스트만 ("아직 등록된 정기지출이 없어요") |
| 1건만 (`internet $50`) | block 노출, 단일 row |
| 11건 이상 | top 10 + footer "Showing 10 of N" |
| 다양한 cadence 섞임 (monthly + biweekly + yearly) | monthly-equivalent 합계 카드에 표시 |
| 카테고리 없는 recurring | row category chip 안 보임 |
