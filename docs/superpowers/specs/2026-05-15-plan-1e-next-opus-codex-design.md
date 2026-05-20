# Plan 1E-next — Opus-Codex Variant Design

**Date:** 2026-05-15
**Variant:** `opus-codex` (Opus 작성, Codex 외부 review 예정)
**Status:** Draft — pending Codex review pass

---

## 1. Overview

Plan 1E-next는 Fina chat agent에 7개의 새 도구를 추가하여, 기존 4개 도구(`listTransactions`, `getSpendingSummary`, `listCategories`, `categorizeTransaction`)로는 답할 수 없던 자연스러운 사용자 질문을 처리한다.

### 1.1 7개 tool 한눈에

| # | Name | 한 줄 목적 |
|---|---|---|
| 1 | `findTransactions` | merchant/금액/카테고리/날짜로 거래 검색 |
| 2 | `detectRecurring` | 거래 이력에서 정기 결제 추론 |
| 3 | `comparePeriods` | 두 기간의 카테고리별 + 전체 지출 비교 |
| 4 | `listAccounts` | active 계좌 + 잔액 정보 |
| 5 | `createCategory` | 새 카테고리 생성 (subcategory 가능) |
| 6 | `addTransactionNote` | 거래에 메모 추가/덮어쓰기 |
| 7 | `getTransactionDetails` | 단일 거래의 풍부한 상세 정보 |

### 1.2 Rationale — 왜 이 7개인가

- **검색 강화** (`findTransactions`): 기존 `listTransactions`는 `period`, `limit`만 받음. "이번 달 Amazon에서 얼마 썼지?", "$200 넘는 거래 보여줘" 같은 가장 흔한 질문에 답하려면 필터가 필수.
- **정기 결제 발견** (`detectRecurring`): 호출 빈도는 낮지만 한 번 답할 때 정보 가치가 매우 큼. "내가 뭘 구독하고 있더라"는 chat agent에서 답할 수 있어야 한다.
- **시간 비교** (`comparePeriods`): LLM이 `getSpendingSummary`를 두 번 호출해서 차이를 계산할 수도 있지만, 카테고리별 정렬 비교까지 정확히 시키려면 token이 많이 들고 누락 가능성이 높다. 결과 일관성을 위해 단일 tool로 제공.
- **계좌 잔액** (`listAccounts`): "통장 얼마 남았어?"는 매우 흔한 질문인데 현재 답 불가.
- **카테고리 생성** (`createCategory`): `categorizeTransaction`이 존재하지 않는 카테고리를 만나면 실패. 사용자가 chat에서 "Take-out 카테고리 만들어줘"를 한 번에 처리할 수 있어야 한다. 자가-충족 워크플로우.
- **메모 + 상세** (`addTransactionNote`, `getTransactionDetails`): safe write의 안전 영역. 단일 거래에 대한 deeper interaction. "이 거래 무슨 거래야?" / "그 거래에 '회사 회식' 적어줘".

### 1.3 의도적으로 제외한 것

| 제외 항목 | 이유 |
|---|---|
| `deleteTransaction`, `updateTransaction` | 파괴적. confirm UI 패턴 필요 — 별도 plan |
| `addTransaction` (수동 거래 추가) | safe write이지만 confirm UX 권장 — 별도 plan |
| 카테고리 rename / archive / merge / delete | mass operation은 별도 plan |
| MerchantMapping rule 관리 | 별도 plan |
| Budget / spending limit | DB 모델 자체 없음 |
| Plaid `/transactions/recurring/get` 통합 | stack에 미구현 — 휴리스틱으로 우회 |
| `top_n` / `outliers` 류 통계 tool | 기존 `getSpendingSummary`(group_by)로 부분 커버. YAGNI |

---

## 2. Common conventions

모든 tool이 따르는 규칙. 도구 정의 본문에서는 반복하지 않는다.

### 2.1 Tool 인터페이스

```ts
// apps/api/src/chat/tools/types.ts (기존, 수정 없음)
export type ToolContext = { env: Env; workspaceId: string; userId: string };
export type ToolDef<TArgs, TResult> = {
  name: string;
  description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
```

### 2.2 Workspace isolation

모든 Prisma query는 `where: { workspaceId: ctx.workspaceId, ... }` 를 가장 바깥에 포함한다. 단일 row lookup도 `findFirst({ where: { id, workspaceId } })` 형태로 작성하여 cross-workspace ID 추측 공격을 차단한다. `findUnique({ where: { id }})`는 금지 (workspace 필터 누락 위험).

### 2.3 Zod `.describe()` 의무

`zod-to-json-schema`가 description을 Gemini로 그대로 전달한다. 모든 args field에 `.describe("...")` 필수. description은 LLM에게 사용 가이드를 주는 것이 목적 — "타입 이름"이 아니라 "언제 어떻게 쓰는가"를 적는다.

좋은 예: `.describe("merchantRaw와 merchantNormalized 양쪽에 대한 부분-문자열 매칭. 대소문자 무시. 예: 'amazon', 'tim hortons'.")`
나쁜 예: `.describe("merchant query string")`

### 2.4 LLM-facing vs internal naming

- LLM이 보는 args: snake_case (예: `tx_id`, `merchant_query`, `date_start`)
- 내부 service / Prisma 호출: camelCase (예: `txId`, `merchantQuery`, `dateStart`)
- Tool `run` 안에서 args 받자마자 destructure하여 내부 이름으로 변환

### 2.5 직렬화

- `Decimal` → 반드시 `.toString()`. 절대 raw Decimal 반환 금지.
- Date → ISO 8601 string. 시각이 의미있는 필드(`occurredAt`)는 full ISO; 날짜만 의미있는 필드(`expectedNextDate`)는 `"YYYY-MM-DD"`.
- `null` 가능 필드는 nullable로 명시 (예: `balanceCurrent: string | null`).

### 2.5.0 알려진 한계: occurredAt 저장 형식 vs user-timezone 필터

`apps/api/src/plaid/sync.ts`는 Plaid date-only transactions(`YYYY-MM-DD`)를 `new Date("YYYY-MM-DD")`로 저장한다 — 즉 **UTC midnight** 으로 stamped. 본 plan은 `findTransactions`/`comparePeriods`에 user-timezone 기반 calendar 필터를 도입하므로 다음 경계 효과가 발생한다:

- Plaid row dated `2026-05-01` → 저장된 `occurredAt = 2026-05-01T00:00:00Z`
- America/Toronto user 입장에서 이는 **Apr 30 20:00 local** → user-local `last_month`(=April) 필터에 포함됨

원래 Plaid는 자료에서 5월 1일자 거래로 의도되었지만 user-local 4월로 분류되는 어긋남. 이는 transactions **storage 정책** 결정이 필요한 사안(저장 시점에 user.tz 적용? 별도 column 추가? Plaid date를 datetime으로 변환 시 noon UTC 사용?) — 본 plan은 신규 chat tools 도입 범위이며 storage 정책 변경은 **별도 plan**.

