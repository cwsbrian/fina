# Plan 1C-merchant-map — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-17-plan-1c-merchant-map.md`. Covers:

1. `mapMerchantToCategory` chat tool creates a `MerchantMapping` row with
   `source='manual'`, `confidence=1.00`.
2. Two-stage backfill works end-to-end: a Plaid-shaped transaction with
   `merchantNormalized = NULL` + raw `"STARBUCKS #1234 TORONTO ON"` is
   normalized and assigned.
3. Already-categorized siblings are NOT touched.
4. Whitespace-only merchant input → `invalid_merchant`.
5. Archived / cross-workspace category → `category_not_found`.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this smoke uses a fresh worktree
  API on **4001** to avoid touching the existing dev server.
- `GEMINI_API_KEY` is required and auto-loaded by `nx run` via repo `.env`.
- Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM calls +
  auto-title call on the first message (≈ 3 LLM calls per first-message
  turn). Plan to budget ≈ 3 chat turns for this smoke.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

pnpm --filter @fina/api exec prisma generate
```

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
EMAIL="smoke-1c-mmap-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke MMap\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Seed category + transactions

```bash
CAT_COFFEE="smoke-mmap-coffee-$(date +%s)"
CAT_FOOD="smoke-mmap-food-$(date +%s)"
ACCT_ID="smoke-mmap-acct-$(date +%s)"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\") VALUES
   ('$CAT_COFFEE', '$WS_ID', 'Coffee', NOW()),
   ('$CAT_FOOD',   '$WS_ID', 'Food',   NOW());"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO bank_accounts (id, \"workspaceId\", name, type, currency, status, \"createdAt\") VALUES ('$ACCT_ID', '$WS_ID', 'Chequing', 'depository', 'CAD', 'active', NOW());"

# Tx A: NULL merchantNormalized + null category — should be normalized AND assigned.
TX_A="smoke-mmap-tx-a-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"merchantNormalized\", \"categoryId\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES ('$TX_A', '$WS_ID', '$ACCT_ID', 'sm-a', 5.50, 'CAD', 'STARBUCKS #1234 TORONTO ON', NULL, NULL, NOW(), 'plaid', '{}'::jsonb, NOW(), NOW());"

# Tx B: already 'starbucks' normalized + null category — should be assigned only.
TX_B="smoke-mmap-tx-b-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"merchantNormalized\", \"categoryId\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES ('$TX_B', '$WS_ID', '$ACCT_ID', 'sm-b', 3.25, 'CAD', 'Starbucks Vancouver', 'starbucks', NULL, NOW(), 'plaid', '{}'::jsonb, NOW(), NOW());"

# Tx C: already categorized as Food (manual) — must NOT be touched.
TX_C="smoke-mmap-tx-c-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"merchantNormalized\", \"categoryId\", \"categorizationSource\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES ('$TX_C', '$WS_ID', '$ACCT_ID', 'sm-c', 6.75, 'CAD', 'Starbucks Calgary', 'starbucks', '$CAT_FOOD', 'manual', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW());"

echo "TX_A=$TX_A  TX_B=$TX_B  TX_C=$TX_C"
```

## 4. Chat thread + helper

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Merchant map smoke"}' | jq -r .thread.id)
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

## 5. Happy path — mapMerchantToCategory + two-stage backfill

```bash
chat "Starbucks를 Coffee 카테고리로 자동분류해줘"
```

**Expect:** `tools` contains `"mapMerchantToCategory"`. `firstResult.mapping`
has `merchantNormalized: "starbucks"`, `categoryId: <coffee>`,
`categoryName: "Coffee"`. `firstResult.backfilledCount` is `2` (tx A + tx B).

Verify mapping row:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"merchantNormalized\", \"categoryId\", source, confidence FROM merchant_mappings WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** one row, `merchantNormalized = starbucks`, `categoryId = $CAT_COFFEE`,
`source = manual`, `confidence = 1.00`.

Verify backfill:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, \"merchantNormalized\", \"categoryId\", \"categorizationSource\" FROM transactions WHERE \"workspaceId\" = '$WS_ID' ORDER BY id;"
```

