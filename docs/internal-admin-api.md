# Fina Internal Admin API

외부 관리자 애플리케이션에서 Fina 사용자, transaction, chat 내용을 조회하기 위한 서버 간 API 계약이다.

이 문서의 모든 endpoint는 `{FINA_API_BASE_URL}/internal/admin` 아래에 있으며 읽기 전용이다. Fina 웹의 `/admin/*` endpoint나 Better Auth cookie를 사용하지 않는다.

## 1. 권장 호출 구조

```text
Admin browser
  -> External admin backend
       -> short-lived delegated JWT 생성
       -> Fina /internal/admin/* 호출
  <- External admin backend가 필요한 응답 전달
```

delegated JWT의 private key와 bearer token을 브라우저 bundle, localStorage, cookie에 저장하지 않는다. 외부 관리자 backend에서만 token을 생성하고 Fina API를 호출한다.

모든 응답은 `Cache-Control: no-store`다. 외부 관리자 backend와 frontend에서도 사용자 금융·대화 응답을 shared cache에 저장하지 않는 것을 권장한다.

## 2. 인증

모든 요청에 다음 header가 필요하다.

```http
Authorization: Bearer <delegated-jwt>
X-Request-Id: <uuid>
```

`X-Request-Id`는 선택 사항이지만 외부 관리자와 Fina의 감사 로그를 연결할 수 있도록 요청마다 UUID를 보내는 것을 권장한다.

JWT 요구사항:

| 항목             | 값                                                  |
| ---------------- | --------------------------------------------------- |
| 서명 알고리즘    | `EdDSA`                                             |
| protected header | 등록된 `kid` 필수                                   |
| `iss`            | Fina의 `ADMIN_TOKEN_ISSUER`와 동일                  |
| `aud`            | `fina-admin-api`                                    |
| `email`          | Fina의 `ADMIN_EMAIL`과 동일                         |
| `scope`          | `admin:read`                                        |
| 필수 claim       | `sub`, `jti`, `iat`, `nbf`, `exp`, `email`, `scope` |
| 유효시간         | `exp - iat` 최대 60초                               |
| 시간 조건        | `nbf === iat`, `exp > iat`                          |

claim 예시:

```json
{
  "iss": "https://admin.example.com",
  "aud": "fina-admin-api",
  "sub": "admin-user-or-service-id",
  "jti": "unique-request-token-id",
  "email": "configured-admin@example.com",
  "scope": "admin:read",
  "iat": 1785888000,
  "nbf": 1785888000,
  "exp": 1785888060
}
```

기존 사용자 목록 API에 사용 중인 delegated token 생성 로직을 그대로 사용하면 된다.

## 3. Endpoint 목록

| 용도                         | Method | Path                                                            |
| ---------------------------- | ------ | --------------------------------------------------------------- |
| Plaid Item 과금 상태         | `GET`  | `/internal/admin/plaid-items`                                   |
| 사용자 목록                  | `GET`  | `/internal/admin/users`                                         |
| 사용자 상세·활동 요약        | `GET`  | `/internal/admin/users/:userId`                                 |
| 사용자 접근 가능 transaction | `GET`  | `/internal/admin/users/:userId/transactions`                    |
| 사용자 chat thread 목록      | `GET`  | `/internal/admin/users/:userId/chat-threads`                    |
| 선택한 thread의 message      | `GET`  | `/internal/admin/users/:userId/chat-threads/:threadId/messages` |

권장 화면 흐름:

1. Plaid monitoring 화면에서는 `/internal/admin/plaid-items`를 요청한다.
2. 사용자 목록을 가져온다.
3. 사용자를 선택하면 사용자 상세, transaction 첫 페이지, chat thread 목록을 병렬로 요청한다.
4. chat thread를 선택했을 때 해당 thread의 message 첫 페이지를 요청한다.
5. transaction의 `nextCursor`는 다음 페이지를 목록 뒤에 붙인다.
6. message의 `nextCursor`는 이전 message 페이지이므로 기존 목록 앞에 붙인다.

### 기존 사용자 endpoint

사용자 목록:

```http
GET /internal/admin/users?environment=production&limit=50&cursor=<opaque>
```

- `environment`: `production | test | unknown | all`, 기본값은 `production`
- 정렬: 가입 시각 최신순
- 응답: `users`, `summary`, `nextCursor`
- `summary`는 현재 페이지가 아닌 선택한 environment 전체의 사용자·구독 요약이다.

사용자 상세:

```http
GET /internal/admin/users/:userId
```

응답에는 사용자 기본 정보와 device/session, Plaid 계좌 상태, activity count, 월별 AI usage가 포함된다. Transaction 원문과 chat message는 상세 응답에 포함되지 않으므로 아래 전용 endpoint로 별도 조회한다.