**현 plan의 결정:** user-timezone 필터를 그대로 도입한다. Plaid date-only 거래의 경계 효과는 알려진 한계로 두고, 위의 storage 정책 plan에서 해소한다. LLM 응답 품질에 미치는 영향은 다음과 같이 평가했다:
- `findTransactions`: 사용자가 특정 날짜 범위를 묻는 경우, ±1 거래의 boundary mismatch는 일반적 자연어 답변 품질에 큰 영향 없음.
- `comparePeriods`: monthly 비교가 ±1일 거래로 일부 어긋날 수 있음. period 합계에 미치는 효과는 일반적으로 미미하나, 매우 작은 카테고리(e.g., monthly 1건짜리 정기 결제)는 잘못된 month에 잡힐 수 있음.
- `detectRecurring`: 90일 window 휴리스틱이므로 영향 미미.

테스트는 이 정책을 반영한다 — Plaid sync의 UTC midnight 저장을 가정한 fixture와, 향후 storage plan 도입 후 갱신 가능한 boundary 테스트 분리.

### 2.5.1 통화 가정 (Currency)

`Transaction.currency`와 `BankAccount.currency`는 schema에 존재하지만, 본 plan의 모든 도구는 **단일 통화 workspace** (대다수 사용자는 CAD)를 가정한다. 이유:

- LLM이 currency-aware 집계를 정확히 표현하기 어렵고, mixed-currency 합계는 의미가 모호함.
- 다중 통화는 FX 변환 정책(어떤 환율, 어느 시점, 누가 결정)이 별도 product decision.

이 가정을 도구에 반영하는 규칙:

- **집계 도구**(`comparePeriods`, `detectRecurring`): 결과의 totals/avgAmount에 `currency: string` 필드를 함께 반환. 결과 set 안의 거래들이 다중 통화로 섞여 있으면 그룹 분리(예: detectRecurring) 또는 그대로 합산(comparePeriods — workspace primary currency 명시) 정책을 도구별로 명시.
- **필터 도구**(`findTransactions`): amount_min/max는 거래의 native amount로 매칭. description에 "거래의 native currency 기준 — workspace가 단일 통화일 때만 안정적" 명시.
- **상세 도구**(`getTransactionDetails`, `listAccounts`): row 자체의 `currency`를 노출.

multi-currency 정식 지원은 후속 plan(FX 변환 정책 + UI 표시 정책 함께).

### 2.6 Error contract

- 모든 tool은 도메인 에러 코드를 throw한다: `throw new Error('tx_not_found')`.
- HTTP / Fastify 에러는 던지지 않는다 (test에서 Fastify 의존성 없이 `tool.run()` 직접 호출 가능해야 함).
- 디스패처가 catch해서 `{ ok: false, error: "tx_not_found" }`를 LLM에 functionResponse로 전달, LLM이 사용자에게 자연어로 설명.

**Zod parse 실패 vs 도메인 에러:**
디스패처는 `zod.safeParse(rawArgs)`가 실패하면 tool을 호출하지 않고 `{ ok: false, error: "invalid_args" }`(또는 디스패처 구현이 사용하는 명칭)를 반환한다. 따라서 도메인-수준 검증(빈 문자열 거부, period range invalid 등)을 도메인 에러로 전달하려면 **Zod schema를 그만큼 느슨하게** 두고 검증을 `run()` 안에서 수행해야 한다. 본 spec의 각 tool은 이 원칙을 따른다.

표준 도메인 에러 코드:
- `tx_not_found` — 해당 transaction이 workspace에 없거나 (write/state-changing tool 한정으로) `removedAt != null`
- `category_not_found` — 카테고리 이름으로 lookup 실패
- `parent_not_found` — `createCategory`의 parent_name이 없음
- `category_exists` — `createCategory`에서 중복
- `category_cap_reached` — 활성 카테고리 30개 한도 초과
- `invalid_name` — 카테고리 이름이 trim 후 빈 string
- `name_too_long` — 카테고리 이름 trim 후 40자 초과
- `invalid_date` — 형식은 맞지만 캘린더상 존재하지 않는 날짜 (예: `2026-02-31`)
- `invalid_date_range` — date_start > date_end
- `invalid_amount_range` — amount_min > amount_max
- `note_required` — addTransactionNote에서 trim 후 빈 string
- `note_too_long` — addTransactionNote에서 500자 초과
- `invalid_period` — comparePeriods의 range에서 start > end (start/end 누락은 zod required로 인해 `invalid_args`로 dispatcher 단에서 거부됨 — 도메인 에러 도달 불가)

**removedAt 처리 규약 (도구별):**
- **Write/state-changing** (`addTransactionNote`): `removedAt != null` 거래는 거부 → throw `tx_not_found` (info-leak 방지 위해 not-found와 동일 코드).
- **Read-only with surfacing intent** (`getTransactionDetails`): `removedAt != null` 거래도 정상 반환 (휴지통 거래 추적 가능). `removedAt` 필드를 결과에 명시 노출하여 LLM이 "삭제된 거래" 라고 표현할 수 있게 함.
- **Aggregation** (`findTransactions`, `detectRecurring`, `comparePeriods`): `removedAt: null` 거래만 집계 대상.

**Strict date 검증 헬퍼:**

```ts
function parseStrictDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('invalid_date');
  const d = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error('invalid_date');
  if (d.toISOString().slice(0, 10) !== s) throw new Error('invalid_date');
  return d;
}
```

이 헬퍼를 `findTransactions`(date_start, date_end), `comparePeriods`(range start, end)에서 공통 사용한다. (`2026-99-99`/`2026-02-31`을 정규식만으로 못 막는 문제 해결.)

### 2.7 Test 형태

각 tool은 vitest 통합 테스트 (real DB)를 동반한다. 형태:

```ts
describe("findTransactions", () => {
  it("filters by merchant_query (case-insensitive)", async () => {
    // arrange: seed 2 workspaces, 5 transactions
    const result = await findTransactions.run(ctx, { merchant_query: "amazon" });
    expect(result).toHaveLength(2);
  });
  it("does not leak across workspaces", async () => { /* ... */ });
});
```

---

## 3. Tool specifications

### 3.1 `findTransactions`

**File:** `apps/api/src/chat/tools/find-transactions.ts`

**Description (LLM-facing):**
> 거래를 필터링하여 조회한다. merchant 이름, 금액 범위, 카테고리, 날짜 범위로 좁힐 수 있다. 모든 필터는 선택사항이며 AND로 결합된다. 최신순으로 정렬되며 기본 20건, 최대 50건 반환.

**Args (zod):**

```ts
z.object({
  merchant_query: z.string().min(1).max(100).optional()
    .describe("merchantRaw와 merchantNormalized 양쪽에 대한 부분-문자열 매칭. 대소문자 무시. 예: 'amazon', 'tim hortons'."),
  amount_min: z.number().nonnegative().optional()
    .describe("거래 절댓값(abs(amount))의 최소값. 거래의 native currency 기준 (workspace가 단일 통화일 때 안정적). 예: 100 = $100 이상 거래. 부호 무관."),
  amount_max: z.number().nonnegative().optional()
    .describe("거래 절댓값의 최대값. native currency 기준. amount_min과 함께 쓰면 범위 매칭."),
  category: z.string().min(1).max(80).optional()
    .describe("카테고리 이름(대소문자 무시, 정확 일치). 카테고리가 존재하지 않으면 빈 배열 반환."),
  date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("조회 시작일(ISO YYYY-MM-DD, 포함). 예: '2026-04-01'."),
  date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe("조회 종료일(ISO YYYY-MM-DD, 포함). date_start보다 같거나 이후여야 함."),
  limit: z.number().int().min(1).max(50).optional()
    .describe("최대 반환 건수. 기본 20, 최대 50."),
}).describe("거래 검색 필터. 모든 필드 optional, AND 결합.")
```

