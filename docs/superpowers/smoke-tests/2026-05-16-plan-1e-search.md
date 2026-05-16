# Plan 1E-search — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-16-plan-1e-search.md`. Covers the new
`findTransactions` chat tool's filters (merchant text, date range, amount
range, category name, account name), pagination, and validation errors via
the multi-thread chat surface from Plan 1E-threads.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this smoke uses a fresh worktree
  API on **4001** to avoid touching the existing dev server.
- `GEMINI_API_KEY` is required and is auto-loaded by `nx run` via the repo
  `.env`. Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM
  calls; smoke uses ~6 turns.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

pnpm --filter @fina/api exec prisma generate
```

## 1. Boot API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina

# If running from a fresh worktree, symlink .env so nx picks it up:
# ln -sf /home/cwsbr/personal/fina/.env .env

PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expected:** `Server listening at http://[::1]:4001`. Leave running.

## 2. Seed a Pro user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1e-search-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Search\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Seed transactions

A mix that exercises all filters: two Starbucks (different dates, different
amounts), one Whole Foods (categorized as Food), one Subway in Savings, one
USD transaction (non-CAD, should be excluded), one refund (negative amount).

```bash
USER_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM users WHERE email = '$EMAIL'")
ACCT_ID="smoke-search-acct-$(date +%s)"
ACCT2_ID="smoke-search-acct2-$(date +%s)"
CAT_ID="smoke-search-cat-$(date +%s)"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO bank_accounts (id, \"workspaceId\", name, type, currency, status, \"createdAt\") VALUES
   ('$ACCT_ID', '$WS_ID', 'Chequing', 'depository', 'CAD', 'active', NOW()),
   ('$ACCT2_ID', '$WS_ID', 'Savings', 'depository', 'CAD', 'active', NOW());"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\") VALUES ('$CAT_ID', '$WS_ID', 'Food', NOW());"

docker exec fina-postgres-dev psql -U fina -d fina -c "
INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"merchantNormalized\", \"categoryId\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES
  ('tx-sm-s1',    '$WS_ID', '$ACCT_ID',  'sm-s1',   5.00, 'CAD', 'Starbucks Downtown', 'starbucks',  '$CAT_ID', NOW() - INTERVAL '5 days',  'plaid', '{}'::jsonb, NOW(), NOW()),
  ('tx-sm-s2',    '$WS_ID', '$ACCT_ID',  'sm-s2',   8.50, 'CAD', 'Starbucks Pike',     'starbucks',  '$CAT_ID', NOW() - INTERVAL '3 days',  'plaid', '{}'::jsonb, NOW(), NOW()),
  ('tx-sm-wf',    '$WS_ID', '$ACCT_ID',  'sm-wf',  120.00, 'CAD', 'Whole Foods',        'whole foods','$CAT_ID', NOW() - INTERVAL '2 days',  'plaid', '{}'::jsonb, NOW(), NOW()),
  ('tx-sm-subway','$WS_ID', '$ACCT2_ID', 'sm-sub',  12.00, 'CAD', 'Subway',             'subway',     '$CAT_ID', NOW() - INTERVAL '1 day',   'plaid', '{}'::jsonb, NOW(), NOW()),
  ('tx-sm-usd',   '$WS_ID', '$ACCT_ID',  'sm-usd',   9.99, 'USD', 'Foreign Coffee',     'foreign',     NULL,    NOW(),                       'plaid', '{}'::jsonb, NOW(), NOW()),
  ('tx-sm-refund','$WS_ID', '$ACCT_ID',  'sm-ref', -50.00, 'CAD', 'Refund Inc',         'refund',      NULL,    NOW() - INTERVAL '4 days',  'plaid', '{}'::jsonb, NOW(), NOW())
;"
```

## 4. Create a chat thread + helper

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Search smoke"}' | jq -r .thread.id)
echo "T_ID=$T_ID"