**Expect:**
- TX_A: `merchantNormalized = starbucks`, `categoryId = $CAT_COFFEE`, `categorizationSource = mapping`
- TX_B: `merchantNormalized = starbucks`, `categoryId = $CAT_COFFEE`, `categorizationSource = mapping`
- TX_C: `merchantNormalized = starbucks`, `categoryId = $CAT_FOOD`, `categorizationSource = manual` (unchanged)

## 6. Upsert — rebind to a different category

```bash
chat "Starbucks 매핑을 Food 카테고리로 바꿔줘"
```

**Expect:** `tools` contains `"mapMerchantToCategory"`. `firstResult.backfilledCount`
is `0` (no remaining null-category siblings for Starbucks).

Verify mapping changed:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT \"categoryId\" FROM merchant_mappings WHERE \"workspaceId\" = '$WS_ID' AND \"merchantNormalized\" = 'starbucks';"
```

**Expect:** `$CAT_FOOD`.

Already-assigned siblings (TX_A, TX_B) stay on Coffee — the rebind only
upserts the mapping, it doesn't override existing categorizations.

## 7. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-17)

Steps 5 and 6 executed end-to-end against the worktree API on port 4001.
Both passed cleanly.

**Step 5 (happy path — map Starbucks → Coffee):**

```
tool fired: mapMerchantToCategory
result: {
  mapping: { merchantNormalized: "starbucks", categoryId: COFFEE, categoryName: "Coffee" },
  backfilledCount: 2
}

merchant_mappings:
  starbucks | COFFEE | source=manual | confidence=1.00

transactions:
  TX_A | merchantNormalized=starbucks | COFFEE | categorizationSource=mapping  ← normalized + assigned
  TX_B | merchantNormalized=starbucks | COFFEE | categorizationSource=mapping  ← assigned
  TX_C | merchantNormalized=starbucks | FOOD   | categorizationSource=manual   ← unchanged
```

The two-stage backfill behaved exactly per spec §4: TX_A (which had
`merchantNormalized = NULL` and `merchantRaw = "STARBUCKS #1234 TORONTO ON"`)
got its `merchantNormalized` populated first, then assigned to Coffee
via `mapping`. TX_C was preserved.

**Step 6 (rebind — Starbucks → Food):**

```
tool fired: mapMerchantToCategory
result: { mapping.categoryId: FOOD, backfilledCount: 0 }

merchant_mappings:
  starbucks | FOOD | source=manual | confidence=1.00   ← upserted

transactions:
  TX_A,TX_B | COFFEE   ← unchanged (already assigned, not overridden by rebind)
  TX_C      | FOOD     ← unchanged
```

Rebind upserts the mapping but does NOT reclassify existing transactions
— by design per spec §3 "Override already-categorized — out of scope".

## Known limitations exercised by this smoke

- **Gemini quota.** Two chat turns × ≈3 LLM calls each ≈ 6 LLM calls for
  this smoke. If you see `429 RESOURCE_EXHAUSTED`, the chat layer is
  covered by integration tests
  (`apps/api/tests/chat.tools.map-merchant-to-category.test.ts` 5 cases
  + `apps/api/tests/categorize.map-merchant.test.ts` 9 cases). Retry
  tomorrow.
- **Punctuation-only merchant input.** Per spec §5, `normalizeMerchant("###")`
  passes through unchanged → creates a real mapping. Only whitespace-only
  inputs trip `invalid_merchant`. This is intentional for v1.
- **Rebind does not reclassify existing siblings.** Once a transaction is
  assigned (via mapping or manual), a future rebind for the same merchant
  doesn't touch it. By design — preserves the user's earlier choices.