**Return type:**

```ts
type Result = Array<{
  id: string;
  amount: string;           // Decimal.toString(), 부호 보존 (양수=지출, 음수=환불/입금)
  currency: string;         // ISO 4217, 예: "CAD"
  merchantRaw: string;
  merchantNormalized: string | null;
  categoryId: string | null;
  categoryName: string | null;  // join 결과 (Category가 archivedAt != null이어도 이름은 반환)
  occurredAt: string;       // ISO 8601 full
}>;
```

**Implementation notes:**

1. 인풋 검증 (zod 통과 후, run() 안에서):
   - `date_start` 있으면 `parseStrictDate(date_start)` → 실패 시 throw `invalid_date`
   - `date_end` 있으면 `parseStrictDate(date_end)` → throw `invalid_date`
   - **user-timezone 변환** (comparePeriods와 동일 규약, §3.3 참조):
     - `ctx.userId` → `User.tz` lookup (실패/비정상 시 fallback `"America/Toronto"`)
     - `date_start` → user-local 00:00:00의 UTC instant (`startInstant`)
     - `date_end` → user-local 23:59:59.999의 UTC instant (`endInstant`)
   - `amount_min`과 `amount_max` 둘 다 있고 `amount_min > amount_max` → throw `invalid_amount_range`
   - `date_start`와 `date_end` 둘 다 있고 `date_start > date_end` (string 비교로 안전) → throw `invalid_date_range`
2. category가 주어진 경우, Category 테이블에서 `name ILIKE category`(active만) lookup. 못 찾으면 빈 배열 즉시 반환 (throw 아님 — "Costco 카테고리에 거래 보여줘"에서 카테고리가 없을 때 LLM이 자연스럽게 처리할 수 있도록).
3. Prisma `where` 구성: 각 필터가 OR이고 서로 AND여야 하므로 **명시적 `AND` 배열에 nested OR 절을 담는다.** 단순히 같은 객체에 `OR`를 두 번 쓰면 두 번째가 첫 번째를 덮어쓴다.

   ```ts
   const andClauses: Prisma.TransactionWhereInput[] = [];

   if (merchantQuery) {
     andClauses.push({
       OR: [
         { merchantRaw: { contains: merchantQuery, mode: 'insensitive' } },
         { merchantNormalized: { contains: merchantQuery, mode: 'insensitive' } },
       ],
     });
   }

   if (amountMin != null && amountMax != null) {
     andClauses.push({
       OR: [
         { amount: { gte: amountMin, lte: amountMax } },    // 양수 구간
         { amount: { gte: -amountMax, lte: -amountMin } },  // 음수 구간
       ],
     });
   } else if (amountMin != null) {
     andClauses.push({
       OR: [{ amount: { gte: amountMin } }, { amount: { lte: -amountMin } }],
     });
   } else if (amountMax != null) {
     andClauses.push({ amount: { gte: -amountMax, lte: amountMax } });
   }

   if (categoryId) andClauses.push({ categoryId });
   if (startInstant || endInstant) {
     // startInstant/endInstant는 step 1에서 user-timezone 적용 후 UTC instant로 변환됨.
     // endOfDay()를 다시 적용하지 않는다 (이중 적용 시 기간이 ~1일 늘어남 — §3.3과 동일 패턴).
     andClauses.push({
       occurredAt: {
         ...(startInstant && { gte: startInstant }),
         ...(endInstant && { lte: endInstant }),
       },
     });
   }

   const where: Prisma.TransactionWhereInput = {
     workspaceId: ctx.workspaceId,
     removedAt: null,
     ...(andClauses.length > 0 ? { AND: andClauses } : {}),
   };
   ```
   - amount 매칭은 절댓값 기준 (부호 무관) — 양수=지출, 음수=환불.
4. `orderBy: { occurredAt: 'desc' }`, `take: limit ?? 20`
5. join: `category: { select: { name: true }}` — categoryName 추출
6. 매핑: Decimal → string, Date → ISO

**Tests:**

- 빈 필터 (기본 20건, 최신순)
- merchant_query case-insensitive 매칭
- amount_min/max 부호 무관 매칭 (지출 +150이 amount_min=100에 매칭되는지, 환불 -200이 amount_min=150에 매칭되는지)
- merchant_query + amount range 동시 적용 시 양쪽 OR이 AND로 결합되어 둘 다 충족되는 결과만 반환
- category 이름이 없는 경우 빈 배열
- date_start > date_end → throw invalid_date_range
- date_start = '2026-99-99' (정규식 통과, invalid 날짜) → throw invalid_date
- timezone 경계 regression: User.tz="America/Toronto"에서 date_end='2026-04-30'으로 Apr 30 23:59:59 local 거래 포함, May 1 00:00 local 거래 제외
- cross-workspace 누수 없음
- removedAt != null 제외

---

### 3.2 `detectRecurring`

**File:** `apps/api/src/chat/tools/detect-recurring.ts`

**Description (LLM-facing):**
> 최근 90일 거래 이력에서 정기 **결제**(구독, 월세, 보험료 등 사용자가 정기적으로 *지출*하는 항목)를 휴리스틱으로 추론한다. 같은 가맹점에서 일정 간격(월/주)으로 비슷한 금액이 반복되는 지출만 대상. 정기 입금/환불(예: 월급, 정기 환급)은 본 도구의 scope 밖이며 결과에 포함하지 않는다.

**Args:** `z.object({})` — zero-arg (adapter가 parametersJsonSchema 생략)

**Return type:**

```ts
type Result = Array<{
  merchantNormalized: string;     // grouping key
  merchantSample: string;         // 최근 거래의 merchantRaw (사람 친화 표시용)
  avgAmount: string;              // Decimal.toString(), 절댓값
  currency: string;
  cadence: "weekly" | "monthly";
  occurrenceCount: number;        // window 안에서 발생한 횟수
  lastDate: string;               // 'YYYY-MM-DD'
  expectedNextDate: string;       // 'YYYY-MM-DD'
}>;
```

`avgAmount` DESC 정렬.

**Implementation notes (heuristic):**