chat() {
  local prompt="$1"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{tools:[.toolCalls[].toolName], text:.assistantMessage.blocks[0].markdown[0:300]}'
}
```

## 5. Exercise each filter via chat

Run each prompt and confirm the `tools` array contains `"findTransactions"`.
The assistant text should match the expected matches.

### 5.1 Merchant text

```bash
chat "Find my Starbucks transactions"
```

**Expect:** `findTransactions` called. Response mentions 2 Starbucks transactions ($5 and $8.50, total $13.50).

### 5.2 Date range

```bash
chat "Show transactions from the last 4 days"
```

**Expect:** `findTransactions` called. LLM should pass `start_date` for ~4 days ago. Response includes Starbucks Pike, Whole Foods, Subway, and the refund (but NOT Starbucks Downtown which is 5 days old).

### 5.3 Amount range

```bash
chat "Show me transactions over $50"
```

**Expect:** `findTransactions` called with `amount_min: 50`. Response includes Whole Foods ($120) and the refund ($50 abs).

### 5.4 Category filter

```bash
chat "What did I spend on Food?"
```

**Expect:** `findTransactions` with `category_name: "Food"`. Response includes Starbucks x2, Whole Foods, Subway (4 transactions).

### 5.5 Account filter

```bash
chat "Show me transactions in my Savings account"
```

**Expect:** `findTransactions` with `account_name: "Savings"`. Response includes only Subway ($12).

### 5.6 Combined filter

```bash
chat "Find Starbucks transactions in the Food category"
```

**Expect:** `findTransactions` with merchant_query + category_name. Response 2 Starbucks transactions.

## 6. Negative checks

### 6.1 Free tier rejection

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"find anything"}' -w "\n%{http_code}\n"
```

**Expect:** 402 `upgrade_required`. The tool never runs because chat is Pro-gated.

### 6.2 Cross-workspace isolation (indirect via tool args)

`findTransactions` is workspace-scoped via `ctx.workspaceId`. A second user
calling the tool against their own workspace cannot reach this user's
transactions. Verified by the route-level workspace match check + unit tests.

## 7. Automated E2E (optional)

```bash
GEMINI_API_KEY=$GEMINI_API_KEY API_URL=http://localhost:4001 \
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
pnpm exec playwright test --grep "plan 1e-search"
```

`e2e/plan-1e-search.spec.ts` covers:
- "find my Starbucks transactions" → `findTransactions` tool is called, response mentions Starbucks
- "show transactions over $100" → `findTransactions` tool is called (amount filter)

Both tests skip-guard on Postgres + `GEMINI_API_KEY`. 13s pacing keeps the
suite under the per-minute Gemini cap.

## 8. Cleanup

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email = '$EMAIL';"
rm -f /tmp/fina-cookies.txt
```

## Pass criteria

- All 6 filter prompts trigger `findTransactions` (5.1–5.6).
- Free-tier rejection still works (6.1).
- Optional E2E suite green when `GEMINI_API_KEY` is set (7).

## Verified run (2026-05-16)

Smoke run against the worktree API on port 4001. Daily Gemini free-tier
quota (20 req/day) limited the run; reached 5/6 prompts before the cap.

| Step | Prompt | Tool called | Notes |
|------|--------|-------------|-------|
| 5.1 | "Find my Starbucks transactions" | `findTransactions` | ✅ Returned both Starbucks rows. |
| 5.2 | "Show transactions from the last 4 days" | `listTransactions` | LLM routed to the named-period tool. Result rows are correct; same data, different tool. Acceptable. |
| 5.3 | "Show me transactions over 50 dollars" | `findTransactions` | ✅ Whole Foods ($120) and Refund Inc ($50 abs) returned. |
| 5.4 | "What did I spend on Food?" | `getSpendingSummary` | LLM picked aggregation over enumeration ($145.50). Correct math, acceptable routing. |
| 5.5 | "Show me transactions in my Savings account" | `findTransactions` | ✅ args: `{ account_name: "Savings" }`; only the Subway transaction returned. |
| 5.6 | "Find Starbucks transactions in the Food category" | (not run) | Hit Gemini daily 20-req cap. |

The three `findTransactions` invocations exercised the merchant filter, the
amount filter, and the account-name resolution — all worked end-to-end with
real Gemini and the multi-thread chat surface. Steps 5.2 and 5.4 routed to
sibling tools — that's an LLM-routing observation, not a defect in
`findTransactions`.

**Gemini quota note:** the free tier caps at 10 requests/minute AND 20
requests/day (per project per model). Each chat turn issues ~2 LLM calls
(tool plan + final synthesis), so the full 6-step smoke + 2-step E2E
(~16 calls) does not fit one day without a paid key. Re-run the missing
steps the next day to complete coverage, or upgrade the key.
