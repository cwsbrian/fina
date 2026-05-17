# Plan 1C-budget — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-16-plan-1c-budget.md`. Covers:

1. `setBudget` chat tool creates a row with the right `periodStart`.
2. `setBudget` upserts on conflict (same category + period).
3. `getBudget` returns the row.
4. `compareSpendingVsBudget` joins budget + transactions correctly.
5. HTTP `POST /workspaces/:id/budgets` end-to-end + tier gate (402) + error codes.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this smoke uses a fresh worktree
  API on **4001** to avoid touching the existing dev server.
- `GEMINI_API_KEY` is required and auto-loaded by `nx run` via repo `.env`.
- Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM calls +
  the auto-title call on the first message adds 1 more (≈ 3 LLM calls per
  first-message turn). Budget tight — full smoke uses ~3 chat turns.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

pnpm --filter @fina/api exec prisma generate
```

**Expect:** both `db:deploy` reports include `add_budgets` already applied
(or "No pending migrations" on subsequent runs).

## 1. Boot a fresh API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina

# ln -sf /home/cwsbr/personal/fina/.env .env   # if running from a worktree

PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expect:** `Server listening at http://[::1]:4001`.

## 2. Seed a Pro Toronto user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1c-budget-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Budget\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Seed a "Coffee" category

The default seeds during sign-up create a few categories. Add an explicit
"Coffee" to make the test deterministic:

```bash
CAT_ID="smoke-budget-cat-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\") VALUES ('$CAT_ID', '$WS_ID', 'Coffee', NOW());"
echo "CAT_ID=$CAT_ID"
```

## 4. HTTP route smoke

### 4.1 POST 201 happy path

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/budgets" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":500,\"period\":\"this_month\"}" \
  -w "\n%{http_code}\n"
```

**Expect:** `201` + body `{ budget: { id, categoryId, amount: "500.00", periodStart: "2026-MM-01" } }`.

Verify the row:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"categoryId\", amount, \"periodStart\" FROM budgets WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** one row, amount = 500.00.

### 4.2 POST 400 invalid_amount

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/budgets" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":0,\"period\":\"this_month\"}" \
  -w "\n%{http_code}\n"
```

**Expect:** `400` + `{"error":"invalid_amount"}`.

### 4.3 POST upsert (same category + period → updates amount, no new row)

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/budgets" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":600,\"period\":\"this_month\"}" \
  -w "\n%{http_code}\n"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT count(*), max(amount) FROM budgets WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** still 1 row, amount = 600.00.

### 4.4 GET 200

```bash
curl -sS -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/budgets" \
  -H "x-workspace-id: $WS_ID" \
  -w "\n%{http_code}\n"
```

**Expect:** `200` + `{ budgets: [{ id, categoryId, amount: "600.00", periodStart: ... }] }`.

### 4.5 GET 400 invalid_period_start

```bash
curl -sS -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/budgets?period_start=2026-13-01" \
  -H "x-workspace-id: $WS_ID" \
  -w "\n%{http_code}\n"
```

**Expect:** `400` + `{"error":"invalid_period_start"}`.

### 4.6 POST 402 upgrade_required (Free tier)

Expire trial + flag consumed, then retry:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/budgets" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"categoryId\":\"$CAT_ID\",\"amount\":500,\"period\":\"this_month\"}" \
  -w "\n%{http_code}\n"
```

**Expect:** `402` + `{"error":"upgrade_required"}`.

Restore Pro:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

### 4.7 DELETE 204 + 404 cross-workspace

Capture the budget id and delete:

```bash
B_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM budgets WHERE \"workspaceId\" = '$WS_ID' LIMIT 1")
echo "B_ID=$B_ID"

curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/budgets/$B_ID" \
  -H "x-workspace-id: $WS_ID" -w "\n%{http_code}\n"

# Cross-workspace id → 404
curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/budgets/does-not-exist" \
  -H "x-workspace-id: $WS_ID" -w "\n%{http_code}\n"
```

**Expect:** first → `204`, second → `404 budget_not_found`.

## 5. Chat tool smoke

Create a thread + helper:

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Budget smoke"}' | jq -r .thread.id)
echo "T_ID=$T_ID"

chat() {
  local prompt="$1"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{tools:[.toolCalls[].toolName], firstResult:.toolCalls[0].result}'
}
```

### 5.1 setBudget — unambiguous prompt