1. 최근 90일 (`occurredAt >= now() - 90d`), `workspaceId` 일치, `removedAt: null`, `merchantNormalized != null`, **`amount: { gt: 0 }` (지출만 — positive = expense)** 인 transaction을 모두 fetch. 음수 거래(환불/입금)는 정기 결제 정의상 제외.
2. `(merchantNormalized, currency)` 합성 key로 in-memory grouping (workspace당 거래량은 수천 단위 — DB raw GROUP BY 대신 JS grouping이 단순). 같은 가맹점에서 통화가 섞이는 경우는 드물지만, 섞이면 통화별로 별개 정기결제로 취급한다.
3. 각 group g에 대해:
   - `g.length >= 2` 미만이면 제외
   - `amounts = g.map(t => parseFloat(t.amount.toString()))` (모두 양수임, step 1에서 보장)
   - `mean = sum(amounts) / amounts.length`
   - `std = sqrt(sum((a - mean)^2) / amounts.length)` (모분산)
   - `cv = std / mean` — `cv > 0.20` 이면 제외 (금액 편차 큼)
   - 정렬된 `occurredAt`의 연속 차이 `gaps = [t1-t0, t2-t1, ...]` (단위: 일, ms / 86400000)
   - `avgGap = sum(gaps) / gaps.length`
   - `cadence`:
     - `avgGap ∈ [25, 35]` → "monthly"
     - `avgGap ∈ [6, 8]` → "weekly"
     - 그 외 → 제외
   - 통과한 그룹: 결과 record 생성
     - `lastDate` = `max(occurredAt)`의 YYYY-MM-DD
     - `expectedNextDate` = `lastDate + round(avgGap)` 일
     - `currency`는 group key의 currency (step 2에서 분리됨)
     - `merchantSample`은 `lastDate`의 transaction.merchantRaw
     - `avgAmount` 직렬화: JS number로 계산한 mean을 `new Prisma.Decimal(mean).toDecimalPlaces(2).toString()`로 변환 (소수점 2자리, 통화 형식 일관성). 이후 모든 비교/표시에 사용.
4. 결과 정렬: `avgAmount` DESC

**Edge cases:**

- 같은 merchant인데 currency가 섞인 경우: step 2의 합성 key로 자동 분리됨.
- merchantNormalized가 null인 거래: 그룹핑 불가 → 자동 제외 (위 fetch 필터에서 처리).
- workspace에 거래가 0건: 빈 배열 반환.
- 분산이 0(완벽히 동일한 금액)이고 `cv=0`이면 정상 통과.

**Tests:**

- 정확히 monthly한 Netflix 3건(amount > 0) → 결과 1건, cadence=monthly
- 같은 merchant인데 amount variance 큰 경우 → 제외
- weekly 가게(예: 출퇴근 길의 카페) → cadence=weekly
- 90일 밖의 거래는 무시
- removedAt != null 무시
- 음수 amount(환불/입금 — 예: 정기 월급 deposit) → 결과에 포함되지 않음
- cross-workspace 누수 없음
- 빈 workspace → 빈 배열

---

### 3.3 `comparePeriods`

**File:** `apps/api/src/chat/tools/compare-periods.ts`

**Description (LLM-facing):**
> 두 기간의 지출을 카테고리별 + 전체로 비교한다. 각 period는 preset 문자열(this_month, last_month, last_30_days, this_year, last_year) 또는 {start, end} ISO 날짜 객체로 지정. 양수 amount(지출)만 합산한다. 음수 amount(환불/입금)는 제외.

**Args:**

```ts
const periodPreset = z.enum([
  "this_month", "last_month", "last_30_days", "this_year", "last_year"
]);

const periodRange = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("기간 시작일(포함, ISO YYYY-MM-DD)."),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("기간 종료일(포함, ISO YYYY-MM-DD). start보다 같거나 이후."),
});

const periodArg = z.union([periodPreset, periodRange])
  .describe("preset string 또는 {start, end} 객체. preset 예: 'last_month'. range 예: {start:'2026-04-01', end:'2026-04-30'}.");

z.object({
  period_a: periodArg.describe("비교 기준 A (예: 이번 달, 지난 달)."),
  period_b: periodArg.describe("비교 대상 B (period_a와 대조됨)."),
})
```

**Return type:**

```ts
type Result = {
  currency: string;         // workspace primary currency (대부분 "CAD"). 본 plan은 단일 통화 가정. §2.5.1.
  periodA: { label: string; start: string; end: string; total: string };
  periodB: { label: string; start: string; end: string; total: string };
  totalDelta: string;       // B.total - A.total, signed string
  totalDeltaPct: number | null;  // null when A.total == 0
  byCategory: Array<{
    categoryId: string | null;  // null = Uncategorized
    categoryName: string;       // categoryId=null이면 "Uncategorized"
    aTotal: string;
    bTotal: string;
    delta: string;
    deltaPct: number | null;
  }>;
};
```

> `currency`는 workspace의 첫 active BankAccount의 currency를 사용(없으면 `"CAD"` 기본). 단일 통화 가정 (§2.5.1) — mixed-currency는 후속 plan.

`byCategory`는 `Math.max(|aTotal|, |bTotal|)` DESC 정렬.

**Implementation notes:**

1. Preset → {start, end} 해석:
   - **사용자 timezone 사용.** schema `User.tz` (default `"America/Toronto"`)가 이미 존재. `ctx.userId`로 lookup하여 해당 timezone에서 calendar 경계를 계산한다. (UTC server time만 쓰면 캐나다 동부 자정 ~ UTC 자정 사이 4-5시간 동안 `today`/`this_month` 답이 어긋난다.)
   - 구현 도구: `Intl.DateTimeFormat` + zone-aware Date 산술, 또는 `luxon`(이미 deps에 있다면) / `date-fns-tz`. 어느 쪽이든 다음 의미를 지킨다:
     - `this_month` = user-local [이번 달 1일 00:00, user-local 현재 시각]
     - `last_month` = user-local [지난 달 1일 00:00, 지난 달 말일 23:59:59.999]
     - `last_30_days` = user-local [오늘 - 30일 00:00, 현재 시각]
     - `this_year` = user-local [올해 1월 1일 00:00, 현재 시각]
     - `last_year` = user-local [작년 1월 1일 00:00, 작년 12월 31일 23:59:59.999]
   - 결과 Date 객체는 UTC로 변환된 instant (Prisma `occurredAt` 비교용).
   - User 조회 실패 / `tz` 비정상 값 → fallback `"America/Toronto"` (schema default와 동일).
2. range 케이스: `start`, `end` 각각 `parseStrictDate(...)` 검증 (invalid 캘린더 날짜 차단). user `tz`의 0시 ~ 23:59:59.999 instant로 변환. `start > end` → throw `invalid_period`.
3. 두 period 모두 해석 후 단일 Prisma query 두 번 (period_a, period_b 각각):
   - step 1/2에서 이미 `startInstant`(user-local 0시의 UTC instant)와 `endInstant`(UTC instant)로 변환되어 있음. `endInstant`의 의미는 preset에 따라 다름:
     - **closed presets** (`last_month`, `last_year`, custom range): user-local 23:59:59.999의 UTC instant
     - **current presets** (`this_month`, `this_year`, `last_30_days`): 현재 instant (`new Date()`) — "지금까지" 의미
   - **추가로 `endOfDay()`를 다시 적용하지 않는다** — 이중 적용 시 기간이 거의 하루 늘어남(예: America/Toronto `last_month` end = Apr 30 local 23:59:59.999 → May 1 03:59:59.999Z. 여기에 UTC endOfDay 다시 씌우면 May 1 거의 전체 포함).
   - `where: { workspaceId, removedAt: null, occurredAt: { gte: startInstant, lte: endInstant }, amount: { gt: 0 } }` — 양수(지출)만. (코드 컨벤션: positive amount = expense, negative = income/refund)
   - `groupBy: ['categoryId']`, `_sum: { amount: true }`
