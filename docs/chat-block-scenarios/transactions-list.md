# transactions_list block — chat scenarios

Manual smoke-test scenarios for the read-only `transactions_list` block.
Run in the mobile app. For each scenario verify:

1. **Expected tool** was called.
2. **Card UI** renders with title, total count (and optional total
   amount), per-row date label + merchant + amount + optional category
   chip + optional review badge.
3. **Tap a row** → navigates to `/transactions/[id]` detail screen.

---

## EN — listTransactions (recent listing, no search)

| User message | Expected tool |
|---|---|
| `Show me recent transactions` | `listTransactions()` — defaults to 20 most recent |
| `List my transactions` | `listTransactions()` |
| `Recent transactions this month` | `listTransactions(period: "this_month")` |
| `What did I buy today?` | `listTransactions(period: "today")` |
| `My last 10 transactions` | `listTransactions(limit: 10)` |

## EN — findTransactions (filtered search)

| User message | Expected tool |
|---|---|
| `Show me Starbucks transactions` | `findTransactions(merchant_query: "starbucks")` |
| `Transactions over $100 last month` | `findTransactions(amount_min: 100, start_date: ..., end_date: ...)` |
| `Food transactions this month` | `findTransactions(category_name: "Food", start_date: ..., end_date: ...)` |
| `Transactions in March between $20 and $50` | `findTransactions(start_date: "2026-03-01", end_date: "2026-03-31", amount_min: 20, amount_max: 50)` |
| `Chequing account transactions this month` | `findTransactions(account_name: "Chequing", ...)` |

## EN — findUncategorizedTransactions

| User message | Expected tool |
|---|---|
| `Show me uncategorized transactions` | `findUncategorizedTransactions()` |
| `What needs review?` | `findUncategorizedTransactions()` |
| `Show uncategorized from last month` | `findUncategorizedTransactions(period: "last_month")` |

---

## KR — listTransactions

| User message | Expected tool |
|---|---|
| `최근 거래 보여줘` | `listTransactions()` |
| `이번달 거래 목록` | `listTransactions(period: "this_month")` |
| `오늘 산 거` | `listTransactions(period: "today")` |
| `최근 5개 거래` | `listTransactions(limit: 5)` |

## KR — findTransactions

| User message | Expected tool |
|---|---|
| `스타벅스 거래` | `findTransactions(merchant_query: "스타벅스" or "starbucks")` |
| `100불 이상 거래` | `findTransactions(amount_min: 100)` |
| `식비 카테고리 거래` | `findTransactions(category_name: "Food")` |
| `Chequing 계좌 거래` | `findTransactions(account_name: "Chequing")` |

## KR — findUncategorizedTransactions

| User message | Expected tool |
|---|---|
| `분류 안 된 거래` | `findUncategorizedTransactions()` |
| `리뷰 필요한 거래` | `findUncategorizedTransactions()` |
| `이번달 분류 안 된` | `findUncategorizedTransactions(period: "this_month")` |

---

## Card rendering checklist

- ✅ Title — "Recent transactions" / "Search: starbucks" / "Needs review"
- ✅ Date label — "Today" / "Yesterday" / "Mon May 5" / "May 5, 2025"
- ✅ Merchant displayed (raw, not normalized)
- ✅ Amount color — expense ink (default), income green with `+` prefix
- ✅ Category chip — tinted with category color + icon if present
- ✅ Account name as small muted text in meta row
- ✅ "review" yellow badge when `needs_review: true`
- ✅ Footer — "Showing N of M" when capped
- ✅ Empty state — "No transactions match." when 0 rows
- ✅ Tap row → `/transactions/[id]` detail screen

## Edge cases

| 시나리오 | 기대 |
|---|---|
| 빈 결과 (`Starbucks 100건` 같은 매치 0) | card에 "No transactions match." empty state |
| 50건 검색 결과 | rows = 10 (block cap) + footer "Showing 10 of 50" |
| 모두 분류 완료 (review queue 비어있음) | "All caught up — nothing to review." footer |
| 카테고리 없는 거래 | category chip 안 보임, 다른 행은 정상 |
| 환불 거래 (negative amount) | 녹색 `+12.34` |

## Negative scenarios (tool NOT to be called)

| User message | NOT |
|---|---|
| `이번달 얼마 썼어` | listTransactions 아님 — `getSpendingSummary` |
| `vs last month` | `compareSpendingPeriods` 아님 — 거래 list 아님 |
| `오늘 날씨` | 거절 한 줄 |