기존 client 타입은 각각 `AdminUsersResponse`, `AdminUserDetailDTO`이며 `@fina/shared`에서 export된다.

### Plaid Item monitoring

```http
GET /internal/admin/plaid-items
```

query와 pagination은 없다. Fina DB에 저장된 각 Item의 암호화된 access token으로 Plaid `/item/get`을 실시간 호출한 결과이므로, 화면 진입 또는 사용자의 명시적인 새로고침 때 호출한다. access token은 응답에 포함되지 않는다.

```ts
type AdminPlaidItemsResponse = {
  environment: "sandbox" | "production";
  checkedAt: string;
  summary: {
    trackedItemCount: number;
    reachableItemCount: number;
    transactionsBilledItemCount: number;
    missingItemCount: number;
    checkFailedItemCount: number;
  };
  items: Array<{
    id: string;
    itemId: string;
    institutionName: string;
    localStatus: string;
    plaidStatus: "reachable" | "missing" | "error";
    plaidErrorCode: string | null;
    billedProducts: string[];
    lastPlaidUpdateAt: string | null;
    lastLocalSyncAt: string | null;
    billingGraceEndsAt: string | null;
    createdAt: string;
    accountCount: number;
    workspace: { id: string; name: string };
    user: { id: string; email: string } | null;
  }>;
};
```

요약 필드 의미:

| 필드                          | 의미                                                        |
| ----------------------------- | ----------------------------------------------------------- |
| `trackedItemCount`            | Fina DB에 남아 있어 확인을 시도한 Item 수                   |
| `reachableItemCount`          | Plaid `/item/get`에 성공한 Item 수                          |
| `transactionsBilledItemCount` | 성공한 Item 중 `billed_products`에 `transactions`가 있는 수 |
| `missingItemCount`            | Plaid가 `ITEM_NOT_FOUND`를 반환한 수                        |
| `checkFailedItemCount`        | 그 외 인증·네트워크·Plaid 오류로 확인하지 못한 수           |

`transactionsBilledItemCount`는 `checkFailedItemCount`가 0일 때만 현재 추적 Item 전체에 대한 확정치다. 실패가 있으면 확인 가능한 최소치로 표시한다. Sandbox에서도 `billed_products` 값은 보이지만 실제 청구 판단에는 `environment === "production"`인 결과만 사용한다.

행 표시 시 함께 드러낼 상태:

- `localStatus === "disconnected"`인데 `plaidStatus === "reachable"`이면 로컬 삭제와 Plaid 연결 상태가 어긋난 후보이다.
- `plaidStatus === "reachable"`이어도 `plaidErrorCode`가 있으면 Item-level 오류가 있는 상태이다.
- `localStatus === "active"`인데 `plaidStatus === "missing"`이면 로컬 정리 대상 후보이다.
- `billingGraceEndsAt`은 삭제·해제 후 과금 유예 상태를 판단할 때 표시한다.
- `user === null`은 연결 사용자가 삭제되었거나 연결 정보가 없는 legacy Item일 수 있다.

Plaid에는 계정 전체 Item을 나열하는 범용 API가 없다. 따라서 이 endpoint는 Fina DB에 access token이 남은 Item만 확인한다. Plaid Usage 숫자와 차이가 있으면 Plaid Dashboard의 Item Debugger 또는 Support에서 별도로 확인해야 한다.

## 4. 공통 규칙

### 날짜와 금액

- 모든 timestamp는 ISO 8601 UTC 문자열이다.
- 모든 금액은 부동소수점 오차를 피하기 위해 JSON number가 아닌 decimal string이다.
- transaction amount는 Fina/Plaid 규칙을 따른다. 양수는 지출, 음수는 수입이다.
- 표시 통화는 각 transaction의 `currency`를 사용한다.

### Cursor pagination

- cursor는 opaque string이다. decode하거나 직접 만들지 않는다.
- 첫 요청에서는 `cursor`를 생략한다.
- 응답의 `nextCursor`가 `null`이면 마지막 페이지다.
- 다음 요청에는 받은 값을 그대로 query에 넣는다. `URLSearchParams` 사용을 권장한다.
- `limit` 기본값은 50, 최댓값은 100이다.

### 데이터 범위

- Transaction은 해당 사용자가 member로 속한 모든 workspace의 읽을 수 있는 거래다.
- 따라서 shared workspace의 transaction도 포함될 수 있으며, “사용자가 직접 생성한 거래”만을 의미하지 않는다.
- soft-removed transaction과 billing grace로 숨겨진 transaction은 제외된다.
- Chat thread는 `userId`가 정확히 해당 사용자인 thread만 반환한다.
- Message 조회 시 URL의 `userId`와 `threadId` 소유자가 일치하지 않으면 `404`다.