4. groupBy 결과에서 카테고리 lookup:
   ```ts
   const allCategoryIdsOrNull = unique([...aGroups, ...bGroups].map(g => g.categoryId));
   const nonNullIds = allCategoryIdsOrNull.filter((id): id is string => id !== null);
   const categoryRows = nonNullIds.length > 0
     ? await prisma.category.findMany({
         where: { workspaceId: ctx.workspaceId, id: { in: nonNullIds } },
         select: { id: true, name: true },
       })
     : [];
   const nameById = new Map(categoryRows.map(r => [r.id, r.name]));
   ```
   byCategory의 키는 `categoryId`(string 또는 null)로 잡고, `categoryName`은 lookup 결과로 채운다.
5. categoryId가 null인 그룹은 `categoryId: null, categoryName: "Uncategorized"`로 라벨. (null을 Prisma `id: { in: [...] }`에 넣지 않는다 — 타입 에러.)
6. 합계: 양 period 모두 양수로 그대로 합산 (음수 거래는 step 3 필터에서 이미 제외됨). delta는 `bTotal - aTotal`.
7. deltaPct: `aTotal === 0`이면 null, 아니면 `((bTotal - aTotal) / aTotal) * 100`, 소수점 1자리 반올림.
8. label은 preset이면 preset 이름, range면 `"2026-04-01 to 2026-04-30"`.

**Edge cases:**

- 두 period가 동일하게 풀이되어도 그대로 진행 (totalDelta=0).
- period_a/b에 거래 0건 → total="0", byCategory 빈 배열 가능.
- aTotal=0 && bTotal>0 → deltaPct null, 클라이언트(LLM)가 "0에서 새로 발생" 해석.

**Tests:**

- preset 5종 (this_month / last_month / last_30_days / this_year / last_year) + custom range가 올바르게 해석되는지
- timezone 경계 regression: User.tz="America/Toronto", `last_month`로 Apr 30 23:59:59.999 local 거래는 포함, May 1 00:00:00 local 거래는 제외 (UTC instant로는 모두 May 1 zh 시간대지만 user-local로 분기)
- range start='2026-02-31' (정규식 통과, invalid 캘린더) → throw invalid_date
- 카테고리별 정렬이 max(|a|,|b|) DESC인지
- categoryId null이 "Uncategorized"로 묶이는지
- aTotal=0 시 deltaPct null
- amount < 0 (환불/입금) 제외 확인
- range invalid → throw

---

### 3.4 `listAccounts`

**File:** `apps/api/src/chat/tools/list-accounts.ts`

**Description (LLM-facing):**
> 사용자의 활성(active) 은행 계좌 목록과 잔액을 반환한다. archived/closed/hidden 계좌는 제외. 잔액은 Plaid 동기화 시점 기준이며 실시간이 아니다.

**Args:** `z.object({})` — zero-arg.

**Return type:**

```ts
type Result = Array<{
  id: string;
  name: string;
  type: string;            // "depository" | "credit" | "loan" | "investment" | "other"
  subtype: string | null;  // "checking" | "savings" | "credit_card" | ...
  currency: string;
  balanceCurrent: string | null;     // Decimal.toString()
  balanceAvailable: string | null;
  balanceLimit: string | null;       // 신용 한도 (credit account에서만 의미)
  lastBalanceSyncAt: string | null;  // ISO 8601, 마지막 Plaid 잔액 동기화 시각. LLM이 stale 여부를 사용자에게 안내할 때 사용.
}>;
```

정렬: `type` ASC, then `name` ASC.

> **AccountStatus enum (참고):** `active | closed | hidden`. 본 tool은 `archivedAt: null` 그리고 `status: 'active'`만 반환하므로 결과에 status 필드 자체는 불필요. (PlaidItem의 `active | error | relink_required | disconnected`는 별개 enum이며 본 tool에는 노출하지 않음 — 별도 plan에서 다룰 수 있음.)

**Implementation notes:**

1. `prisma.bankAccount.findMany({ where: { workspaceId, archivedAt: null, status: 'active' }, orderBy: [{ type: 'asc' }, { name: 'asc' }]})`
2. 매핑: Decimal → string (또는 null 보존). `lastBalanceSyncAt` Date → ISO 8601 (null 보존).
3. `balanceLimit`은 credit account가 아니면 보통 null — 그대로 통과.

**Tests:**

- archivedAt이 있는 계좌는 제외
- status='closed'/'hidden' 계좌는 제외
- 정렬이 type → name인지
- cross-workspace 누수 없음
- balanceCurrent가 null인 계좌도 정상 반환 (string|null contract)

---

### 3.5 `createCategory`

**File:** `apps/api/src/chat/tools/create-category.ts`

**Description (LLM-facing):**
> 새 카테고리를 만든다. 같은 이름의 활성 카테고리가 이미 있으면 에러. parent_name이 주어지면 sub-category로, 없으면 최상위 카테고리로 생성. 활성 카테고리는 워크스페이스당 30개까지만 허용.

> **권한 정책:** HTTP `POST /workspaces/:id/categories` 라우트는 owner-only이지만, **chat tool에서는 editor 이상 허용**한다. chat 자체가 editor required이므로 자연스럽게 일치. 이 차이는 의도된 정책 — chat은 "내가 새 카테고리 만들어줘"라는 자연어 요청을 지원하는 인터페이스로, owner의 신중한 검토가 필요한 mass operation(예: rename/archive)과는 결이 다르다. 단 cap(30)과 이름 길이(40)는 공통 적용.

**Args:**

```ts
z.object({
  name: z.string().max(80)
    .describe("새 카테고리 이름. trim 후 1-40자(코드의 MAX_NAME_LEN 일치). 이미 같은 이름의 활성 카테고리가 있으면 'category_exists' 에러."),
  parent_name: z.string().max(80).optional()
    .describe("부모 카테고리 이름(있으면 sub-category로 생성). 정확 일치 + 대소문자 무시. 못 찾으면 'parent_not_found' 에러."),
})
```

> Zod schema는 max만 강하게 제한 (LLM이 100자 문장 전체를 name으로 넣는 사고 방지). 실제 1-40자 검증은 run 안에서 trim 후 수행하여 `invalid_name`/`name_too_long`을 도메인 에러로 throw.

**Return type:**

```ts
type Result = {
  id: string;
  name: string;
  parentId: string | null;
};
```

**Implementation notes:**

1. 입력 정규화: `name = input.name.trim()`, `parentName = input.parent_name?.trim()`
2. 이름 검증: `name.length === 0` → throw `invalid_name`; `name.length > 40` → throw `name_too_long`.
3. Cap 확인: `prisma.category.count({ where: { workspaceId, archivedAt: null }})` ≥ 30 → throw `category_cap_reached`. (코드 상수 `MAX_ACTIVE_CATEGORIES = 30`와 일치.)
4. 중복 check: `Category.findFirst({ where: { workspaceId, name: { equals: name, mode: 'insensitive' }, archivedAt: null }})` — 존재 시 throw `category_exists`.
5. parent 확인 (있는 경우): `Category.findFirst({ where: { workspaceId, name: { equals: parentName, mode: 'insensitive' }, archivedAt: null }})` — null이면 throw `parent_not_found`.
6. `Category.create({ data: { workspaceId, name, parentId: parent?.id ?? null }})`.
7. 반환: id, name, parentId.

**Edge cases:**