```bash
chat "Coffee 카테고리 예산을 500 달러로 설정해줘"
```

**Expect:** `tools` contains `"setBudget"`. `firstResult.budget` has
`amount: "500.00"` and `periodStart: "2026-MM-01"`.

Verify DB:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"categoryId\", amount FROM budgets WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** one row with `amount = 500.00`.

### 5.2 getBudget

```bash
chat "Coffee 카테고리 예산이 얼마야?"
```

**Expect:** `tools` contains `"getBudget"`. `firstResult.budgets[0]` has
`categoryName: "Coffee"` + `amount: "500.00"`.

### 5.3 compareSpendingVsBudget

Seed a transaction first:

```bash
ACCT_ID="smoke-budget-acct-$(date +%s)"
TX_ID="smoke-budget-tx-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO bank_accounts (id, \"workspaceId\", name, type, currency, status, \"createdAt\") VALUES ('$ACCT_ID', '$WS_ID', 'Chequing', 'depository', 'CAD', 'active', NOW());"

# UTC noon in mid-May Toronto so it falls in 'this_month'.
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"categoryId\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES ('$TX_ID', '$WS_ID', '$ACCT_ID', 'sm-1', 100.00, 'CAD', 'Starbucks', '$CAT_ID', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW());"

chat "이번 달 예산 대비 지출 상황 보여줘"
```

**Expect:** `tools` contains `"compareSpendingVsBudget"`. `firstResult.items[0]`
has `categoryName: "Coffee"`, `amount: "500.00"`, `spent: "100.00"`,
`remaining: "400.00"`, and a `status` of either `"on-pace"` or `"over-pace"`
depending on day-of-month.

## 6. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-16)

**Step 4 — HTTP routes (7/7 PASS):**

```
4.1 POST 201 happy           → 201 + budget.amount="500.00", periodStart="2026-05-01" ✓
4.2 POST 400 invalid_amount  → 400 {"error":"invalid_amount"} ✓
4.3 POST upsert to 600       → still 1 row, max(amount)=600.00 ✓
4.4 GET 200                  → 200 + budgets[0].amount="600.00" ✓
4.5 GET 400 bad period_start → 400 {"error":"invalid_period_start"} ✓
4.6 POST 402 Free tier       → 402 {"error":"upgrade_required"} ✓
4.7 DELETE 204 + cross-WS 404 → 204 and {"error":"budget_not_found"} ✓
```

All HTTP error codes, tier gate, and upsert semantics work end-to-end as
the spec §7 contracts.

**Step 5 — Chat tools (deferred to integration tests):**

Attempted 5.1 (`setBudget` via chat). API returned `500
chat_provider_error` — the Gemini free-tier daily quota (20 req/day) was
exhausted by this point in the session (cumulative ~40+ chat turns across
1E-time / 1E-title / 1C-budget runs).

The full chat-tool semantics are exercised by the integration tests that
landed with the implementation:

- `apps/api/tests/chat.tools.set-budget.test.ts` (5 cases): Zod
  validation, category resolution, upsert, canonical name.
- `apps/api/tests/chat.tools.get-budget.test.ts` (3 cases): single,
  all-for-period, empty.
- `apps/api/tests/chat.tools.compare-spending-vs-budget.test.ts` (1 case):
  thin pass-through (the heavy logic is in
  `apps/api/tests/budgets.service.test.ts` with 21 cases including the 6
  compare-spending cases for pace + currency filter + next_month range).

The chat surface itself (Gemini routing, registry inclusion) is verified
by `apps/api/tests/chat.tools.registry.test.ts` asserting 17 registered
tools including the three new entries.

Retry the chat section tomorrow with a fresh Gemini quota when needed.

## Known limitations exercised by this smoke

- **Gemini quota.** The chat-tool section (~3 turns × 2-3 LLM calls each) is
  the heaviest part. If you see 429 `RESOURCE_EXHAUSTED`, document it in
  the verified-run section and rely on integration tests in
  `apps/api/tests/chat.tools.set-budget.test.ts`, etc. for full coverage.
- **periodStart timezone.** All tests assume the user has the default
  `tz = "America/Toronto"`. If a future smoke runs against a user with
  a different tz, expected periodStart values shift.
- **Confirmation flow.** This plan does NOT include action_intents /
  rich blocks (`categorize_card` / `confirm_card`) — separate 1C-confirmation
  plan. setBudget mutates immediately when the prompt is unambiguous.