## 5. Transaction 조회

```http
GET /internal/admin/users/:userId/transactions?limit=50&cursor=<opaque>
```

정렬은 `occurredAt DESC`, 같은 시각이면 `id DESC`다. 즉 첫 페이지가 가장 최근 거래다.

응답:

```ts
type AdminTransactionsResponse = {
  transactions: Array<{
    id: string;
    workspace: {
      id: string;
      name: string;
    };
    account: {
      id: string;
      name: string;
      mask: string | null;
    };
    amount: string;
    currency: string;
    merchantRaw: string;
    occurredAt: string;
    pending: boolean;
    source: "plaid" | "manual" | "csv";
    note: string | null;
    removedAt: string | null;
    budgetImpact: "expense" | "income" | "refund" | "excluded";
    allocations: Array<{
      amount: string;
      categoryName: string | null;
    }>;
  }>;
  nextCursor: string | null;
};
```

응답 예시:

```json
{
  "transactions": [
    {
      "id": "tx_123",
      "workspace": { "id": "ws_123", "name": "Brian's workspace" },
      "account": { "id": "acct_123", "name": "Chequing", "mask": "4242" },
      "amount": "18.25",
      "currency": "CAD",
      "merchantRaw": "Coffee Shop",
      "occurredAt": "2026-08-04T18:30:00.000Z",
      "pending": false,
      "source": "plaid",
      "note": null,
      "removedAt": null,
      "budgetImpact": "expense",
      "allocations": [{ "amount": "18.25", "categoryName": "Dining" }]
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOi..."
}
```

`rawData`, Plaid access token, Plaid transaction identifier 등 provider 비밀·원본 필드는 반환하지 않는다.

## 6. Chat thread 목록

```http
GET /internal/admin/users/:userId/chat-threads
```

thread 수는 workspace당 canonical thread 하나가 기본이라 별도 pagination을 사용하지 않는다. 최근 대화가 먼저 오며 `lastMessageAt`이 없는 thread는 뒤에 온다.

응답:

```ts
type AdminChatThreadsResponse = {
  threads: Array<{
    id: string;
    title: string | null;
    workspace: {
      id: string;
      name: string;
    } | null;
    lastMessageAt: string | null;
    archivedAt: string | null;
    createdAt: string;
    messageCount: number;
  }>;
};
```

`workspace`가 `null`이면 workspace 연결 이전에 생성된 legacy thread다.

응답 예시:

```json
{
  "threads": [
    {
      "id": "thread_123",
      "title": "August budget check-in",
      "workspace": { "id": "ws_123", "name": "Brian's workspace" },
      "lastMessageAt": "2026-08-04T19:00:00.000Z",
      "archivedAt": null,
      "createdAt": "2026-07-01T15:00:00.000Z",
      "messageCount": 24
    }
  ]
}
```

## 7. Chat message 조회

```http
GET /internal/admin/users/:userId/chat-threads/:threadId/messages?limit=50&cursor=<opaque>
```

첫 페이지는 최신 message window를 반환하지만, `messages` 배열 자체는 화면에서 바로 읽을 수 있도록 오래된 순에서 새로운 순으로 정렬된다.

응답:

```ts
type AdminChatMessagesResponse = {
  threadId: string;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "tool";
    blocks: unknown;
    createdAt: string;
  }>;
  nextCursor: string | null;
};
```

응답 예시:

```json
{
  "threadId": "thread_123",
  "messages": [
    {
      "id": "message_1",
      "role": "user",
      "blocks": [{ "type": "text", "markdown": "How much did I spend this month?" }],
      "createdAt": "2026-08-04T18:59:00.000Z"
    },
    {
      "id": "message_2",
      "role": "assistant",
      "blocks": [{ "type": "text", "markdown": "You spent $1,245.30 so far." }],
      "createdAt": "2026-08-04T19:00:00.000Z"
    }
  ],
  "nextCursor": "eyJjcmVhdGVkQXQiOi..."
}
```

`blocks`는 text 외에도 recap, transaction list, confirmation card 등 여러 presentation block을 포함할 수 있다. 관리자 UI가 모든 block renderer를 구현하지 않는다면 다음 fallback이면 충분하다.

1. `type === "text"`이고 `markdown`이 문자열이면 text/markdown으로 표시한다.
2. 그 외 block은 접을 수 있는 formatted JSON으로 표시한다.

이 API는 read-only이므로 confirmation card의 action을 관리자 UI에서 실행하면 안 된다.

### 이전 message 불러오기