- name = "  Food  " (앞뒤 공백) → trim 후 검증.
- archived 카테고리와 같은 이름은 허용 (archivedAt != null은 중복 check 대상 아님).
- 중복 check와 create 사이 race condition: 본 plan 범위 외. `@@unique([workspaceId, name])` 스키마 인덱스 추가는 별도 plan에서 다룬다.
- 중첩 sub-category (parent가 이미 sub-category인 경우): 본 plan은 깊이 제한 두지 않음 (Category 모델 자체에는 self-referential `parentId`만 있음 — 깊이 검증은 schema/route 어디에도 없음. chat tool도 동일).
- HTTP `POST /workspaces/:id/categories`는 현재 `{ name }`만 받고 parent 미지원. chat tool의 `parent_name`은 chat 한정 신규 capability (Category 모델은 이미 parentId 필드를 갖고 있어 데이터 호환).

**Tests:**

- 평범한 생성 → 성공
- 대소문자만 다른 중복 → throw category_exists
- trim 후 빈 string → throw invalid_name
- trim 후 41자 → throw name_too_long
- 활성 카테고리 30개 초과 상태 → throw category_cap_reached
- parent_name 없으면 parentId=null
- parent_name 있으면 parentId 매핑
- parent_name이 archived → throw parent_not_found
- cross-workspace: 다른 workspace의 동명 카테고리는 중복 아님

---

### 3.6 `addTransactionNote`

**File:** `apps/api/src/chat/tools/add-transaction-note.ts`

**Description (LLM-facing):**
> 거래에 메모를 덮어쓴다(기존 메모는 사라짐). 메모는 1~500자, 빈 문자열 불가. 메모를 지우려면 모바일 앱 UI를 사용하라.

**Args:**

```ts
z.object({
  tx_id: z.string().min(1)
    .describe("거래 ID. listTransactions/findTransactions의 결과 id를 사용. (getSpendingSummary는 그룹 합계만 반환하므로 id 없음.)"),
  note: z.string()
    .describe("새 메모. trim 후 1-500자. 기존 메모를 덮어쓴다. 줄바꿈 허용. 빈 문자열 또는 공백-only는 'note_required' 에러."),
})
```

> Zod schema에서 note의 min/max를 강제하지 않는다. min(1)을 두면 빈 문자열이 디스패처 단의 `invalid_args`로 거부되어 `note_required` 도메인 에러를 LLM에 전달할 수 없다. 길이 검증은 모두 `run()` 내부에서 수행.

**Return type:**

```ts
type Result = { id: string; note: string };
```

**Implementation notes:**

1. `trimmed = input.note.trim()` — `trimmed.length === 0` → throw `note_required`. `trimmed.length > 500` → throw `note_too_long`.
2. **워크스페이스-범위 atomic update.** `Transaction.findFirst({ where: { id }})` 후 `update({ where: { id }})`는 (a) workspace 검증이 빠지고 (b) 조회와 쓰기 사이 race(다른 trans가 soft-delete)가 가능하다. `updateMany`로 한 번에 처리한다:
   ```ts
   const { count } = await prisma.transaction.updateMany({
     where: { id: input.tx_id, workspaceId: ctx.workspaceId, removedAt: null },
     data: { note: trimmed },
   });
   if (count === 0) throw new Error('tx_not_found');
   ```
   `count === 0`은 (a) 거래가 없거나 (b) 다른 workspace 거래거나 (c) `removedAt != null`인 경우. 셋 다 LLM에 동일하게 `tx_not_found`로 전달하여 info-leak 방지.
3. 반환: `{ id: input.tx_id, note: trimmed }` (update 후 다시 fetch할 필요 없음 — note는 우리가 방금 쓴 값).

**Edge cases:**

- removedAt != null인 거래에는 작성 거부 (휴지통 안 거래는 read만).
- note에 줄바꿈 / 이모지 허용 (검열 없음).

**Tests:**

- 정상 작성 → success
- 빈 string / whitespace only → throw note_required (dispatcher의 invalid_args가 아님 — Zod가 허용해야 함)
- 501자 입력 → throw note_too_long
- 존재하지 않는 tx_id → throw tx_not_found
- 다른 workspace의 tx_id → throw tx_not_found (정확히 같은 코드 — info leak 방지)
- removedAt != null인 tx_id → throw tx_not_found (write 거부)
- 기존 note 덮어쓰기 확인

---

### 3.7 `getTransactionDetails`

**File:** `apps/api/src/chat/tools/get-transaction-details.ts`

**Description (LLM-facing):**
> 단일 거래의 모든 상세 정보를 반환한다(거래 + 계좌 + 카테고리 + 메타데이터). 거래 ID로 조회. removedAt이 있어도 정보는 반환 (휴지통 거래 조회 가능).

**Args:**

```ts
z.object({
  tx_id: z.string().min(1)
    .describe("거래 ID. 다른 tool의 결과 id를 사용."),
})
```

**Return type:**

```ts
type Result = {
  id: string;
  amount: string;
  currency: string;
  merchantRaw: string;
  merchantNormalized: string | null;
  occurredAt: string;        // ISO 8601 full
  pending: boolean;
  source: string;            // "plaid" | "manual" 등 schema enum 값
  note: string | null;
  categorizationSource: "mapping" | "ai" | "manual" | null;
  removedAt: string | null;  // ISO 8601 full, 휴지통이 아니면 null
  account: {
    id: string;
    name: string;
    type: string;
    subtype: string | null;
  };
  category: {
    id: string;
    name: string;
    parentName: string | null;   // parent.name (있으면)
  } | null;
};
```

**Implementation notes:**

1. `Transaction.findFirst({ where: { id: tx_id, workspaceId }, include: { account: true, category: { include: { parent: true }}}})`.
2. null이면 throw `tx_not_found`.
3. 매핑:
   - `category`가 null이면 결과 `category: null`
   - `category.parent`가 null이면 `parentName: null`
4. Decimal → string, Date → ISO.

**Edge cases:**

- removedAt != null인 거래도 정상 반환 (read는 허용).
- account가 archivedAt != null (계좌 보관됨)이어도 정보는 반환 (이름 등은 변경 없음).
- category가 archivedAt != null이어도 join 결과로 이름 반환 (히스토리 보존).

**Tests:**

- active 거래 정상 반환
- removedAt 있는 거래도 반환 (removedAt 필드에 ISO 표시)
- category=null인 미분류 거래
- account/category가 archived여도 정보 표시
- 다른 workspace tx_id → throw tx_not_found
- 존재하지 않는 tx_id → throw tx_not_found

---

## 4. Registry update

`apps/api/src/chat/tools/index.ts` — 기존 import들이 `.js` 확장자를 쓰고 각 entry는 `as ToolDef`로 캐스팅된다. 신규 import도 동일하게 한다:

```ts
import { findTransactions } from "./find-transactions.js";
import { detectRecurring } from "./detect-recurring.js";
import { comparePeriods } from "./compare-periods.js";
import { listAccounts } from "./list-accounts.js";
import { createCategory } from "./create-category.js";
import { addTransactionNote } from "./add-transaction-note.js";
import { getTransactionDetails } from "./get-transaction-details.js";

export const REGISTRY: ToolDef[] = [
  // 기존 4개
  listTransactions as ToolDef,
  getSpendingSummary as ToolDef,
  listCategories as ToolDef,
  categorizeTransaction as ToolDef,
  // Plan 1E-next
  findTransactions as ToolDef,
  detectRecurring as ToolDef,
  comparePeriods as ToolDef,
  listAccounts as ToolDef,
  createCategory as ToolDef,
  addTransactionNote as ToolDef,
  getTransactionDetails as ToolDef,
];
```

> `ToolDef<TArgs, TResult>`가 generic이라 strict mode에서 generic-erased `ToolDef[]`에 직접 assign 시 contravariant `run`의 args 타입이 충돌한다. 기존 코드 컨벤션을 따라 entry당 `as ToolDef`로 명시 캐스트.

---

## 5. Implementation order (suggested)

작은 의존성부터 큰 것 순:

1. `listAccounts` — zero-arg, 단순 select
2. `getTransactionDetails` — 단순 lookup + join
3. `createCategory` — write이지만 외부 의존 없음
4. `addTransactionNote` — 단순 write
5. `findTransactions` — 필터 다수, 검증 필요
6. `comparePeriods` — period preset 해석 + groupBy
7. `detectRecurring` — 알고리즘 무거움, 마지막

각 tool은 (1) 파일 작성 (2) registry 등록 (3) vitest 통합 테스트 (4) 다음 tool로 진행.

---

## 6. Out-of-scope / 후속 plan 후보

이 spec에서 다루지 않은 것들 (의도적):

- **시간대 처리 라이브러리 선택**: comparePeriods는 `User.tz`로 preset을 해석. 구체 라이브러리(luxon vs Intl.DateTimeFormat vs date-fns-tz)는 implementation에서 결정.
- **Transactions storage 정책**: Plaid date-only 거래를 user-timezone과 정합되게 저장하는 방식은 별도 plan (§2.5.0 참조).
- **카테고리 unique 제약**: `@@unique([workspaceId, name])`을 추가하면 createCategory의 race condition 차단 가능 — schema 변경 plan에서.
- **Pagination**: findTransactions의 limit 50 캡 너머는 후속 (cursor 기반).
- **검색 강화**: full-text search, fuzzy matching — 후속.
- **자동 카테고리화 후 알림**: addTransactionNote / categorizeTransaction이 변경 사항을 다른 user에게 알림 보내는 기능 — 후속 collaboration plan.
- **detectRecurring 학습**: 사용자가 "이건 정기 아님" 표시 → 학습 → 다음 호출 시 제외. 후속 plan.

---

## 7. Self-review log

이 variant는 Opus가 spec을 작성하고 Codex가 외부에서 review를 수행하는 워크플로우다.

### Round 0 — Opus 사전 self-review (Codex 호출 전)

**Important: 3 / Critical: 0 / Minor: 0**

Codex에게 보내기 전 작성자가 fresh-eye self-review로 잡은 이슈들.

- [3.1] findTransactions amount range Prisma 식이 모호함 → 둘 다/min만/max만 케이스를 분리해 명시적으로 표기.
- [3.2] detectRecurring currency 처리가 Edge case 섹션에만 있어 step에 미반영 → step 2의 grouping key를 `(merchantNormalized, currency)` 합성 key로 명시.
- [3.3] comparePeriods byCategory에 categoryId가 없음 → 동명 카테고리 매칭 안전 위해 `categoryId: string | null` 필드 추가.

### Round 1 — Codex external review

**Critical: 1 / Important: 8 / Minor: 2**

전체 결과는 `/tmp/codex-review-result.md`(세션 산출물). 요약과 fix는 아래.

**Critical:**
- [§4] Registry import 경로가 `.js` 확장자 없음 → 기존 코드 컨벤션(`./xxx.js`) 일치하도록 7개 import 모두 수정.

**Important:**
1. [§3.1, 3.3] amount sign convention 반대 — 실제 코드(`apps/api/src/categorize/llm.ts:58`)는 "positive = expense, negative = income/refund". → comparePeriods의 `amount: { lt: 0 }`을 `amount: { gt: 0 }`로 변경, findTransactions return 코멘트 및 테스트 시나리오 정정.
2. [§3.5] createCategory가 기존 카테고리 라우트 정책과 충돌 — 라우트는 owner-only + name 40자 + 활성 30개 cap. → 정책 결정: chat tool은 editor 이상 허용(의도된 분기), name max를 spec 80 → 40로 정정, `category_cap_reached` 도메인 에러와 활성 카테고리 카운트 단계 추가. 권한 분기를 명시 박스로 문서화.
3. [§3.4] listAccounts status enum 실제 schema와 불일치 — 실제 `AccountStatus = active|closed|hidden`이고 `disconnected|error`는 PlaidItemStatus. → 결과 타입에서 `status` 필드 제거, 별도 참고 박스로 두 enum의 차이를 명시.
4. [§2.6, 3.7] removedAt 처리 모순 — 표준 규약은 "tx_not_found"인데 getTransactionDetails는 removed도 반환. → 2.6에 "도구별 removedAt 처리 규약"을 추가하여 write/read/aggregate별로 분기 명시.
5. [§2.6, 3.3, 3.6] 일부 도메인 에러가 unreachable — Zod min(1) 등이 먼저 reject해서 도메인 에러 throw 불가. → addTransactionNote의 note는 zod 길이 제한 제거, run 내 trim 후 `note_required`/`note_too_long`로 throw. 2.6에 "Zod parse 실패 vs 도메인 에러" 박스 추가.
6. [§3.1] Multiple OR 필터 underspecified — merchant_query OR과 amount range OR을 단순 spread하면 두 번째가 첫 번째를 덮어씀. → 명시적 `AND: [...]` 배열에 nested OR을 담는 Prisma 패턴으로 코드 예시 명시.
7. [§3.1, 3.3] Date regex가 invalid 캘린더 통과 — `2026-99-99`/`2026-02-31`도 정규식 통과. → 2.6에 `parseStrictDate` 헬퍼 정의, findTransactions/comparePeriods에서 모두 사용 + 테스트 케이스 추가.
8. [§3.3] comparePeriods의 null categoryId 처리 — Prisma `id: { in: [...] }`에 null 못 넣음. → step 4를 nullable id filter + non-null만 query 패턴으로 재작성, null은 별도 "Uncategorized" 라벨.

**Minor:**
- [3.6] addTransactionNote args description에서 `getSpendingSummary`를 id 출처로 언급 — getSpendingSummary는 그룹 합계만 반환. → description에서 제거.
- [3.3] comparePeriods 테스트 노트가 "preset 4종"이지만 5개 정의. → "preset 5종"으로 정정.

### Round 1 fix 확인

- Critical: 1 → **0**
- Important: 8 → **0**
- Minor: 2 → **0**

### Round 2 — Codex external review (post-Round 1 fix verification)

**Critical: 1 / Important: 3 / Minor: 2** (Round 1 issue 11건은 모두 VERIFIED FIXED.)

전체 결과는 `/tmp/codex-review-r2-result.md`. Round 2 newly found 이슈와 fix:

**Critical:**
- [§4] Registry snippet에서 `as ToolDef` 캐스트가 빠져 generic 타입 호환성 실패 위험 — 기존 코드(`apps/api/src/chat/tools/index.ts`)는 각 entry를 `as ToolDef`로 캐스트한다. → 신규 7개 entry 모두에 `as ToolDef` 추가 + 그 이유를 명시 박스로 보충.