message pagination은 transaction과 합치는 방향이 다르다.

```ts
const olderPage = await getMessages({ userId, threadId, cursor: current.nextCursor });

setMessages((current) => [...olderPage.messages, ...current]);
```

## 8. TypeScript 호출 예제

이 코드는 외부 관리자 backend에서 실행해야 한다.

```ts
const FINA_API_BASE_URL = process.env.FINA_API_BASE_URL!;

class FinaAdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function finaAdminGet<T>(path: string, delegatedToken: string): Promise<T> {
  const response = await fetch(`${FINA_API_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${delegatedToken}`,
      "X-Request-Id": crypto.randomUUID(),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new FinaAdminApiError(response.status, body.error ?? "unknown_error");
  }

  return response.json() as Promise<T>;
}

async function getPlaidItems(token: string) {
  return finaAdminGet<AdminPlaidItemsResponse>("/internal/admin/plaid-items", token);
}

async function getTransactions(userId: string, token: string, cursor?: string) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);

  return finaAdminGet<AdminTransactionsResponse>(
    `/internal/admin/users/${encodeURIComponent(userId)}/transactions?${query}`,
    token,
  );
}

async function getChatThreads(userId: string, token: string) {
  return finaAdminGet<AdminChatThreadsResponse>(
    `/internal/admin/users/${encodeURIComponent(userId)}/chat-threads`,
    token,
  );
}

async function getChatMessages(userId: string, threadId: string, token: string, cursor?: string) {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);

  return finaAdminGet<AdminChatMessagesResponse>(
    `/internal/admin/users/${encodeURIComponent(userId)}` +
      `/chat-threads/${encodeURIComponent(threadId)}/messages?${query}`,
    token,
  );
}
```

같은 monorepo 안에서 타입을 소비하는 경우 `@fina/shared`에서 다음 타입을 import할 수 있다.

```ts
import type {
  AdminChatMessagesResponse,
  AdminChatThreadsResponse,
  AdminPlaidItemsResponse,
  AdminTransactionsResponse,
} from "@fina/shared";
```

외부 관리자 repo에서는 이 문서의 타입을 복사하거나 OpenAPI/client package가 추가될 때까지 별도 contract module로 관리한다.

## 9. 오류 처리

오류 응답 body:

```json
{ "error": "unauthenticated" }
```

| HTTP  | `error`           | 의미                                              | client 처리                                  |
| ----- | ----------------- | ------------------------------------------------- | -------------------------------------------- |
| `400` | `invalid_query`   | cursor 또는 query가 잘못됨                        | cursor를 버리고 첫 페이지부터 재요청         |
| `401` | `unauthenticated` | token 누락, 만료, 서명·issuer·audience·claim 오류 | 새 delegated token을 한 번 발급해 재시도     |
| `403` | `admin_required`  | token의 `email` 또는 `scope`가 허용값과 다름      | 재시도하지 말고 설정 확인                    |
| `404` | `not_found`       | user가 없거나 thread가 해당 user 소유가 아님      | 선택 상태를 초기화하고 목록 갱신             |
| `500` | 서버 오류         | 예상하지 못한 오류                                | request ID와 함께 오류 기록 후 제한적 재시도 |

`401` 재시도는 새 token으로 최대 한 번만 수행한다. `403`과 `404`는 자동 재시도하지 않는다.

## 10. Client 구현 체크리스트

- [ ] 호출이 브라우저가 아닌 외부 관리자 backend에서 수행된다.
- [ ] 기존 사용자 목록과 같은 delegated JWT 발급 로직을 사용한다.
- [ ] Plaid 화면에서 `summary`, `environment`, 각 Item 상태를 함께 표시한다.
- [ ] `checkFailedItemCount > 0`이면 billed 수가 최소치임을 표시한다.
- [ ] Plaid access token은 client 타입·로그·화면에 추가하지 않는다.
- [ ] Plaid Item을 자동 삭제하거나 짧은 주기로 polling하지 않는다.
- [ ] `userId`, `threadId`, cursor는 URL-safe하게 encode한다.
- [ ] money를 parse해서 다시 계산하지 않고 표시 시 decimal string을 사용한다.
- [ ] transaction 다음 페이지는 목록 뒤에 붙인다.
- [ ] 이전 message 페이지는 기존 목록 앞에 붙인다.
- [ ] `nextCursor === null`이면 load-more UI를 숨긴다.
- [ ] unknown chat block은 formatted JSON fallback으로 표시한다.
- [ ] confirmation/action block은 실행하지 않는다.
- [ ] 응답을 shared/public cache에 저장하지 않는다.
- [ ] 오류 로그에 bearer token, message block, transaction 내용을 남기지 않는다.