**Important:**
1. [§3.1, §3.3] amount 필터/합계의 currency 모호성 — `Transaction.currency`가 schema에 있는데 spec은 CAD 전제. mixed-currency workspace는 잘못된 결과 가능. → §2.5.1 **통화 가정** 섹션 신설. 단일 통화 workspace 가정 명시 + 도구별 currency 노출 규칙. findTransactions의 amount_min/max description은 "native currency 기준" 으로 정정. comparePeriods 결과에 `currency` 필드 추가.
2. [§2.2, §3.6] addTransactionNote update가 workspace/removed 비스코프 — `findFirst` + `update({ where: { id }})` 사이 race + workspace 누수 위험. → `updateMany({ where: { id, workspaceId, removedAt: null }})` + `count === 0` 체크 패턴으로 atomic하게 재작성.
3. [§3.4] listAccounts에 `lastBalanceSyncAt` 누락 — schema에 있는 freshness 정보를 LLM이 활용 불가. → Result 타입과 매핑 step에 `lastBalanceSyncAt: string | null` 추가.

**Minor:**
- [§3.2] detectRecurring `avgAmount` 직렬화 미명시 — JS number mean을 Decimal로 어떻게 변환할지 불명확. → `new Prisma.Decimal(mean).toDecimalPlaces(2).toString()` 명시.
- [§3.5] "HTTP route와 동일 동작" 표현이 부정확 — 실제 HTTP `POST /categories`는 parent 미지원. → 표현 수정. parent_name이 chat 한정 신규 capability임을 명시.

### Round 2 fix 확인

- Newly found Critical: 1 → **0**
- Newly found Important: 3 → **0**
- Newly found Minor: 2 → **0**

### Round 3 — Codex confirmation review

**Critical: 0 / Important: 2 / Minor: 0**

Round 2 이슈 6건은 모두 VERIFIED FIXED. 새로 발견된 2건:

**Important:**
1. [§3.3 comparePeriods timezone] `User.tz` 필드가 schema에 이미 존재(`default "America/Toronto"`)하는데 spec은 server UTC로 preset을 해석. 캐나다 동부 자정 ~ UTC 자정 사이 4-5시간 동안 `today`/`this_month` 답이 어긋남. → step 1을 user-timezone 기반 calendar 산술로 재작성. `ctx.userId` → `User.tz` lookup → 해당 zone에서 month/day 경계 계산. 라이브러리 선택은 implementation 자유(Intl/luxon/date-fns-tz).
2. [§3.2 detectRecurring sign] `abs(amount)` 처리로 음수(환불/정기 입금)도 "구독"으로 잡힘. → 정기 *지출*만으로 scope 재정의. step 1 fetch에 `amount: { gt: 0 }` 추가, description 표현도 "정기 결제(지출)"로 좁힘. 음수 거래 제외 test 추가.

### Round 3 fix 확인

- Newly found Critical: 0 → **0**
- Newly found Important: 2 → **0**
- Newly found Minor: 0 → **0**

### Round 4 — Codex confirmation review

**Critical: 0 / Important: 1 / Minor: 0**

Round 3 #2 (detectRecurring sign) VERIFIED FIXED. Round 3 #1 (comparePeriods timezone)은 **NEW PROBLEM** 도입: step 1/2에서 이미 user-local 경계를 UTC instant로 변환했는데, step 3에서 `lte: endOfDay(end)`를 여전히 적용하여 기간이 ~1일 늘어남.

**Important:**
1. [§3.3 comparePeriods] step 3에서 `endOfDay(end)` 이중 적용 — Round 3 timezone fix 후 endInstant는 이미 user-local 23:59:59.999의 UTC instant. 또 한 번 UTC endOfDay를 씌우면 다음 날 거의 전체가 포함됨. → step 3을 `{ gte: startInstant, lte: endInstant }`로 정정 + timezone 경계 regression test 추가.

### Round 4 fix 확인

- Newly found Critical: 0 → **0**
- Newly found Important: 1 → **0**
- Newly found Minor: 0 → **0**

### Round 5 — Codex confirmation review

**Critical: 0 / Important: 1 / Minor: 1**

Round 4 fix VERIFIED FIXED. 새로 발견된 이슈:

**Important:**
1. [§3.1 findTransactions date filters] Round 3 timezone fix가 comparePeriods에만 적용되었고 findTransactions의 date_start/date_end는 여전히 UTC + endOfDay 처리. user-local 자정 근처 거래 잘못 분류. → §3.1 step 1에 동일 user-timezone 변환 적용. step 3 Prisma where에서 `endOfDay()` 제거하고 `startInstant`/`endInstant` 사용. timezone 경계 regression test 추가.

**Minor:**
1. [§3.3 wording] step 3에서 `endInstant`를 "user-local 23:59:59.999"로만 설명했지만 current-period preset(`this_month` 등)에서는 현재 instant. → endInstant 의미를 closed-preset vs current-preset으로 분기 설명.

### Round 5 fix 확인

- Newly found Critical: 0 → **0**
- Newly found Important: 1 → **0**
- Newly found Minor: 1 → **0**

### Round 6 — Codex confirmation review

**Critical: 0 / Important: 1 / Minor: 1**

Round 5 Minor VERIFIED FIXED. Round 5 Important은 fix landed이지만 그 fix가 더 깊은 데이터 레이어 이슈를 노출.

**Important:**
1. [§3.1, §3.3 timezone fix exposes Plaid storage] `apps/api/src/plaid/sync.ts`가 date-only Plaid 거래를 `new Date("YYYY-MM-DD")` → UTC midnight으로 저장. user-timezone 필터 적용 시 America/Toronto에서 `2026-05-01` Plaid 거래가 Apr 30 20:00 local로 분류되어 user-local April 필터에 잡힘. → 본 plan은 신규 chat tools 도입이며 transactions storage 정책 변경은 별도 plan. **§2.5.0 "알려진 한계" 섹션 신설**하여 정책 결정과 LLM 응답 품질 영향 평가를 명시. 본 plan은 user-timezone 필터를 그대로 도입하고, storage 정책 plan에서 boundary mismatch 해소.

**Minor:**
1. [§2.6 invalid_period] periodRange의 zod가 start/end를 둘 다 required로 정의해서 누락은 dispatcher의 `invalid_args`로 거부됨. → `invalid_period` 정의에서 "누락" 제거, "start > end만" 으로 한정.

### Round 6 fix 확인

- Newly found Critical: 0 → **0**
- Newly found Important: 1 → **0** (정책 결정 명시로 해소)
- Newly found Minor: 1 → **0**

### Exit condition

Round 1 (1C+8I+2m) → Round 2 (1C+3I+2m) → Round 3 (0C+2I+0m) → Round 4 (0C+1I+0m) → Round 5 (0C+1I+1m) → Round 6 (0C+1I+1m) → fix 적용. **Round 7 final confirmation pending.** Round 7에서 0/0 나오면 production-ready.

---

## 8. Open questions

(현재 시점에서 답이 정해지지 않은 사항)

- **createCategory chat-tool 정책 변경의 후속 영향**: chat에서 editor가 카테고리를 만들 수 있게 되므로, HTTP `POST /workspaces/:id/categories`의 owner-only 정책과 의도된 분기가 된다. 모바일 UI에서 "내가 만든 카테고리" 표시 시 created-via metadata가 필요한지는 후속 plan에서 결정.
